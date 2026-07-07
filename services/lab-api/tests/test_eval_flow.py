import json

import pytest


async def _generate(client, run_id, cell_index, prompt_index, repeat_index=0):
    async with client.stream("POST", "/api/eval/generate", json={
        "run_id": run_id, "cell_index": cell_index, "prompt_index": prompt_index, "repeat_index": repeat_index,
    }) as res:
        assert res.status_code == 200
        async for _ in res.aiter_lines():
            pass


async def _score(client, run_id, dimensions, model=None):
    """/score streams NDJSON now (one progress line per generation judged,
    then one final {"type": "done", "judgments": [...]} line) — this drains
    the stream and returns (status_code, progress_lines, judgments-or-None),
    mirroring what the real frontend does in api-client.js's scoreEvalRun()."""
    body = {"dimensions": dimensions}
    if model is not None:
        body["model"] = model
    async with client.stream("POST", f"/api/eval/runs/{run_id}/score", json=body) as res:
        status_code = res.status_code
        if status_code != 200:
            await res.aread()
            return status_code, [], None
        progress = []
        judgments = None
        async for line in res.aiter_lines():
            if not line:
                continue
            msg = json.loads(line)
            if msg["type"] == "progress":
                progress.append((msg["completed"], msg["total"]))
            elif msg["type"] == "done":
                judgments = msg["judgments"]
        return status_code, progress, judgments


@pytest.mark.asyncio
async def test_full_sweep_lifecycle(client):
    run_id = "run-1"
    res = await client.post("/api/eval/runs", json={
        "id": run_id,
        "axes": [{"param": "model", "values": ["qwen3:2b", "llama3.2:3b"]}],
        "base_config": {"temperature": 0.5},
        "prompts": ["What is 2+2?"],
        "repeat_count": 1,
    })
    assert res.status_code == 200
    data = res.json()
    assert len(data["cells"]) == 2

    for cell in data["cells"]:
        await _generate(client, run_id, cell["cell_index"], 0)

    res = await client.patch(f"/api/eval/runs/{run_id}", json={"status": "done"})
    assert res.status_code == 200

    res = await client.get(f"/api/eval/runs/{run_id}")
    assert res.status_code == 200
    detail = res.json()
    assert detail["status"] == "done"
    assert len(detail["results"]) == 2
    assert all(r["status"] == "done" for r in detail["results"])
    assert detail["results"][0]["response"] == "Hello world"

    res = await client.get("/api/eval/runs")
    summaries = res.json()
    assert len(summaries) == 1
    assert summaries[0]["cell_count"] == 2
    assert summaries[0]["prompt_count"] == 1


@pytest.mark.asyncio
async def test_unknown_axis_param_rejected(client):
    res = await client.post("/api/eval/runs", json={
        "id": "run-bad", "axes": [{"param": "nonsense", "values": [1]}],
        "base_config": {"model": "qwen3:2b"}, "prompts": ["hi"],
    })
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_missing_model_rejected(client):
    res = await client.post("/api/eval/runs", json={
        "id": "run-bad2", "axes": [{"param": "temperature", "values": [0.1]}],
        "base_config": {}, "prompts": ["hi"],
    })
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_scorer_registry_still_exposes_legacy_scorers(client):
    # response-length and refusal-check are no longer reachable from the AI
    # Evaluation UI/endpoint, but their Scorer classes and this registry
    # listing stay in place as extension-pattern examples — see
    # app/scoring/base.py and __init__.py.
    res = await client.get("/api/scorers")
    names = {s["name"] for s in res.json()}
    assert {"response-length", "refusal-check", "llm-judge"} <= names


@pytest.mark.asyncio
async def test_ai_evaluation_scores_only_selected_dimensions(client):
    run_id = "run-2"
    res = await client.post("/api/eval/runs", json={
        "id": run_id, "axes": [], "base_config": {"model": "qwen3:2b"}, "prompts": ["hi"],
    })
    cell_index = res.json()["cells"][0]["cell_index"]
    await _generate(client, run_id, cell_index, 0)

    status, progress, judgments = await _score(client, run_id, ["completeness", "hallucination_risk"], "qwen3:2b")
    assert status == 200
    # One row scored (one prompt, one repeat) -> exactly one progress line,
    # reaching completed == total (redesign item 2: real progress, not a
    # fake/indeterminate counter).
    assert progress == [(1, 1)]
    names = {j["scorer_name"] for j in judgments}
    assert names == {"llm-judge:completeness", "llm-judge:hallucination_risk"}

    by_name = {j["scorer_name"]: j for j in judgments}
    assert by_name["llm-judge:completeness"]["score"] == 9.0
    assert by_name["llm-judge:hallucination_risk"]["score"] == 2.0
    # One combined call produces one shared rationale for every dimension scored.
    assert by_name["llm-judge:completeness"]["rationale"] == by_name["llm-judge:hallucination_risk"]["rationale"]
    # correctness was never requested — the mock always includes it in its
    # canned reply, but it must not be stored/returned since it wasn't checked.
    assert "llm-judge:correctness" not in names

    # Judgments persist and show up on refetch, under their per-dimension names.
    res = await client.get(f"/api/eval/runs/{run_id}")
    fetched_names = {j["scorer_name"] for j in res.json()["judgments"]}
    assert fetched_names == {"llm-judge:completeness", "llm-judge:hallucination_risk"}


