from .base import registry, Scorer, ScoreResult
from .length_metric import LengthScorer
from .refusal_check import RefusalCheckScorer
from .llm_judge import LlmJudgeScorer

# Registration happens once, at import time. Adding a new scorer is: write the
# class next to these, import it here, and add one line below — nothing else
# in the app (routes, frontend) needs to know about it.
registry.register(LengthScorer())
registry.register(RefusalCheckScorer())
registry.register(LlmJudgeScorer())

__all__ = ["registry", "Scorer", "ScoreResult"]
