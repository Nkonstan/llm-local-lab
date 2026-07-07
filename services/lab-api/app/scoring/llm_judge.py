import json
import os
import re

from .base import Scorer, ScoreResult
from .. import ollama_proxy
from ..config import settings

JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "qwen3:2b")

_RUBRIC = """You are grading a single AI assistant response for quality. \
Score it from 1 (poor) to 10 (excellent) on how helpful, accurate, and \
relevant it is given the prompt. Respond with ONLY a JSON object of the \
exact shape {{"score": <1-10 integer>, "rationale": "<one sentence>"}} \
and nothing else — no markdown, no extra text.

Prompt:
{prompt}

Response:
{response}
"""

_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


class LlmJudgeScorer(Scorer):
    name = "llm-judge"
    description = f"Asks a judge model (default {JUDGE_MODEL}) to rate the response 1-10 with a rationale. Pick a different judge model when scoring."
    requires_reference = False
    supports_model_override = True

    async def score(self, *, prompt: str, response: str, reference: str | None = None, model: str | None = None) -> ScoreResult:
        judge_model = model or JUDGE_MODEL
        if not response:
            return ScoreResult(score=None, label=None, rationale="Response was empty — nothing to judge.")

        body = {
            "model": judge_model,
            "messages": [{"role": "user", "content": _RUBRIC.format(prompt=prompt, response=response)}],
            "stream": False,
            "think": False,
            "options": {"temperature": 0.0},
        }
        try:
            async with ollama_proxy.make_client() as client:
                res = await client.post(f"{settings.ollama_base_url}/api/chat", json=body)
                res.raise_for_status()
                data = res.json()
        except Exception as e:
            return ScoreResult(score=None, rationale=f"Judge model call failed: {e}")

        content = (data.get("message") or {}).get("content", "")
        match = _JSON_RE.search(content)
        if not match:
            return ScoreResult(score=None, rationale=f"Judge did not return parseable JSON: {content[:200]!r}", raw={"raw_content": content})

        try:
            parsed = json.loads(match.group(0))
            score = float(parsed.get("score"))
            rationale = str(parsed.get("rationale", ""))
        except (json.JSONDecodeError, TypeError, ValueError) as e:
            return ScoreResult(score=None, rationale=f"Could not parse judge JSON: {e}", raw={"raw_content": content})

        return ScoreResult(score=score, label=f"{score:g}/10", rationale=rationale, raw=parsed)
