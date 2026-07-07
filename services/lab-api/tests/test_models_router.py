import pytest


@pytest.mark.asyncio
async def test_get_tags(client):
    res = await client.get("/api/tags")
    assert res.status_code == 200
    names = [m["name"] for m in res.json()["models"]]
    assert "qwen3:2b" in names


@pytest.mark.asyncio
async def test_pull_streams_progress(client):
    async with client.stream("POST", "/api/pull", json={"name": "qwen3:2b", "stream": True}) as res:
        assert res.status_code == 200
        lines = [line async for line in res.aiter_lines() if line]
    assert any('"success"' in l for l in lines)


@pytest.mark.asyncio
async def test_delete_model(client):
    res = await client.request("DELETE", "/api/delete", json={"name": "qwen3:2b"})
    assert res.status_code == 200
    assert res.json()["deleted"] == "qwen3:2b"
