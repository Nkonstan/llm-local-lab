from .base import Scorer, ScoreResult


class LengthScorer(Scorer):
    """Simplest possible scorer, and a template for writing more: no LLM call,
    pure function of the response text, always returns instantly."""

    name = "response-length"
    description = "Word count of the response — no LLM call, purely deterministic."
    requires_reference = False

    async def score(self, *, prompt: str, response: str, reference: str | None = None, model: str | None = None) -> ScoreResult:
        if not response:
            return ScoreResult(score=0, label="empty", rationale="Response was empty.")
        words = len(response.split())
        if words < 20:
            label = "short"
        elif words < 150:
            label = "medium"
        else:
            label = "long"
        return ScoreResult(score=float(words), label=label, rationale=f"{words} words.")
