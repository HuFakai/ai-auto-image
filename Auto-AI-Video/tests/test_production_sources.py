from pathlib import Path

import pytest

from pixelle_video.production.models import ChannelConfig, InventoryConfig, TopicConfig
from pixelle_video.production.sources import (
    CollectedItem,
    FetchResult,
    ingest_content_source,
    parse_feed,
    parse_web_page,
    validate_public_url,
)
from pixelle_video.production.store import ProductionStore
from pixelle_video.production.topics import TopicSuggestion, TopicSuggestionBatch


def _channel() -> ChannelConfig:
    return ChannelConfig(
        id="science",
        name="Science",
        topic=TopicConfig(strategy="llm", seeds=["备用科学选题"]),
        inventory=InventoryConfig(
            ready_target=1,
            daily_target=1,
            max_in_flight=1,
            refill_batch=1,
        ),
        planning={"content_policy": "science"},
        video={
            "frame_template": "1080x1920/video_default.html",
            "media_workflow": "api/grok/grok-imagine-video",
        },
    )


def test_rss_atom_and_web_page_parsers():
    rss = """<?xml version="1.0"?>
    <rss version="2.0"><channel><item><guid>story-1</guid>
    <title>雨后气味从哪里来</title><link>https://example.com/rain</link>
    <description><![CDATA[<p>雨滴会把土壤中的气溶胶带入空气。</p>]]></description>
    <pubDate>Wed, 12 Aug 2026 08:00:00 GMT</pubDate></item></channel></rss>"""
    items = parse_feed(rss, "https://example.com/feed.xml")
    assert items[0].external_id == "story-1"
    assert "气溶胶" in items[0].content

    atom = """<feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <id>tag:example.com,2026:2</id><title>月球为什么总是一面朝向地球</title>
    <link href="/moon"/><summary>潮汐锁定并不等于月球不自转。</summary>
    </entry></feed>"""
    atom_items = parse_feed(atom, "https://example.com/feed")
    assert atom_items[0].url == "https://example.com/moon"

    page = parse_web_page(
        "<html><head><title>微波炉原理</title></head><body>"
        "<script>ignore()</script><h1>为什么盘子也会热</h1><p>材料损耗不同。</p>"
        "</body></html>",
        "https://example.com/story",
    )
    assert page.title == "微波炉原理"
    assert "材料损耗" in page.content
    assert "ignore" not in page.content


@pytest.mark.asyncio
async def test_private_source_url_is_rejected():
    with pytest.raises(ValueError, match="private or non-public"):
        await validate_public_url("http://127.0.0.1/internal")


@pytest.mark.asyncio
async def test_ingestion_deduplicates_items_and_creates_candidates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    store = ProductionStore(str(tmp_path / "production.db"))
    source = store.create_content_source(
        "science", "Science Feed", "rss", "https://example.com/feed.xml"
    )

    async def fake_collect(_source, transport=None):
        del transport
        return [
            CollectedItem(
                external_id="story-1",
                title="雨后气味从哪里来",
                url="https://example.com/rain",
                content="雨滴冲击多孔土壤后，会把含土臭素的微小气溶胶带入空气。",
            )
        ], FetchResult(200, _source["url"], b"", "application/rss+xml", '"v1"', None)

    async def fake_llm(**kwargs):
        assert kwargs["response_type"] is TopicSuggestionBatch
        return TopicSuggestionBatch(
            items=[
                TopicSuggestion(
                    title="雨后泥土味是怎么进入空气的？",
                    topic="用一个雨滴撞击多孔土壤的过程，解释土臭素气溶胶如何形成，并说明气味偏好因人而异。",
                    cover_copy="雨后泥土味的来源",
                    platform_description="从雨滴到鼻腔，拆解熟悉气味的物理过程。",
                    tags=["科普", "气味"],
                )
            ]
        )

    monkeypatch.setattr("pixelle_video.production.sources.collect_source", fake_collect)
    try:
        store.queue_content_source(source["id"], "task-1", force=True)
        first = await ingest_content_source(
            source["id"], "task-1", store, _channel(), fake_llm
        )
        assert first["new_items"] == 1
        assert first["candidate_count"] == 1
        candidate = store.get_topic_candidate(first["candidate_ids"][0])
        assert candidate["source_type"] == "rss"
        assert candidate["source_label"] == "Science Feed"
        assert store.get_content_source(source["id"])["last_result"]["new_items"] == 1

        store.queue_content_source(source["id"], "task-2", force=True)
        second = await ingest_content_source(
            source["id"], "task-2", store, _channel(), fake_llm
        )
        assert second["new_items"] == 0
        assert second["duplicate_items"] == 1
        assert second["candidate_count"] == 0
        assert store.get_content_source(source["id"])["item_count"] == 1
    finally:
        store.close()
