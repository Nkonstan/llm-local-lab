import json
import os
import tempfile

import httpx
import pytest
import pytest_asyncio


@pytest.fixture
def temp_db_path(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    os.remove(path)  # let init_db create it fresh
    from app.config import settings
    monkeypatch.setattr(settings, "db_path", path)
    yield path
    if os.path.exists(path):
        os.remove(path)


def _fake_ollama_handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path

    if path == "/api/tags":
        return httpx.Response(200, json={"models": [{"name": "qwen3:2b"}, {"name": "llama3.2:3b"}]})

    if path == "/api/chat":
        body = json.loads(request.content or b"{}")
        model = body.get("model", "test-model")
        # AI Evaluation judge calls (non-streaming) get a canned multi-dimension
        # verdict — includes all three dimensions regardless of which ones a
        # given test actually requested; judge_dimensions() only reads out the
        # keys it asked for, so this is a safe one-size-fits-all default.
        if body.get("stream") is False:
            return httpx.Response(200, json={
                "model": model,
                "message": {"role": "assistant", "content": json.dumps({
                    "scores": {"completeness": 9, "correctness": 8, "hallucination_risk": 2},
                    "rationale": "Solid, complete, and accurate answer with no fabricated claims.",
                })},
            })
        lines = [
            json.dumps({"model": model, "message": {"role": "assistant", "content": "Hello"}}),
            json.dumps({"model": model, "message": {"role": "assistant", "content": " world"}}),
            json.dumps({
                "model": model, "done": True,
                "total_duration": 500_000_000, "load_duration": 0,
                "prompt_eval_count": 5, "prompt_eval_duration": 100_000_000,
                "eval_count": 3, "eval_duration": 300_000_000,
            }),
        ]
        content = ("\n".join(lines) + "\n").encode()
        return httpx.Response(200, content=content)

    if path == "/api/pull":
        lines = [
            json.dumps({"status": "pulling manifest"}),
            json.dumps({"status": "downloading", "total": 100, "completed": 50}),
            json.dumps({"status": "success"}),
        ]
        content = ("\n".join(lines) + "\n").encode()
        return httpx.Response(200, content=content)

    if path == "/api/delete" and request.method == "DELETE":
        return httpx.Response(200, json={})

    return httpx.Response(404, json={"error": f"unhandled mock path {path}"})


@pytest.fixture(autouse=True)
def mock_ollama(monkeypatch):
    """Every test gets Ollama calls routed to the in-memory fake handler above
    instead of a real network call — no live Ollama server needed to run
    these tests."""
    from app import ollama_proxy

    def fake_make_client():
        return httpx.AsyncClient(transport=httpx.MockTransport(_fake_ollama_handler))

    monkeypatch.setattr(ollama_proxy, "make_client", fake_make_client)
    # chat.py / eval.py import open_ollama_stream directly, which internally
    # calls ollama_proxy.make_client — patching the module attribute above is
    # enough since open_ollama_stream looks it up via the module, not a
    # bound copy taken at import time.


@pytest_asyncio.fixture
async def client(temp_db_path, mock_ollama):
    from httpx import ASGITransport
    from app.main import app
    from app.db import init_db

    # ASGITransport doesn't run the app's lifespan (startup/shutdown) the way
    # a real server does, so the schema has to be created explicitly here —
    # otherwise every route hits "no such table".
    await init_db()

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
