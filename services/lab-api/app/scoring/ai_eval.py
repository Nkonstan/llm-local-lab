"""
AI Evaluation — the judge behind the Eval Harness's "AI Evaluation" panel.

Deliberately NOT a registry Scorer (see base.py / __init__.py): the old
"pick one scorer from a dropdown" model doesn't fit a bespoke multi-checkbox
UI that always fires exactly one combined judge-model call covering however
many of the three dimensions (Completeness, Correctness, Hallucination Risk)
are checked. Rather than force this into the Scorer ABC — which scores one
dimension per call — this lives as its own small module next to the
registry-based scorers, called directly by eval.py's score_run().

response-length and refusal-check (length_metric.py, refusal_check.py) stay
registered in the registry as extension-pattern examples for a future
scorer that DOES fit the one-scorer-per-call shape; this module is the
example for one that doesn't.
"""

import json
import os
import re

from .. import ollama_proxy
from ..config import settings

# Fallback used only if a caller doesn't supply a judge model at all (the
# frontend always does, since the AI Evaluation panel pre-selects one) — see
# eval.py's score_run() / models.py's ScoreRunRequest.model. Same JUDGE_MODEL
# env var the old single-scorer llm-judge used, just with a new default.
DEFAULT_JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "qwen3.5:9b")

# Canonical dimension keys AND their canonical order — every rubric, every
# stored scorer_name, and every request-validation error message derives
# from this one list. `hallucination_risk` matches the exact spelling used
# in llm-judge:hallucination_risk (see scorer_name() below).
DIMENSIONS = ["completeness", "correctness", "hallucination_risk"]

# (display label, instruction text). Four dimension sets were tried before
# landing on these three — see the design brief for why "Quality" and a
# "Reasoning" dimension were dropped, and why Correctness/Hallucination Risk
# are scoped the way they are below (so a response can be independently
# high/low on each: correct code that cites a fabricated function name in
# its own explanation is high-Correctness AND high-Hallucination-Risk at
# once).
_DIMENSION_INFO = {
    "completeness": (
        "Completeness",
        "Does the response address everything the prompt asked for, with nothing left "
        "out? This is about BREADTH, not accuracy — a response can fully and correctly "
        "answer only part of a multi-part question and still be INCOMPLETE overall "
        "because other parts went unaddressed. Score 1 (major parts of the ask are "
        "missing) to 10 (nothing asked for was left out). Return null if there is "
        "nothing for completeness to measure here — e.g. a single-part question with "
        "no sub-parts to leave out.",
    ),
    "correctness": (
        "Correctness",
        "Is the core answer/conclusion/solution itself right, given what was actually "
        "asked? Judge ONLY the main deliverable — the actual answer, the code's actual "
        "behavior, the direct factual claim — not incidental details or extra content "
        "around it. Score 1 (the core answer is wrong) to 10 (the core answer is fully "
        "right). Return null if there is no checkable core answer or claim at all.",
    ),
    "hallucination_risk": (
        "Hallucination Risk",
        "Does the response state anything as fact that appears fabricated or "
        "unverifiable — in the core answer OR in incidental supporting details — "
        "regardless of whether the core answer itself is right? IMPORTANT: this "
        "dimension's scale is INVERTED versus the other two — score 1 (no fabricated "
        "or unverifiable claims found; very low risk) to 10 (heavily fabricated or "
        "unverifiable; very high risk). Return null if the response asserts no "
        "checkable facts at all — e.g. a poem, a pure opinion, a request for "
        "clarification.",
    ),
}

_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def scorer_name(dimension: str) -> str:
    """The judgments.scorer_name value a dimension is stored under, e.g.
    'llm-judge:completeness'. Each dimension becomes its own independent
    metric in the grid's generic scorer-name-based "Color by" discovery —
    no per-dimension frontend code needed for that part."""
    return f"llm-judge:{dimension}"


def build_rubric(*, prompt: str, response: str, dimensions: list[str]) -> str:
    """Builds the judge prompt from ONLY the requested dimensions, in
    canonical order — a dimension the user didn't check is never mentioned,
    per the spec."""
    ordered = [d for d in DIMENSIONS if d in dimensions]
    dims_block = "\n\n".join(
        f'"{d}" — {_DIMENSION_INFO[d][0]}: {_DIMENSION_INFO[d][1]}' for d in ordered
    )
    scores_shape = ", ".join(f'"{d}": <1-10 integer or null>' for d in ordered)
    return f"""You are grading a single AI assistant response along {len(ordered)} \
dimension(s). For each dimension below, follow its own instructions exactly, \
including which direction is better — they are not all the same direction. Use \
null (not a number) whenever a dimension genuinely does not apply to this \
prompt/response pair; null is a valid, expected answer for some prompts, not a \
fallback for uncertainty.

{dims_block}

Respond with ONLY a JSON object of the exact shape {{"scores": {{{scores_shape}}}, \
"rationale": "<one shared paragraph explaining every dimension you scored>"}} and \
nothing else — no markdown, no extra text.

Prompt:
{prompt}

Response:
{response}
"""


