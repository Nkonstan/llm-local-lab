"""
The scorer contract. Every scorer — rule-based or LLM-judge — implements this
same small interface. The eval harness (and the /api/scorers, /api/eval/runs/
{id}/score routes) only ever talk to this interface; they never know how many
scorers exist or what they do internally.

To add a new scorer:
  1. Write a class implementing Scorer (see length_metric.py for the simplest
     possible example, llm_judge.py for one that calls a model).
  2. Register an instance in registry.py.
That's it — it appears in GET /api/scorers and the Eval Harness's "Score Last
Run" dropdown automatically. Nothing else in the codebase needs to change.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class ScoreResult:
    score: float | None = None
    label: str | None = None
    rationale: str | None = None
    raw: dict | None = None


class Scorer(ABC):
    name: str
    description: str
    # Whether this scorer needs a reference/expected answer to compare
    # against. None of the bundled scorers do (there's no reference-answer
    # field in the dataset format yet) — this is here so a future scorer that
    # does need one can declare it, and the UI can show/hide a reference
    # column accordingly instead of the scorer silently failing.
    requires_reference: bool = False
    # Whether this scorer's `model` param actually does anything. Only
    # LlmJudgeScorer uses it today — declaring it here (rather than the UI
    # special-casing "is this the llm-judge scorer") means any future scorer
    # that calls a model gets a judge-model picker for free just by setting
    # this True, with no frontend change.
    supports_model_override: bool = False

    @abstractmethod
    async def score(self, *, prompt: str, response: str, reference: str | None = None, model: str | None = None) -> ScoreResult:
        """Score a single (prompt, response) pair. Must not raise for normal
        inputs — return a ScoreResult with score=None and a rationale
        explaining why scoring wasn't possible instead, so one bad item
        doesn't abort scoring the rest of the run.

        `model` is an optional override for scorers that call a model
        themselves (see supports_model_override above); scorers that don't
        call a model at all simply ignore it."""
        ...


class ScorerRegistry:
    def __init__(self):
        self._scorers: dict[str, Scorer] = {}

    def register(self, scorer: Scorer) -> None:
        self._scorers[scorer.name] = scorer

    def get(self, name: str) -> Scorer | None:
        return self._scorers.get(name)

    def list(self) -> list[Scorer]:
        return list(self._scorers.values())


registry = ScorerRegistry()
