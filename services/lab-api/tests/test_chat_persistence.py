import pytest


async def _send_chat(client, conversation_id, text):
    body = {
        "conversation_id": conversation_id,
        "model": "qwen3:2b",
        "messages": [{"role": "user", "content": text}],
        "stream": True,
        "think": False,
        "options": {"temperature": 0.5, "top_p": 0.9, "top_k": 40, "repeat_penalty": 1.1, "num_predict": 256, "num_ctx": 4096},
    }
    lines = []
    async with client.stream("POST", "/api/chat", json=body) as res:
        assert res.status_code == 200
        async for line in res.aiter_lines():
            if line:
                lines.append(line)
    return lines


@pytest.mark.asyncio
async def test_chat_streams_and_persists(client):
    conv_id = "conv-1"
    lines = await _send_chat(client, conv_id, "Say hi")
    assert len(lines) == 3  # two content chunks + one done chunk, matching the mock

    # The conversation should now exist with one user + one assistant message.
    res = await client.get(f"/api/conversations/{conv_id}")
    assert res.status_code == 200
    data = res.json()
    assert data["model"] == "qwen3:2b"
    assert [m["role"] for m in data["messages"]] == ["user", "assistant"]
    assert data["messages"][0]["content"] == "Say hi"
    assert data["messages"][1]["content"] == "Hello world"
    assert data["messages"][1]["stats"]["evalCount"] == 3


@pytest.mark.asyncio
async def test_chat_without_conversation_id_does_not_persist(client):
    body = {
        "model": "qwen3:2b",
        "messages": [{"role": "user", "content": "no persistence please"}],
        "stream": True, "think": False,
        "options": {"temperature": 0.5, "top_p": 0.9, "top_k": 40, "repeat_penalty": 1.1, "num_predict": 256, "num_ctx": 4096},
    }
    async with client.stream("POST", "/api/chat", json=body) as res:
        assert res.status_code == 200
        async for _ in res.aiter_lines():
            pass

    res = await client.get("/api/conversations")
    assert res.json() == []


@pytest.mark.asyncio
async def test_second_turn_appends_not_duplicates(client):
    conv_id = "conv-2"
    await _send_chat(client, conv_id, "First message")

    body = {
        "conversation_id": conv_id,
        "model": "qwen3:2b",
        "messages": [
            {"role": "user", "content": "First message"},
            {"role": "assistant", "content": "Hello world"},
            {"role": "user", "content": "Second message"},
        ],
        "stream": True, "think": False,
        "options": {"temperature": 0.5, "top_p": 0.9, "top_k": 40, "repeat_penalty": 1.1, "num_predict": 256, "num_ctx": 4096},
    }
    async with client.stream("POST", "/api/chat", json=body) as res:
        async for _ in res.aiter_lines():
            pass

    res = await client.get(f"/api/conversations/{conv_id}")
    roles = [m["role"] for m in res.json()["messages"]]
    # Exactly 4 messages total (2 turns x user+assistant) — the resent earlier
    # history in the second call's `messages` array must NOT be re-inserted.
    assert roles == ["user", "assistant", "user", "assistant"]


@pytest.mark.asyncio
async def test_conversation_list_and_delete(client):
    await _send_chat(client, "conv-3", "hello")
    res = await client.get("/api/conversations")
    assert len(res.json()) == 1

    res = await client.delete("/api/conversations/conv-3")
    assert res.status_code == 200

    res = await client.get("/api/conversations")
    assert res.json() == []