async def judge_dimensions(
    *, prompt: str, response: str, model: str | None, dimensions: list[str]
) -> tuple[dict[str, float | None], str | None, str | None]:
    """One combined judge-model call covering every requested dimension —
    deliberately never one call per dimension, to keep cost bounded no
    matter how many are checked.

    Returns (scores_by_dimension, rationale, error):
      - scores_by_dimension always has an entry for every dimension in
        `dimensions`; a value of None is a legitimate "not applicable"
        answer from the judge, not a failure.
      - error is set only when the whole call/parse failed outright, in
        which case every dimension's score is None and rationale is None —
        callers should surface `error` as that judgment's rationale instead
        (see eval.py's score_run()), matching how the old LlmJudgeScorer
        reported failures.
    """
    judge_model = model or DEFAULT_JUDGE_MODEL
    empty_scores: dict[str, float | None] = {d: None for d in dimensions}

    if not response:
        return empty_scores, None, "Response was empty — nothing to judge."

    body = {
        "model": judge_model,
        "messages": [
            {"role": "user", "content": build_rubric(prompt=prompt, response=response, dimensions=dimensions)}
        ],
        "stream": False,
        "think": False,
        # num_predict: without an explicit cap, Ollama falls back to its own
        # default, which real-world logs showed was occasionally cutting the
        # judge off ONE TOKEN before its closing "}" — always right after a
        # fully-formed "scores"+"rationale" body, never mid-word. 600 gives
        # a multi-paragraph rationale comfortable headroom to actually finish.
        "options": {"temperature": 0.0, "num_predict": 600},
        # Grammar-constrained JSON decoding — without this, the judge is
        # free-texting JSON, and for longer/messier responses (markdown
        # bullets, code, quoted text) it reliably produces almost-JSON with
        # one unescaped quote or stray character that breaks json.loads.
        # Ollama enforces valid JSON syntax at the sampler level when this
        # is set, regardless of which model is doing the judging.
        "format": "json",
    }
    try:
        async with ollama_proxy.make_client() as client:
            res = await client.post(f"{settings.ollama_base_url}/api/chat", json=body)
            res.raise_for_status()
            data = res.json()
    except Exception as e:
        return empty_scores, None, f"Judge model call failed: {e}"

    content = (data.get("message") or {}).get("content", "")

    # ── DIAGNOSTIC LOGGING (temporary — remove once the parse-failure cause
    # is confirmed) — always print the judge's raw output so it's visible
    # live in `docker logs -f lab-api` without needing to trigger a run,
    # export JSON, and read it back.
    print(f"[ai-eval] judge={judge_model} dims={dimensions} raw content ({len(content)} chars): {content!r}", flush=True)

    # Some models wrap JSON in a markdown code fence out of habit even when
    # asked not to (and even under format:"json", on Ollama versions that
    # apply the grammar constraint loosely) — strip that before parsing so
    # it doesn't cause an avoidable failure.
    stripped = content.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z]*\n?", "", stripped)
        stripped = re.sub(r"```$", "", stripped).strip()

    # format:"json" means `stripped` should already be exactly one JSON
    # value with no surrounding prose — try that directly first.
    try:
        parsed = json.loads(stripped)
    except (json.JSONDecodeError, TypeError, ValueError):
        parsed = None

        # Real-world logs showed the dominant failure mode isn't malformed
        # JSON at all — it's TRUNCATED JSON: the judge writes the full
        # {"scores": {...}, "rationale": "..." body correctly and simply
        # never emits the final closing "}" (almost always a token-budget
        # cutoff one token too early). Repair that by trying to append the
        # missing brace(s) before falling back to the brace-extraction
        # regex below, which would otherwise silently discard everything
        # after the LAST "}" actually present — i.e. the entire rationale.
        for repair_suffix in ('"}', '}', '"}}', '}}'):
            try:
                parsed = json.loads(stripped + repair_suffix)
                print(f"[ai-eval] repaired truncated JSON by appending {repair_suffix!r}", flush=True)
                break
            except (json.JSONDecodeError, TypeError, ValueError):
                continue

    if parsed is None:
        # Still not valid even after the repair attempt — fall back to the
        # old brace-extraction regex for any judge model/Ollama version
        # that wraps the JSON in surrounding prose despite `format`.
        match = _JSON_RE.search(stripped)
        if not match:
            print(f"[ai-eval] FAILED — no JSON object found at all", flush=True)
            return empty_scores, None, f"Judge did not return parseable JSON: {content[:300]!r}"
        try:
            parsed = json.loads(match.group(0))
        except (json.JSONDecodeError, TypeError, ValueError) as e:
            # Include what the judge actually said, not just the exception —
            # without this, a parse failure is undiagnosable from the
            # exported judgments alone (see e.g. char-position-only errors
            # like "Expecting ',' delimiter: line 1 column 75").
            print(f"[ai-eval] FAILED — {e}", flush=True)
            return empty_scores, None, f"Could not parse judge JSON ({e}): {content[:300]!r}"

    raw_scores = parsed.get("scores") or {}
    rationale = str(parsed.get("rationale") or "") or None

    scores: dict[str, float | None] = {}
    for d in dimensions:
        v = raw_scores.get(d)
        if v is None:
            scores[d] = None
        else:
            try:
                scores[d] = float(v)
            except (TypeError, ValueError):
                scores[d] = None
    return scores, rationale, None
