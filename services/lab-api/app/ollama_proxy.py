"""
The one place that talks to Ollama over HTTP. Both /api/chat and
/api/eval/generate build on open_ollama_stream(): check the response status
before committing to a streaming reply (so a bad request still comes back as
a normal HTTP error, matching what the frontend expects), then hand back an
async generator that forwards each NDJSON line to the client the moment it
arrives while also accumulating the full content/thinking/final stats chunk
so the caller can persist the completed turn once the stream ends.
"""

import json
import httpx

from .config import settings


class OllamaError(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(settings.ollama_connect_timeout, read=settings.ollama_read_timeout)
    )


def new_collector() -> dict:
    return {"full_content": "", "full_thinking": "", "final_chunk": None, "error": None}


def accumulate_line(collector: dict, line: str) -> None:
    try:
        chunk = json.loads(line)
    except json.JSONDecodeError:
        return
    msg = chunk.get("message") or {}
    if msg.get("thinking"):
        collector["full_thinking"] += msg["thinking"]
    if msg.get("content"):
        collector["full_content"] += msg["content"]
    if chunk.get("done"):
        collector["final_chunk"] = chunk


async def open_ollama_stream(path: str, body: dict):
    """Opens a streaming POST to Ollama and returns (client, stream_cm, response)
    once headers are in and the status has been checked. Raises OllamaError
    (already cleaned up) for a non-2xx response instead of committing to a
    stream, so the caller can turn that into a normal HTTP error response."""
    client = make_client()
    stream_cm = client.stream("POST", f"{settings.ollama_base_url}{path}", json=body)
    response = await stream_cm.__aenter__()
    if response.status_code >= 400:
        text = (await response.aread()).decode(errors="replace")
        await stream_cm.__aexit__(None, None, None)
        await client.aclose()
        raise OllamaError(response.status_code, f"Ollama returned {response.status_code}: {text}")
    return client, stream_cm, response


async def close_ollama_stream(client: httpx.AsyncClient, stream_cm) -> None:
    await stream_cm.__aexit__(None, None, None)
    await client.aclose()


def compute_stats(final_chunk: dict | None, fallback_model: str) -> dict | None:
    """Mirrors the frontend's stats computation (same fields, same formulas)
    so persisted stats match what a live request would have shown. TTFT can't
    be measured server-side the way the browser measures it (time to first
    byte reaching the page), so this uses the same fallback the frontend uses
    when it has no better number: prompt_eval_duration."""
    if not final_chunk:
        return None
    ns = 1e9
    eval_count = final_chunk.get("eval_count") or 0
    eval_duration = (final_chunk.get("eval_duration") or 0) / ns
    tokens_per_sec = eval_count / eval_duration if eval_count > 0 and eval_duration > 0 else 0
    return {
        "model": final_chunk.get("model") or fallback_model,
        "ttft": (final_chunk.get("prompt_eval_duration") or 0) / ns,
        "totalTime": (final_chunk.get("total_duration") or 0) / ns,
        "loadDuration": (final_chunk.get("load_duration") or 0) / ns,
        "promptEvalCount": final_chunk.get("prompt_eval_count") or 0,
        "promptEvalDuration": (final_chunk.get("prompt_eval_duration") or 0) / ns,
        "evalCount": eval_count,
        "evalDuration": eval_duration,
        "tokensPerSec": tokens_per_sec,
    }