@pytest.mark.asyncio
async def test_ai_evaluation_unknown_dimension_rejected(client):
    run_id = "run-3"
    await client.post("/api/eval/runs", json={
        "id": run_id, "axes": [], "base_config": {"model": "x"}, "prompts": ["hi"],
    })
    status, _, _ = await _score(client, run_id, ["vibes"])
    assert status == 400


@pytest.mark.asyncio
async def test_ai_evaluation_requires_at_least_one_dimension(client):
    run_id = "run-4"
    await client.post("/api/eval/runs", json={
        "id": run_id, "axes": [], "base_config": {"model": "x"}, "prompts": ["hi"],
    })
    status, _, _ = await _score(client, run_id, [])
    assert status == 400


@pytest.mark.asyncio
async def test_ai_evaluation_variance_computed_per_dimension_independently(client):
    run_id = "run-5"
    res = await client.post("/api/eval/runs", json={
        "id": run_id, "axes": [], "base_config": {"model": "qwen3:2b"}, "prompts": ["hi"], "repeat_count": 2,
    })
    cell_index = res.json()["cells"][0]["cell_index"]
    await _generate(client, run_id, cell_index, 0, repeat_index=0)
    await _generate(client, run_id, cell_index, 0, repeat_index=1)

    # Auto-triggered in the SAME request as the scoring pass — no separate
    # manual endpoint/button any more.
    status, progress, judgments = await _score(client, run_id, ["completeness", "hallucination_risk"])
    assert status == 200
    # 2 repeats scored -> 2 progress lines; variance rows only appear in the
    # final "done" line (they're computed AFTER the per-generation loop),
    # never as their own progress tick.
    assert progress == [(1, 2), (2, 2)]
    variance = {j["scorer_name"]: j for j in judgments if j["scorer_name"].endswith(":variance")}
    assert set(variance) == {"llm-judge:completeness:variance", "llm-judge:hallucination_risk:variance"}
    # The mock returns identical scores for every repeat -> CV is 0, independently for each dimension.
    assert variance["llm-judge:completeness:variance"]["score"] == 0.0
    assert variance["llm-judge:hallucination_risk:variance"]["score"] == 0.0
    for v in variance.values():
        assert v["repeat_index"] is None


@pytest.mark.asyncio
async def test_ai_evaluation_variance_skipped_below_repeat_count_two(client):
    run_id = "run-5b"
    res = await client.post("/api/eval/runs", json={
        "id": run_id, "axes": [], "base_config": {"model": "qwen3:2b"}, "prompts": ["hi"],   # repeat_count defaults to 1
    })
    cell_index = res.json()["cells"][0]["cell_index"]
    await _generate(client, run_id, cell_index, 0)

    status, _, judgments = await _score(client, run_id, ["completeness"])
    assert status == 200
    assert all(not j["scorer_name"].endswith(":variance") for j in judgments)


@pytest.mark.asyncio
async def test_ai_evaluation_null_scores_excluded_from_variance(client, monkeypatch):
    # First judge call returns a null completeness score (not applicable);
    # second returns a real one — completeness should end up with only 1
    # non-null score across the 2 repeats, so its variance must be omitted,
    # while correctness (real scores on both repeats) still gets one.
    import httpx as _httpx
    from app import ollama_proxy
    from tests.conftest import _fake_ollama_handler

    call_count = {"n": 0}

    def handler(request: _httpx.Request) -> _httpx.Response:
        body = json.loads(request.content or b"{}")
        if request.url.path == "/api/chat" and body.get("stream") is False:
            call_count["n"] += 1
            completeness = None if call_count["n"] == 1 else 6
            return _httpx.Response(200, json={
                "model": body.get("model"),
                "message": {"role": "assistant", "content": json.dumps({
                    "scores": {"completeness": completeness, "correctness": 8},
                    "rationale": "ok",
                })},
            })
        return _fake_ollama_handler(request)

    def fake_make_client():
        return _httpx.AsyncClient(transport=_httpx.MockTransport(handler))

    monkeypatch.setattr(ollama_proxy, "make_client", fake_make_client)

    run_id = "run-5c"
    res = await client.post("/api/eval/runs", json={
        "id": run_id, "axes": [], "base_config": {"model": "qwen3:2b"}, "prompts": ["hi"], "repeat_count": 2,
    })
    cell_index = res.json()["cells"][0]["cell_index"]
    await _generate(client, run_id, cell_index, 0, repeat_index=0)
    await _generate(client, run_id, cell_index, 0, repeat_index=1)

    status, _, judgments = await _score(client, run_id, ["completeness", "correctness"])
    assert status == 200

    completeness_scores = [
        j["score"] for j in judgments
        if j["scorer_name"] == "llm-judge:completeness" and j["repeat_index"] is not None
    ]
    assert completeness_scores.count(None) == 1
    assert 6.0 in completeness_scores

    # Only 1 non-null completeness score remains -> no variance row for it.
    assert not any(j["scorer_name"] == "llm-judge:completeness:variance" for j in judgments)
    # correctness has 2 non-null scores (8, 8) -> variance row IS produced.
    correctness_variance = [j for j in judgments if j["scorer_name"] == "llm-judge:correctness:variance"]
    assert len(correctness_variance) == 1
    assert correctness_variance[0]["score"] == 0.0


