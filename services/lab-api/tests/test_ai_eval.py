import httpx
import pytest

from app.scoring import ai_eval


def test_build_rubric_only_includes_requested_dimensions():
    rubric = ai_eval.build_rubric(prompt="p", response="r", dimensions=["correctness"])
    assert "Correctness" in rubric
    assert "Completeness" not in rubric
    assert "Hallucination Risk" not in rubric


def test_build_rubric_includes_every_requested_dimension_in_canonical_order():
    # Requested out of order — the rubric should still describe them in
    # DIMENSIONS' canonical order (completeness, correctness, hallucination_risk).
    rubric = ai_eval.build_rubric(prompt="p", response="r", dimensions=["hallucination_risk", "completeness"])
    assert rubric.index("Completeness") < rubric.index("Hallucination Risk")
    assert "Correctness" not in rubric


def test_build_rubric_mentions_hallucination_inversion():
    rubric = ai_eval.build_rubric(prompt="p", response="r", dimensions=["hallucination_risk"])
    assert "INVERTED" in rubric


@pytest.mark.asyncio
async def test_judge_dimensions_empty_response_returns_all_none_with_rationale_none():
    scores, rationale, error = await ai_eval.judge_dimensions(
        prompt="hi", response="", model="qwen3:2b", dimensions=["completeness", "correctness"],
    )
    assert scores == {"completeness": None, "correctness": None}
    assert rationale is None
    assert error is not None


@pytest.mark.asyncio
async def test_judge_dimensions_only_returns_requested_keys(monkeypatch):
    import json as _json
    from app import ollama_proxy

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "model": "qwen3:2b",
            "message": {"role": "assistant", "content": _json.dumps({
                "scores": {"completeness": 7, "correctness": 9, "hallucination_risk": 1},
                "rationale": "all good",
            })},
        })

    def fake_make_client():
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(ollama_proxy, "make_client", fake_make_client)

    scores, rationale, error = await ai_eval.judge_dimensions(
        prompt="hi", response="a real answer", model="qwen3:2b", dimensions=["completeness"],
    )
    assert error is None
    assert scores == {"completeness": 7.0}
    assert rationale == "all good"


@pytest.mark.asyncio
async def test_judge_dimensions_treats_missing_key_as_null(monkeypatch):
    import json as _json
    from app import ollama_proxy

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "model": "qwen3:2b",
            "message": {"role": "assistant", "content": _json.dumps({
                "scores": {"correctness": 8},   # completeness deliberately omitted
                "rationale": "no sub-parts to judge completeness on",
            })},
        })

    def fake_make_client():
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(ollama_proxy, "make_client", fake_make_client)

    scores, rationale, error = await ai_eval.judge_dimensions(
        prompt="hi", response="a real answer", model="qwen3:2b", dimensions=["completeness", "correctness"],
    )
    assert error is None
    assert scores["completeness"] is None
    assert scores["correctness"] == 8.0


@pytest.mark.asyncio
async def test_judge_dimensions_requests_constrained_json_output(monkeypatch):
    # Regression test: without Ollama's format:"json" grammar constraint,
    # judge models reliably produce almost-valid JSON on longer/messier
    # responses (one unescaped quote breaks json.loads) — this is what was
    # actually observed against real models. Make sure the request always
    # asks Ollama to constrain output to valid JSON.
    import json as _json
    from app import ollama_proxy

    captured_body = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_body.update(_json.loads(request.content or b"{}"))
        return httpx.Response(200, json={
            "model": "qwen3:2b",
            "message": {"role": "assistant", "content": _json.dumps({
                "scores": {"completeness": 7},
                "rationale": "fine",
            })},
        })

    def fake_make_client():
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(ollama_proxy, "make_client", fake_make_client)

    await ai_eval.judge_dimensions(
        prompt="hi", response="a real answer", model="qwen3:2b", dimensions=["completeness"],
    )
    assert captured_body.get("format") == "json"


@pytest.mark.asyncio
async def test_judge_dimensions_handles_content_with_no_surrounding_prose(monkeypatch):
    # With format:"json" set, content should be exactly one JSON value with
    # no wrapping text — confirm the direct json.loads(content) path (not
    # just the brace-extraction regex fallback) handles that correctly.
    import json as _json
    from app import ollama_proxy

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "model": "qwen3:2b",
            "message": {"role": "assistant", "content": _json.dumps({
                "scores": {"correctness": 5},
                "rationale": "no wrapping prose here",
            })},
        })

    def fake_make_client():
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(ollama_proxy, "make_client", fake_make_client)

    scores, rationale, error = await ai_eval.judge_dimensions(
        prompt="hi", response="a real answer", model="qwen3:2b", dimensions=["correctness"],
    )
    assert error is None
    assert scores == {"correctness": 5.0}
    assert rationale == "no wrapping prose here"


