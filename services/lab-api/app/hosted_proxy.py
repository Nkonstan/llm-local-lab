"""
The one place that talks to an OpenAI-compatible endpoint — item 6 in the
redesign brief, deliberately the smallest piece of the six: a single optional
hosted-baseline field, not a multi-provider platform.

Rather than giving the frontend (or eval.py) a second response shape to
parse, stream_hosted_chat() normalizes the OpenAI-style SSE stream into the
exact same Ollama-shaped NDJSON chunks that open_ollama_stream()'s caller
already accumulates via accumulate_line() / compute_stats(). Everything
downstream of this module — persistence, the frontend's consumeChatStream()
— stays provider-agnostic.
"""

import json
import time

import httpx

from .config import settings


class HostedError(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def _make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(settings.hosted_connect_timeout, read=settings.hosted_read_timeout)
    )


def _build_body(model: str, messages: list[dict], options: dict) -> dict:
    body = {"model": model, "messages": messages, "stream": True}
    if options.get("temperature") is not None:
        body["temperature"] = options["temperature"]
    if options.get("top_p") is not None:
        body["top_p"] = options["top_p"]
    if options.get("num_predict") is not None:
        body["max_tokens"] = options["num_predict"]
    if options.get("seed") is not None:
        body["seed"] = options["seed"]
    return body


async def stream_hosted_chat(endpoint: str, api_key: str | None, model: str, messages: list[dict], options: dict):
    """Yields Ollama-shaped NDJSON lines (same shape Ollama itself streams),
    ending with one done:true chunk carrying best-effort timing stats.

    Token/timing fields are approximated from wall-clock + character count
    rather than read from the provider (OpenAI-compatible streams don't
    reliably expose eval_count/eval_duration the way Ollama does). That's
    fine for this feature's actual job — "is my local setup in the right
    ballpark vs. hosted," not a precise cross-provider benchmark — but it's
    an approximation, not a measurement, and callers should treat it as one.
    """
    url = endpoint.rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body = _build_body(model, messages, options)

    client = _make_client()
    start = time.monotonic()
    first_token_time: float | None = None
    full_content = ""

    try:
        async with client.stream("POST", url, json=body, headers=headers) as response:
            if response.status_code >= 400:
                text = (await response.aread()).decode(errors="replace")
                raise HostedError(response.status_code, f"Hosted endpoint returned {response.status_code}: {text}")

            async for line in response.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue

                choices = chunk.get("choices") or [{}]
                delta = choices[0].get("delta") or {}
                content_piece = delta.get("content") or ""
                if content_piece:
                    if first_token_time is None:
                        first_token_time = time.monotonic()
                    full_content += content_piece
                    yield json.dumps({
                        "model": model,
                        "message": {"role": "assistant", "content": content_piece},
                        "done": False,
                    }) + "\n"
    finally:
        await client.aclose()

    end = time.monotonic()
    ttft_s = (first_token_time - start) if first_token_time is not None else 0.0
    total_s = end - start
    eval_duration_s = max(end - (first_token_time or start), 1e-6)
    # ~4 chars/token is a rough English-text heuristic, not a tokenizer —
    # good enough for a ballpark tokens/sec, not for exact counts.
    approx_tokens = max(1, len(full_content) // 4)

    yield json.dumps({
        "model": model,
        "message": {"role": "assistant", "content": ""},
        "done": True,
        "prompt_eval_duration": int(ttft_s * 1e9),
        "total_duration": int(total_s * 1e9),
        "eval_count": approx_tokens,
        "eval_duration": int(eval_duration_s * 1e9),
        "load_duration": 0,
        "prompt_eval_count": 0,
    }) + "\n"
