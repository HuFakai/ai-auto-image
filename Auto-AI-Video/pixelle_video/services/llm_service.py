# Copyright (C) 2025 AIDC-AI
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
LLM (Large Language Model) Service - Direct OpenAI SDK implementation

Supports structured output via response_type parameter (Pydantic model).
"""

import asyncio
import json
import math
import re
import time
from typing import Optional, Type, TypeVar, Union

import httpx
from loguru import logger
from openai import AsyncOpenAI
from pydantic import BaseModel

from pixelle_video.services.model_routing import (
    ModelRouteExhaustedError,
    route_attempt_error,
)

T = TypeVar("T", bound=BaseModel)

_DEFAULT_LLM_REQUEST_TIMEOUT = 300.0
_MAX_LLM_CONNECT_TIMEOUT = 30.0


class EmptyLLMResponseError(RuntimeError):
    """Raised when a provider returns a completion without final-answer text."""


class LLMService:
    """
    LLM (Large Language Model) service

    Direct implementation using OpenAI SDK. No capability layer needed.

    Supports all OpenAI SDK compatible providers:
    - OpenAI (gpt-4o, gpt-4o-mini, gpt-3.5-turbo)
    - Alibaba Qwen (qwen-max, qwen-plus, qwen-turbo)
    - Anthropic Claude (claude-sonnet-4-5, claude-opus-4, claude-haiku-4)
    - DeepSeek (deepseek-chat)
    - Moonshot Kimi (moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k)
    - Ollama (llama3.2, qwen2.5, mistral, codellama) - FREE & LOCAL!
    - Any custom provider with OpenAI-compatible API

    Usage:
        # Direct call
        answer = await pixelle_video.llm("Explain atomic habits")

        # With parameters
        answer = await pixelle_video.llm(
            prompt="Explain atomic habits in 3 sentences",
            temperature=0.7,
            max_tokens=2000
        )
    """

    def __init__(self, config: dict):
        """
        Initialize LLM service

        Args:
            config: Application configuration snapshot; live routes are resolved per call.
        """
        # Note: We no longer cache config here to support hot reload
        # Config is read dynamically from config_manager in _get_config_value()
        self._client: Optional[AsyncOpenAI] = None

    @staticmethod
    def _coerce_timeout_seconds(value: object) -> float:
        try:
            timeout_seconds = float(value)
        except (TypeError, ValueError):
            timeout_seconds = _DEFAULT_LLM_REQUEST_TIMEOUT
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            timeout_seconds = _DEFAULT_LLM_REQUEST_TIMEOUT
        return timeout_seconds

    @classmethod
    def _build_http_timeout(cls, value: object) -> httpx.Timeout:
        """Build operation timeouts from a channel's request_timeout setting.

        ``httpx.AsyncClient()`` defaults to five seconds. That is too short for
        reasoning models and OpenAI-compatible relays, so the configured
        request timeout must be applied explicitly. Connection and pool waits
        stay bounded separately to avoid spending the whole request budget
        before a connection is established.
        """
        timeout_seconds = cls._coerce_timeout_seconds(value)

        short_timeout = min(timeout_seconds, _MAX_LLM_CONNECT_TIMEOUT)
        return httpx.Timeout(
            connect=short_timeout,
            read=timeout_seconds,
            write=timeout_seconds,
            pool=short_timeout,
        )

    def _get_config_value(self, key: str, default=None):
        """
        Get config value dynamically from config_manager (supports hot reload)

        Args:
            key: Config key name
            default: Default value if not found

        Returns:
            Config value
        """
        from pixelle_video.config import config_manager

        try:
            resolved = config_manager.resolve_model("text")
        except RuntimeError:
            return default
        aliases = {"model": "model", "local_proxy": "local_proxy"}
        if key == "local_proxy":
            common = config_manager.config.runtime.local_proxy
            return common or default
        return resolved.get(aliases.get(key, key), default)

    def _create_client(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        max_retries: int = 0,
    ) -> AsyncOpenAI:
        """
        Create OpenAI client

        Args:
            api_key: API key (optional, uses config if not provided)
            base_url: Base URL (optional, uses config if not provided)

        Returns:
            AsyncOpenAI client instance
        """
        # Get API key (priority: parameter > config)
        final_api_key = (
            api_key
            or self._get_config_value("api_key")
            or "dummy-key"  # Ollama doesn't need real key
        )

        # Get base URL (priority: parameter > config)
        final_base_url = base_url or self._get_config_value("base_url")

        # Proxying is explicit so a desktop-wide SOCKS proxy cannot silently
        # break a server configured with use_proxy=false.
        use_proxy = bool(self._get_config_value("use_proxy", False))
        proxy = self._get_config_value("local_proxy", "") if use_proxy else None
        timeout = self._build_http_timeout(
            self._get_config_value("request_timeout", _DEFAULT_LLM_REQUEST_TIMEOUT)
        )
        http_client = httpx.AsyncClient(
            proxy=proxy or None,
            timeout=timeout,
            trust_env=False,
        )

        # Create client
        client_kwargs = {"api_key": final_api_key, "max_retries": max(int(max_retries), 0)}
        if final_base_url:
            client_kwargs["base_url"] = final_base_url
        client_kwargs["http_client"] = http_client
        client_kwargs["timeout"] = timeout
        user_agent = str(self._get_config_value("user_agent", "") or "").strip()
        if user_agent:
            client_kwargs["default_headers"] = {"User-Agent": user_agent}

        return AsyncOpenAI(**client_kwargs)

    def _create_configured_client(self, route: dict) -> AsyncOpenAI:
        """Create an isolated client for one configured route."""
        proxy = (
            route.get("local_proxy")
            if bool(route.get("use_proxy", False))
            else None
        )
        timeout = self._build_http_timeout(
            route.get("request_timeout", _DEFAULT_LLM_REQUEST_TIMEOUT)
        )
        http_client = httpx.AsyncClient(
            proxy=proxy or None,
            timeout=timeout,
            trust_env=False,
        )
        client_kwargs: dict[str, object] = {
            "api_key": str(route.get("api_key") or "local-channel"),
            "base_url": str(route["base_url"]),
            "http_client": http_client,
            "timeout": timeout,
            "max_retries": 0,
        }
        user_agent = str(route.get("user_agent") or "").strip()
        if user_agent:
            client_kwargs["default_headers"] = {"User-Agent": user_agent}
        return AsyncOpenAI(**client_kwargs)

    def route_info(self) -> dict[str, str]:
        """Return the active settings-page text route without credentials."""
        from pixelle_video.config import config_manager

        try:
            resolved = config_manager.resolve_model("text")
        except RuntimeError:
            return {}
        return {
            "channel_id": str(resolved.get("channel_id") or ""),
            "channel_name": str(resolved.get("name") or ""),
            "model": str(resolved.get("model") or ""),
            "reasoning_effort": str(resolved.get("reasoning_effort") or "none"),
        }

    async def _invoke(
        self,
        client: AsyncOpenAI,
        model: str,
        prompt: str,
        response_type: Optional[Type[T]],
        temperature: float,
        max_tokens: int,
        **kwargs,
    ) -> str | T:
        if response_type is not None:
            return await self._call_with_structured_output(
                client=client,
                model=model,
                prompt=prompt,
                response_type=response_type,
                temperature=temperature,
                max_tokens=max_tokens,
                **kwargs,
            )
        result = await self._create_text_completion(
            client=client,
            model=model,
            prompt=prompt,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs,
        )
        logger.debug(f"LLM response length: {len(result)} chars")
        return result

    async def __call__(
        self,
        prompt: str,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 2000,
        response_type: Optional[Type[T]] = None,
        **kwargs,
    ) -> Union[str, T]:
        """
        Generate text using LLM

        Args:
            prompt: The prompt to generate from
            api_key: API key (optional, uses config if not provided)
            base_url: Base URL (optional, uses config if not provided)
            model: Model name (optional, uses config if not provided)
            temperature: Sampling temperature (0.0-2.0). Lower is more deterministic.
            max_tokens: Maximum tokens to generate
            response_type: Optional Pydantic model class for structured output.
                          If provided, returns parsed model instance instead of string.
            **kwargs: Additional provider-specific parameters

        Returns:
            Generated text (str) or parsed Pydantic model instance (if response_type provided)

        Examples:
            # Basic text generation
            answer = await pixelle_video.llm("Explain atomic habits")

            # Structured output with Pydantic model
            class MovieReview(BaseModel):
                title: str
                rating: int
                summary: str

            review = await pixelle_video.llm(
                prompt="Review the movie Inception",
                response_type=MovieReview
            )
            print(review.title)  # Structured access
        """
        # These private knobs are used by long-running background workflows.
        # They are deliberately removed before forwarding kwargs to the
        # OpenAI-compatible provider.
        route_retry_count_override = kwargs.pop("_route_retry_count", None)
        route_limit_override = kwargs.pop("_route_limit", None)
        request_timeout_override = kwargs.pop("_request_timeout", None)
        disable_provider_reasoning = bool(kwargs.pop("_disable_provider_reasoning", False))
        configured_base_url = self._get_config_value("base_url")
        if api_key or base_url or model or not configured_base_url:
            # Explicit call-site overrides intentionally keep one route and remain
            # useful for diagnostics and adapters that already selected a model.
            client = self._create_client(api_key=api_key, base_url=base_url)
            final_model = model or "gpt-3.5-turbo"
            timeout_seconds = self._coerce_timeout_seconds(
                request_timeout_override
                if request_timeout_override is not None
                else self._get_config_value("request_timeout", _DEFAULT_LLM_REQUEST_TIMEOUT)
            )
            try:
                async with asyncio.timeout(timeout_seconds):
                    return await self._invoke(
                        client,
                        final_model,
                        prompt,
                        response_type,
                        temperature,
                        max_tokens,
                        **kwargs,
                    )
            except asyncio.TimeoutError as exc:
                raise TimeoutError(
                    f"LLM request timed out after {timeout_seconds:g}s"
                ) from exc
            except Exception as exc:
                logger.error(f"LLM call error (model={final_model}, base_url={client.base_url}): {exc}")
                raise
            finally:
                await client.close()

        from pixelle_video.config import config_manager

        routes = config_manager.resolve_model_routes("text")
        if route_limit_override is not None:
            try:
                route_limit = max(int(route_limit_override), 1)
            except (TypeError, ValueError):
                route_limit = None
            if route_limit is not None:
                routes = routes[:route_limit]
        route_attempts: list[dict[str, object]] = []
        for route in routes:
            if route_retry_count_override is None:
                max_attempts = max(int(route.get("retry_count", 0)), 0) + 1
            else:
                try:
                    max_attempts = max(int(route_retry_count_override), 0) + 1
                except (TypeError, ValueError):
                    max_attempts = max(int(route.get("retry_count", 0)), 0) + 1
            route_id = f"{route['channel_id']}/{route['model']}"
            timeout_value = (
                request_timeout_override
                if request_timeout_override is not None
                else route.get("request_timeout", _DEFAULT_LLM_REQUEST_TIMEOUT)
            )
            timeout_seconds = self._coerce_timeout_seconds(timeout_value)
            client_route = (
                {**route, "request_timeout": timeout_seconds}
                if request_timeout_override is not None
                else route
            )
            for attempt in range(1, max_attempts + 1):
                client = self._create_configured_client(client_route)
                call_kwargs = dict(kwargs)
                explicit_reasoning = call_kwargs.get("reasoning_effort")
                is_deepseek_route = "deepseek" in str(route["model"]).lower()
                disable_route_reasoning = disable_provider_reasoning and is_deepseek_route
                if explicit_reasoning == "none":
                    call_kwargs.pop("reasoning_effort")
                elif not disable_route_reasoning:
                    route_reasoning = str(
                        route.get("reasoning_effort") or "none"
                    )
                    if route_reasoning != "none" and "reasoning_effort" not in call_kwargs:
                        call_kwargs["reasoning_effort"] = route_reasoning
                if disable_route_reasoning:
                    extra_body = call_kwargs.get("extra_body")
                    extra_body = dict(extra_body) if isinstance(extra_body, dict) else {}
                    extra_body["thinking"] = {"type": "disabled"}
                    call_kwargs["extra_body"] = extra_body
                try:
                    logger.debug(
                        f"LLM call: route={route_id}, attempt={attempt}/{max_attempts}, "
                        f"response_type={response_type}, prompt_chars={len(prompt)}, "
                        f"max_tokens={max_tokens}, wall_timeout={timeout_seconds:g}s"
                    )
                    started = time.monotonic()
                    async with asyncio.timeout(timeout_seconds):
                        result = await self._invoke(
                            client,
                            str(route["model"]),
                            prompt,
                            response_type,
                            temperature,
                            max_tokens,
                            **call_kwargs,
                        )
                    logger.info(
                        "LLM route succeeded: route={}, attempt={}/{}, elapsed={:.1f}s",
                        route_id,
                        attempt,
                        max_attempts,
                        time.monotonic() - started,
                    )
                    return result
                except asyncio.TimeoutError:
                    error = f"request timed out after {timeout_seconds:g}s"
                    route_attempts.append(
                        {
                            "channel_id": route["channel_id"],
                            "model": route["model"],
                            "attempt": attempt,
                            "max_attempts": max_attempts,
                            "error": error,
                        }
                    )
                    logger.warning(
                        "LLM route timed out: route={}, attempt={}/{}, timeout={}s",
                        route_id,
                        attempt,
                        max_attempts,
                        timeout_seconds,
                    )
                except Exception as exc:
                    error = route_attempt_error(exc)
                    route_attempts.append(
                        {
                            "channel_id": route["channel_id"],
                            "model": route["model"],
                            "attempt": attempt,
                            "max_attempts": max_attempts,
                            "error": error,
                        }
                    )
                    logger.warning(
                        "LLM route failed: route={}, attempt={}/{}, error={}",
                        route_id,
                        attempt,
                        max_attempts,
                        error,
                    )
                finally:
                    await client.close()
        raise ModelRouteExhaustedError("All text model routes failed.", route_attempts)

    async def _call_with_structured_output(
        self,
        client: AsyncOpenAI,
        model: str,
        prompt: str,
        response_type: Type[T],
        temperature: float,
        max_tokens: int,
        **kwargs,
    ) -> T:
        """
        Call LLM with structured output support

        Uses JSON schema instruction appended to prompt for maximum compatibility
        across all OpenAI-compatible providers (Qwen, DeepSeek, etc.).

        Args:
            client: OpenAI client
            model: Model name
            prompt: The prompt
            response_type: Pydantic model class
            temperature: Sampling temperature
            max_tokens: Max tokens
            **kwargs: Additional parameters

        Returns:
            Parsed Pydantic model instance
        """
        # Build JSON schema instruction and append to prompt
        json_schema_instruction = self._get_json_schema_instruction(response_type)
        enhanced_prompt = f"{prompt}\n\n{json_schema_instruction}"

        content = await self._create_text_completion(
            client=client,
            model=model,
            prompt=enhanced_prompt,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs,
        )
        logger.debug(f"Structured output response length: {len(content)} chars")

        # Parse JSON from response content
        return self._parse_response_as_model(content, response_type)

    async def _create_text_completion(
        self,
        client: AsyncOpenAI,
        model: str,
        prompt: str,
        temperature: float,
        max_tokens: int,
        **kwargs,
    ) -> str:
        """Return final-answer text and optionally recover from reasoning-only responses."""
        empty_response_retries = kwargs.pop("_empty_response_retries", 1)
        try:
            empty_response_retries = max(int(empty_response_retries), 0)
        except (TypeError, ValueError):
            empty_response_retries = 1
        token_budget = max_tokens
        last_finish_reason = "unknown"
        reasoning_length = 0
        for attempt in range(empty_response_retries + 1):
            response = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=temperature,
                max_tokens=token_budget,
                **kwargs,
            )
            if not response.choices:
                last_finish_reason = "no_choices"
                content = ""
            else:
                choice = response.choices[0]
                last_finish_reason = str(getattr(choice, "finish_reason", None) or "unknown")
                message = choice.message
                content = self._extract_message_text(getattr(message, "content", None))
                reasoning_length = self._reasoning_content_length(message)
            if content.strip():
                return content
            logger.warning(
                "LLM returned no final-answer text "
                "(model={}, base_url={}, finish_reason={}, reasoning_chars={}, attempt={}/{})",
                model,
                client.base_url,
                last_finish_reason,
                reasoning_length,
                attempt + 1,
                empty_response_retries + 1,
            )
            if attempt < empty_response_retries:
                token_budget = min(max(max_tokens * 2, 4096), 16000)

        hint = (
            "The model used its output budget for reasoning before producing a final answer"
            if last_finish_reason == "length" or reasoning_length
            else "The provider returned an empty final-answer field"
        )
        raise EmptyLLMResponseError(
            f"Text model {model!r} returned empty content after "
            f"{empty_response_retries + 1} attempt(s): {hint}. "
            "Increase the output budget or choose a non-reasoning text model. "
            f"finish_reason={last_finish_reason}"
        )

    @staticmethod
    def _extract_message_text(content: object) -> str:
        """Normalize string and multipart OpenAI-compatible message content."""
        if isinstance(content, str):
            return content
        if not isinstance(content, list):
            return ""
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
                continue
            value = part.get("text") if isinstance(part, dict) else getattr(part, "text", None)
            if isinstance(value, str):
                parts.append(value)
            elif isinstance(value, dict) and isinstance(value.get("value"), str):
                parts.append(value["value"])
        return "".join(parts)

    @staticmethod
    def _reasoning_content_length(message: object) -> int:
        """Measure provider reasoning without treating private reasoning as the final answer."""
        reasoning = getattr(message, "reasoning_content", None)
        if not isinstance(reasoning, str):
            extra = getattr(message, "model_extra", None)
            reasoning = extra.get("reasoning_content") if isinstance(extra, dict) else None
        return len(reasoning) if isinstance(reasoning, str) else 0

    def _get_json_schema_instruction(self, response_type: Type[T]) -> str:
        """
        Generate JSON schema instruction for LLM fallback mode

        Args:
            response_type: Pydantic model class

        Returns:
            Formatted instruction string with JSON schema
        """
        try:
            # Get JSON schema from Pydantic model
            schema = response_type.model_json_schema()
            schema_str = json.dumps(schema, indent=2, ensure_ascii=False)

            return f"""## IMPORTANT: JSON Output Format Required
