import json

from fastapi import APIRouter, HTTPException

from ..models import ConversationSummary, ConversationDetail, MessageOut
from ..db import get_db

router = APIRouter()


@router.get("/api/conversations", response_model=list[ConversationSummary])
async def list_conversations():
    async with get_db() as db:
        cur = await db.execute(
            "SELECT id, title, model, updated_at FROM conversations ORDER BY updated_at DESC"
        )
        rows = await cur.fetchall()
    return [ConversationSummary(**dict(row)) for row in rows]


@router.get("/api/conversations/{conv_id}", response_model=ConversationDetail)
async def get_conversation(conv_id: str):
    async with get_db() as db:
        cur = await db.execute(
            "SELECT id, title, model, system_prompt, updated_at FROM conversations WHERE id = ?",
            (conv_id,),
        )
        conv_row = await cur.fetchone()
        if conv_row is None:
            raise HTTPException(status_code=404, detail="Conversation not found")

        cur = await db.execute(
            "SELECT role, content, thinking, stats_json FROM messages WHERE conversation_id = ? ORDER BY id",
            (conv_id,),
        )
        msg_rows = await cur.fetchall()

    messages = [
        MessageOut(
            role=row["role"],
            content=row["content"] or "",
            thinking=row["thinking"],
            stats=json.loads(row["stats_json"]) if row["stats_json"] else None,
        )
        for row in msg_rows
    ]
    return ConversationDetail(
        id=conv_row["id"], title=conv_row["title"], model=conv_row["model"],
        system_prompt=conv_row["system_prompt"], updated_at=conv_row["updated_at"],
        messages=messages,
    )


@router.delete("/api/conversations/{conv_id}")
async def delete_conversation(conv_id: str):
    async with get_db() as db:
        await db.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
        await db.commit()
    return {"deleted": conv_id}
