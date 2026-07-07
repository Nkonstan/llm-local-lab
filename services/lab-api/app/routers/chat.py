import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..models import ChatRequest
from ..db import get_db
from ..ollama_proxy import open_ollama_stream, close_ollama_stream, accumulate_line, compute_stats, OllamaError

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_ollama_body(model: str, messages: list, stream: bool, think, options) -> dict:
    return {
        "model": model,
        "messages": [m.model_dump() for m in messages],
        "stream": stream,
        "think": think,
        "options": {k: v for k, v in options.model_dump().items() if v is not None},
    }


async def _persist_chat_turn(req: ChatRequest, collector: dict) -> None:
    """Only the newest user message (the last one in req.messages — the
    frontend keeps its own history and resends the full array each call, so
    everything before it was already persisted on a previous turn) plus the
    assistant's reply get written. Persistence is opt-in: no conversation_id
    means "don't save", so this never blocks a request that doesn't want it."""
    if not req.conversation_id:
        return

    now = _now()
    system_prompt = next((m.content for m in req.messages if m.role == "system"), None)
    last_user = next((m for m in reversed(req.messages) if m.role == "user"), None)

    async with get_db() as db:
        cur = await db.execute("SELECT id FROM conversations WHERE id = ?", (req.conversation_id,))
        existing = await cur.fetchone()

        if existing is None:
            title = (last_user.content[:60] if last_user else "New conversation")
            await db.execute(
                "INSERT INTO conversations (id, title, model, system_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (req.conversation_id, title, req.model, system_prompt, now, now),
            )
        else:
            await db.execute(
                "UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?",
                (req.model, now, req.conversation_id),
            )

        if last_user is not None:
            await db.execute(
                "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
                (req.conversation_id, "user", last_user.content, now),
            )

        stats = compute_stats(collector.get("final_chunk"), req.model)
        await db.execute(
            "INSERT INTO messages (conversation_id, role, content, thinking, stats_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                req.conversation_id, "assistant",
                collector.get("full_content", ""),
                collector.get("full_thinking") or None,
                json.dumps(stats) if stats else None,
                now,
            ),
        )
        await db.commit()


@router.post("/api/chat")
async def chat(req: ChatRequest):
    body = _build_ollama_body(req.model, req.messages, req.stream, req.think, req.options)

    try:
        client, stream_cm, response = await open_ollama_stream("/api/chat", body)
    except OllamaError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)

    collector = {"full_content": "", "full_thinking": "", "final_chunk": None}

    async def gen():
        try:
            async for line in response.aiter_lines():
                if not line:
                    continue
                yield line + "\n"
                accumulate_line(collector, line)
        finally:
            await close_ollama_stream(client, stream_cm)
            await _persist_chat_turn(req, collector)

    return StreamingResponse(gen(), media_type="application/x-ndjson")