@pytest.mark.asyncio
async def test_judge_dimensions_strips_markdown_code_fence(monkeypatch):
    # Some judge models wrap JSON in a ```json fence out of habit even when
    # told not to — this should still parse instead of failing.
    import json as _json
    from app import ollama_proxy

    def handler(request: httpx.Request) -> httpx.Response:
        payload = _json.dumps({"scores": {"correctness": 4}, "rationale": "fenced"})
        return httpx.Response(200, json={
            "model": "qwen3:2b",
            "message": {"role": "assistant", "content": f"```json\n{payload}\n```"},
        })

    def fake_make_client():
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(ollama_proxy, "make_client", fake_make_client)

    scores, rationale, error = await ai_eval.judge_dimensions(
        prompt="hi", response="a real answer", model="qwen3:2b", dimensions=["correctness"],
    )
    assert error is None
    assert scores == {"correctness": 4.0}
    assert rationale == "fenced"


@pytest.mark.asyncio
async def test_judge_dimensions_repairs_truncated_json_missing_closing_brace(monkeypatch):
    # Regression test for a real production bug: the judge model wrote the
    # full {"scores": {...}, "rationale": "..." body correctly and never
    # emitted the final closing "}" (a token-budget cutoff one token too
    # early). Before the fix, the brace-extraction regex would grab only up
    # to the FIRST "}" (closing the inner "scores" object) and silently
    # discard the entire rationale. Confirm the repair step recovers both
    # the scores AND the full rationale instead.
    import json as _json
    from app import ollama_proxy

    truncated_content = (
        '{"scores": {"completeness": 10, "correctness": 9, "hallucination_risk": 2}, '
        '"rationale": "The response fully addresses the prompt and contains no '
        'fabricated claims whatsoever, making it both complete and accurate."'
        # NOTE: deliberately missing the final closing "}" for the outer object.
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "model": "qwen3.5:9b",
            "message": {"role": "assistant", "content": truncated_content},
        })

    def fake_make_client():
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(ollama_proxy, "make_client", fake_make_client)

    scores, rationale, error = await ai_eval.judge_dimensions(
        prompt="hi", response="a real answer", model="qwen3.5:9b",
        dimensions=["completeness", "correctness", "hallucination_risk"],
    )
    assert error is None
    assert scores == {"completeness": 10.0, "correctness": 9.0, "hallucination_risk": 2.0}
    assert rationale is not None and rationale.startswith("The response fully addresses")
    assert rationale.endswith("accurate.")   # full rationale preserved, not truncated by the regex fallback


@pytest.mark.asyncio
async def test_judge_dimensions_still_fails_gracefully_if_repair_cannot_fix_it(monkeypatch):
    # If the content is broken in some way the brace-repair can't patch
    # (e.g. garbage mid-string, not just a missing trailing brace), we
    # should still fail gracefully rather than raise.
    from app import ollama_proxy

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "model": "qwen3.5:9b",
            "message": {"role": "assistant", "content": '{"scores": {"completeness": totally not valid'},
        })

    def fake_make_client():
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(ollama_proxy, "make_client", fake_make_client)

    scores, rationale, error = await ai_eval.judge_dimensions(
        prompt="hi", response="a real answer", model="qwen3.5:9b", dimensions=["completeness"],
    )
    assert scores == {"completeness": None}
    assert error is not None


@pytest.mark.asyncio
async def test_judge_dimensions_unparseable_content_returns_error(monkeypatch):
    # Safety net for a judge/Ollama version that ignores format:"json"
    # entirely and returns plain prose with no JSON object at all.
    from app import ollama_proxy

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "model": "qwen3:2b",
            "message": {"role": "assistant", "content": "not json at all"},
        })

    def fake_make_client():
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(ollama_proxy, "make_client", fake_make_client)

    scores, rationale, error = await ai_eval.judge_dimensions(
        prompt="hi", response="a real answer", model="qwen3:2b", dimensions=["completeness"],
    )
    assert scores == {"completeness": None}
    assert rationale is None
    assert error is not None