You MUST respond with ONLY a valid JSON object (no markdown, no extra text).
The JSON must strictly follow this schema:

```json
{schema_str}
```

Output ONLY the JSON object, nothing else."""
        except Exception as e:
            logger.warning(f"Failed to generate JSON schema: {e}")
            return """## IMPORTANT: JSON Output Format Required
You MUST respond with ONLY a valid JSON object (no markdown, no extra text)."""

    def _parse_response_as_model(self, content: str, response_type: Type[T]) -> T:
        """
        Parse LLM response content as Pydantic model

        Args:
            content: Raw LLM response text
            response_type: Target Pydantic model class

        Returns:
            Parsed model instance
        """
        # Try direct JSON parsing first
        try:
            data = json.loads(content)
            return response_type.model_validate(data)
        except json.JSONDecodeError:
            pass

        # Try extracting from markdown code block
        json_pattern = r"```(?:json)?\s*([\s\S]+?)\s*```"
        match = re.search(json_pattern, content, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group(1))
                return response_type.model_validate(data)
            except json.JSONDecodeError:
                pass

        # Try to find any JSON object in the text
        brace_start = content.find("{")
        brace_end = content.rfind("}")
        if brace_start != -1 and brace_end > brace_start:
            try:
                json_str = content[brace_start : brace_end + 1]
                data = json.loads(json_str)
                return response_type.model_validate(data)
            except json.JSONDecodeError:
                pass

        raise ValueError(
            f"Failed to parse LLM response as {response_type.__name__}: {content[:200]}..."
        )

    @property
    def active(self) -> str:
        """
        Get active model name

        Returns:
            Active model name

        Example:
            print(f"Using model: {pixelle_video.llm.active}")
        """
        return self._get_config_value("model", "gpt-3.5-turbo")

    def __repr__(self) -> str:
        """String representation"""
        model = self.active
        base_url = self._get_config_value("base_url", "default")
        return f"<LLMService model={model!r} base_url={base_url!r}>"