@pytest.mark.asyncio
async def test_hosted_baseline_cell_created(client):
    run_id = "run-6"
    res = await client.post("/api/eval/runs", json={
        "id": run_id, "axes": [], "base_config": {"model": "qwen3:2b"}, "prompts": ["hi"],
        "hosted_baseline": {"endpoint": "https://api.example.invalid/v1", "model": "gpt-4o-mini"},
    })
    cells = res.json()["cells"]
    assert len(cells) == 2
    baseline = next(c for c in cells if c["is_baseline"])
    assert baseline["config"]["model"] == "gpt-4o-mini"


@pytest.mark.asyncio
async def test_scorers_expose_model_override_support(client):
    res = await client.get("/api/scorers")
    by_name = {s["name"]: s for s in res.json()}
    assert by_name["llm-judge"]["supports_model_override"] is True
    assert by_name["response-length"]["supports_model_override"] is False
    assert by_name["refusal-check"]["supports_model_override"] is False


@pytest.mark.asyncio
async def test_ai_evaluation_respects_judge_model_override(client, monkeypatch):
    # The mock_ollama fixture's fake handler always returns the same canned
    # judge verdict regardless of which model was asked — so to actually
    # prove the override took effect, patch the handler to only answer for
    # the overridden model name and 404 for anything else (in particular the
    # ai_eval.DEFAULT_JUDGE_MODEL default).
    import httpx as _httpx
    from app import ollama_proxy

    def handler(request: _httpx.Request) -> _httpx.Response:
        body = json.loads(request.content or b"{}")
        if request.url.path == "/api/chat" and body.get("stream") is False and body.get("model") == "llama3.2:3b":
            return _httpx.Response(200, json={
                "model": "llama3.2:3b",
                "message": {"role": "assistant", "content": json.dumps({
                    "scores": {"correctness": 10},
                    "rationale": "Judged by the override model.",
                })},
            })
        return _httpx.Response(404, json={"error": "unexpected model in this test"})

    def fake_make_client():
        return _httpx.AsyncClient(transport=_httpx.MockTransport(handler))

    run_id = "run-8"
    res = await client.post("/api/eval/runs", json={
        "id": run_id, "axes": [], "base_config": {"model": "qwen3:2b"}, "prompts": ["hi"],
    })
    cell_index = res.json()["cells"][0]["cell_index"]

    # Generation uses the normal autouse mock_ollama fixture; only after it's
    # done do we swap in the override-only handler for the scoring call.
    await _generate(client, run_id, cell_index, 0)
    monkeypatch.setattr(ollama_proxy, "make_client", fake_make_client)

    status, _, judgments = await _score(client, run_id, ["correctness"], "llama3.2:3b")
    assert status == 200
    assert judgments[0]["score"] == 10.0
    assert judgments[0]["rationale"] == "Judged by the override model."


@pytest.mark.asyncio
async def test_hosted_baseline_generation(client, monkeypatch):
    # eval.py did `from ..hosted_proxy import stream_hosted_chat`, which binds
    # its own name at import time — patching hosted_proxy.stream_hosted_chat
    # directly would NOT affect eval.py's already-bound reference. Patching
    # app.routers.eval.stream_hosted_chat (where it's actually called from)
    # is the one that takes effect.
    async def fake_stream_hosted_chat(endpoint, api_key, model, messages, options):
        yield json.dumps({"model": model, "message": {"role": "assistant", "content": "hosted reply"}, "done": False}) + "\n"
        yield json.dumps({"model": model, "done": True, "eval_count": 4, "eval_duration": 100_000_000}) + "\n"

    monkeypatch.setattr("app.routers.eval.stream_hosted_chat", fake_stream_hosted_chat)

    run_id = "run-7"
    res = await client.post("/api/eval/runs", json={
        "id": run_id, "axes": [], "base_config": {"model": "qwen3:2b"}, "prompts": ["hi"],
        "hosted_baseline": {"endpoint": "https://api.example.invalid/v1", "model": "gpt-4o-mini"},
    })
    baseline_cell = next(c for c in res.json()["cells"] if c["is_baseline"])

    await _generate(client, run_id, baseline_cell["cell_index"], 0)

    detail = (await client.get(f"/api/eval/runs/{run_id}")).json()
    baseline_result = next(r for r in detail["results"] if r["cell_index"] == baseline_cell["cell_index"])
    assert baseline_result["response"] == "hosted reply"
    assert baseline_result["status"] == "done"
