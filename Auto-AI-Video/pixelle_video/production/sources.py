"""Safe URL/RSS collection and conversion into durable topic candidates."""

from __future__ import annotations

import asyncio
import hashlib
import html
import ipaddress
import re
import socket
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any, Awaitable, Callable
from urllib.parse import urljoin, urlsplit
from xml.etree import ElementTree

import httpx

from .models import ChannelConfig
from .presets import resolve_channel_policies
from .store import ProductionStore
from .topics import prepare_title_variants, propose_topics, score_topic

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_ITEM_TEXT = 12_000
MAX_REDIRECTS = 5


@dataclass(frozen=True)
class CollectedItem:
    external_id: str | None
    title: str
    url: str | None
    content: str
    published_at: str | None = None


@dataclass(frozen=True)
class FetchResult:
    status_code: int
    url: str
    body: bytes
    content_type: str
    etag: str | None
    last_modified: str | None


async def collect_source(
    source: dict[str, Any],
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[list[CollectedItem], FetchResult]:
    """Fetch one source with SSRF protection and parse its configured format."""
    headers = {
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9",
        "User-Agent": "Pixelle-Video-SourceCollector/1.0",
    }
    if source.get("etag"):
        headers["If-None-Match"] = source["etag"]
    if source.get("last_modified"):
        headers["If-Modified-Since"] = source["last_modified"]
    fetched = await safe_fetch(source["url"], headers=headers, transport=transport)
    if fetched.status_code == 304:
        return [], fetched
    text = _decode_body(fetched.body, fetched.content_type)
    if source["kind"] == "rss":
        return parse_feed(text, source["url"]), fetched
    return [parse_web_page(text, fetched.url)], fetched


async def ingest_content_source(
    source_id: str,
    task_id: str,
    store: ProductionStore,
    channel: ChannelConfig,
    llm: Callable[..., Awaitable[Any]],
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Collect unseen items and turn each one into scored inbox candidates."""
    source = store.mark_content_source_polling(source_id, task_id)
    try:
        items, fetched = await collect_source(source, transport=transport)
        limited = items[: int(source["items_per_poll"])]
        new_items = 0
        duplicate_items = 0
        candidate_ids: list[str] = []
        fallback_items = 0
        for collected in limited:
            fingerprint = content_fingerprint(
                f"{collected.external_id or ''}\n{collected.url or ''}\n{collected.title}\n{collected.content}"
            )
            item, created = store.insert_source_item(
                source_id,
                collected.external_id,
                collected.title,
                collected.url,
                collected.content[:MAX_ITEM_TEXT],
                fingerprint,
                collected.published_at,
            )
            if not created:
                duplicate_items += 1
                continue
            new_items += 1
            references = store.topic_references(channel.id)
            history = store.recent_topics(channel.id, channel.topic.history_window)
            _, _, topic_prompt = resolve_channel_policies(store, channel)
            source_text = _source_brief(collected)
            try:
                suggestions = await propose_topics(
                    channel,
                    llm,
                    int(source["candidates_per_item"]),
                    history,
                    source_text,
                    topic_prompt,
                )
                candidate_source_type = source["kind"]
            except Exception:
                if not channel.topic.fallback_to_seeds:
                    raise
                fallback_items += 1
                suggestions = [_fallback_suggestion(collected)]
                candidate_source_type = "source_fallback"

            item_candidate_ids: list[str] = []
            for suggestion in suggestions:
                scoring = score_topic(
                    channel,
                    suggestion["title"],
                    suggestion["topic"],
                    references,
                    suggestion.get("semantic_terms", []),
                )
                candidate = store.create_topic_candidate(
                    channel.id,
                    suggestion["title"],
                    suggestion["topic"],
                    {
                        **scoring,
                        "cover_copy": suggestion.get("cover_copy", ""),
                        "platform_description": suggestion.get("platform_description", ""),
                        "tags": suggestion.get("tags", []),
                        "source_type": candidate_source_type,
                        "source_label": source["name"],
                        "status": "discarded" if scoring.get("duplicate_of") else "new",
                        "title_variants": prepare_title_variants(
                            suggestion["title"], suggestion.get("title_variants", [])
                        ),
                    },
                )
                item_candidate_ids.append(candidate["id"])
                candidate_ids.append(candidate["id"])
                references.append(
                    {
                        "id": candidate["id"],
                        "topic": candidate["topic"],
                        "semantic_terms": candidate["semantic_terms"],
                        "semantic_vector": candidate["semantic_vector"],
                    }
                )
            store.attach_source_item_candidates(item["id"], item_candidate_ids)

        result = {
            "fetched_items": len(limited),
            "new_items": new_items,
            "duplicate_items": duplicate_items,
            "candidate_count": len(candidate_ids),
            "candidate_ids": candidate_ids,
            "fallback_items": fallback_items,
            "not_modified": fetched.status_code == 304,
        }
        store.complete_content_source_poll(
            source_id,
            task_id,
            result=result,
            etag=fetched.etag,
            last_modified=fetched.last_modified,
        )
        return result
    except Exception as exc:
        store.complete_content_source_poll(source_id, task_id, error=str(exc))
        raise


async def safe_fetch(
    url: str,
    headers: dict[str, str] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> FetchResult:
    """Fetch a public HTTP(S) URL with redirect revalidation and a hard byte cap."""
    current = url.strip()
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(20.0, connect=10.0),
        trust_env=False,
        follow_redirects=False,
        transport=transport,
    ) as client:
        for _ in range(MAX_REDIRECTS + 1):
            await validate_public_url(current)
            async with client.stream("GET", current, headers=headers) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("Source redirect did not include a location")
                    current = urljoin(str(response.url), location)
                    continue
                if response.status_code == 304:
                    return _fetch_result(response, b"")
                response.raise_for_status()
                content_type = response.headers.get("content-type", "").lower()
                if content_type and not any(
                    allowed in content_type
                    for allowed in ("text/", "xml", "html", "json", "rss", "atom")
                ):
                    raise ValueError(f"Unsupported source content type: {content_type}")
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise ValueError("Source response exceeds the 2 MB safety limit")
                    chunks.append(chunk)
                return _fetch_result(response, b"".join(chunks))
    raise ValueError(f"Source exceeded {MAX_REDIRECTS} redirects")


async def validate_public_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Source URL must use public http or https")
    if parsed.username or parsed.password:
        raise ValueError("Source URL credentials are not allowed")
    try:
        literal = ipaddress.ip_address(parsed.hostname)
        addresses = [literal]
    except ValueError:
        try:
            records = await asyncio.to_thread(
                socket.getaddrinfo,
                parsed.hostname,
                parsed.port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        except socket.gaierror as exc:
            raise ValueError(f"Source hostname could not be resolved: {parsed.hostname}") from exc
        addresses = list({ipaddress.ip_address(record[4][0]) for record in records})
    if not addresses or any(not address.is_global for address in addresses):
        raise ValueError("Source URL resolves to a private or non-public network")


def parse_feed(xml_text: str, base_url: str) -> list[CollectedItem]:
    """Parse RSS 2.x or Atom without adding a heavyweight feed dependency."""
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError as exc:
        raise ValueError("RSS/Atom source returned invalid XML") from exc
    items: list[CollectedItem] = []
    entries = root.findall(".//item")
    if entries:
        for entry in entries:
            title = _node_text(entry, "title") or "未命名条目"
            link = _node_text(entry, "link")
            guid = _node_text(entry, "guid") or link
            description = _node_text(entry, "description")
            content = _first_namespaced_text(entry, "encoded") or description or title
            items.append(
                CollectedItem(
                    external_id=guid,
                    title=_clean_text(title)[:300],
                    url=urljoin(base_url, link) if link else None,
                    content=_clean_html(content)[:MAX_ITEM_TEXT],
                    published_at=_node_text(entry, "pubDate"),
                )
            )
        return items

    for entry in root.findall(".//{*}entry"):
        title = _node_text(entry, "{*}title") or "未命名条目"
        link_node = next(
            (
                node
                for node in entry.findall("{*}link")
                if node.attrib.get("rel", "alternate") == "alternate"
            ),
            None,
        )
        link = link_node.attrib.get("href") if link_node is not None else None
        summary = _node_text(entry, "{*}summary") or _node_text(entry, "{*}content") or title
        items.append(
            CollectedItem(
                external_id=_node_text(entry, "{*}id") or link,
                title=_clean_text(title)[:300],
                url=urljoin(base_url, link) if link else None,
                content=_clean_html(summary)[:MAX_ITEM_TEXT],
                published_at=_node_text(entry, "{*}published") or _node_text(entry, "{*}updated"),
            )
        )
    if not items:
        raise ValueError("RSS/Atom source did not contain any entries")
    return items


def parse_web_page(html_text: str, url: str) -> CollectedItem:
    parser = _PageTextParser()
    parser.feed(html_text)
    title = parser.title or parser.meta_description or url
    content = "\n".join(parser.blocks) or parser.meta_description or title
    return CollectedItem(
        external_id=url,
        title=_clean_text(title)[:300],
        url=url,
        content=_clean_text(content)[:MAX_ITEM_TEXT],
    )


def content_fingerprint(value: str) -> str:
    normalized = re.sub(r"\s+", " ", value).strip().lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


class _PageTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.meta_description = ""
        self.blocks: list[str] = []
        self._capture_title = False
        self._capture_block = False
        self._ignored_depth = 0
        self._buffer: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag in {"script", "style", "noscript", "svg"}:
            self._ignored_depth += 1
        if self._ignored_depth:
            return
        if tag == "title":
            self._capture_title = True
            self._buffer = []
        elif tag in {"h1", "h2", "h3", "p", "li", "blockquote"}:
            self._capture_block = True
            self._buffer = []
        elif tag == "meta" and attributes.get("name", "").lower() == "description":
            self.meta_description = attributes.get("content") or ""

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self._ignored_depth = max(0, self._ignored_depth - 1)
            return
        if self._ignored_depth:
            return
        value = _clean_text(" ".join(self._buffer))
        if tag == "title" and self._capture_title:
            self.title = value
            self._capture_title = False
        elif tag in {"h1", "h2", "h3", "p", "li", "blockquote"} and self._capture_block:
            if value and (not self.blocks or self.blocks[-1] != value):
                self.blocks.append(value)
            self._capture_block = False
        self._buffer = []

    def handle_data(self, data: str) -> None:
        if not self._ignored_depth and (self._capture_title or self._capture_block):
            self._buffer.append(data)


def _node_text(node: ElementTree.Element, path: str) -> str | None:
    child = node.find(path)
    if child is None:
        return None
    value = "".join(child.itertext()).strip()
    return value or None


def _first_namespaced_text(node: ElementTree.Element, local_name: str) -> str | None:
    child = next((item for item in node if item.tag.rsplit("}", 1)[-1] == local_name), None)
    if child is None:
        return None
    value = "".join(child.itertext()).strip()
    return value or None


def _clean_html(value: str) -> str:
    parser = _PageTextParser()
    parser.feed(html.unescape(value))
    return _clean_text("\n".join(parser.blocks) or parser.meta_description or value)


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def _decode_body(body: bytes, content_type: str) -> str:
    charset_match = re.search(r"charset=([^;\s]+)", content_type, re.IGNORECASE)
    charset = charset_match.group(1).strip('"\'') if charset_match else "utf-8"
    try:
        return body.decode(charset)
    except (LookupError, UnicodeDecodeError):
        return body.decode("utf-8", errors="replace")


def _fetch_result(response: httpx.Response, body: bytes) -> FetchResult:
    return FetchResult(
        status_code=response.status_code,
        url=str(response.url),
        body=body,
        content_type=response.headers.get("content-type", ""),
        etag=response.headers.get("etag"),
        last_modified=response.headers.get("last-modified"),
    )


def _source_brief(item: CollectedItem) -> str:
    return f"素材标题：{item.title}\n素材地址：{item.url or '无'}\n素材正文：\n{item.content[:MAX_ITEM_TEXT]}"


def _fallback_suggestion(item: CollectedItem) -> dict[str, Any]:
    title = item.title[:200]
    return {
        "title": title,
        "topic": f"基于来源素材《{title}》提炼一个准确、可核验的短视频说明。素材摘要：{item.content[:1500]}",
        "cover_copy": title[:18],
        "platform_description": "",
        "tags": [],
    }
