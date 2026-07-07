import pytest

from app.scoring.length_metric import LengthScorer
from app.scoring.refusal_check import RefusalCheckScorer


@pytest.mark.asyncio
async def test_length_scorer_buckets():
    scorer = LengthScorer()
    empty = await scorer.score(prompt="x", response="")
    assert empty.score == 0 and empty.label == "empty"

    short = await scorer.score(prompt="x", response="just a few words here")
    assert short.label == "short"

    long_resp = await scorer.score(prompt="x", response=" ".join(["word"] * 200))
    assert long_resp.label == "long"
    assert long_resp.score == 200


@pytest.mark.asyncio
async def test_refusal_check_detects_common_refusals():
    scorer = RefusalCheckScorer()
    refusal = await scorer.score(prompt="do something bad", response="I can't help with that request.")
    assert refusal.label == "likely refusal"
    assert refusal.score == 0.0

    normal = await scorer.score(prompt="what's 2+2", response="2 + 2 is 4.")
    assert normal.label == "answered"
    assert normal.score == 1.0


@pytest.mark.asyncio
async def test_refusal_check_empty_response():
    scorer = RefusalCheckScorer()
    result = await scorer.score(prompt="x", response="")
    assert result.label == "empty"
    assert result.score is None
