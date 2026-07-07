from typing import Any, Literal
from pydantic import BaseModel


# ── Chat proxy (persisted) ──────────────────────────────────────────────────

class ChatOptions(BaseModel):
    temperature: float | None = None
    top_p: float | None = None
    top_k: int | None = None
    repeat_penalty: float | None = None
    num_predict: int | None = None
    num_ctx: int | None = None
    seed: int | None = None


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    conversation_id: str | None = None
    model: str
    messages: list[ChatMessage]
    stream: bool = True
    think: bool | str = False
    options: ChatOptions = ChatOptions()


# ── Eval generate (persisted into eval_items, not conversations) ───────────

class EvalGenerateRequest(BaseModel):
    run_id: str
    item_index: int
    side: Literal["a", "b"]
    model: str
    messages: list[ChatMessage]
    stream: bool = True
    think: bool | str = False
    options: ChatOptions = ChatOptions()


# ── Model management ─────────────────────────────────────────────────────────

class PullRequest(BaseModel):
    name: str
    stream: bool = True


class DeleteRequest(BaseModel):
    name: str


# ── Conversations ────────────────────────────────────────────────────────────

class ConversationSummary(BaseModel):
    id: str
    title: str | None
    model: str | None
    updated_at: str


class MessageOut(BaseModel):
    role: str
    content: str
    thinking: str | None = None
    stats: dict[str, Any] | None = None


class ConversationDetail(BaseModel):
    id: str
    title: str | None
    model: str | None
    system_prompt: str | None
    updated_at: str
    messages: list[MessageOut]


# ── Eval runs — axis-generic sweeps ─────────────────────────────────────────
#
# "Config A / Config B" is gone. A run now sweeps N axes (any parameter,
# including model itself) and materializes the cartesian product as cells.
# See KNOWN_AXIS_PARAMS below for what's actually resolvable into an Ollama
# (or hosted-baseline) request.

# Every flat key that's allowed to appear in an axis's `param` or in
# base_config. Deliberately closed rather than "any string the frontend sends"
# — an axis on a typo'd param name should fail loudly at run-creation time,
# not silently no-op three sweeps in.
KNOWN_AXIS_PARAMS = {
    "model", "think", "system_prompt",
    "temperature", "top_p", "top_k", "repeat_penalty", "num_predict", "num_ctx", "seed",
}

# The subset that maps directly onto Ollama's `options` object once resolved.
OLLAMA_OPTION_PARAMS = {
    "temperature", "top_p", "top_k", "repeat_penalty", "num_predict", "num_ctx", "seed",
}


class Axis(BaseModel):
    param: str
    values: list[Any]


class HostedBaselineConfig(BaseModel):
    endpoint: str
    model: str
    api_key: str | None = None


class CreateSweepRequest(BaseModel):
    id: str
    axes: list[Axis]
    base_config: dict[str, Any]
    prompts: list[str]
    repeat_count: int = 1
    hosted_baseline: HostedBaselineConfig | None = None


class EvalCellOut(BaseModel):
    cell_index: int
    config: dict[str, Any]   # this cell's axis-value overrides only, not the full resolved config
    is_baseline: bool = False


class CreateSweepResponse(BaseModel):
    id: str
    cells: list[EvalCellOut]
    prompt_count: int
    repeat_count: int


class PatchEvalRunRequest(BaseModel):
    status: Literal["running", "done", "stopped"]


class EvalGenerateRequest(BaseModel):
    run_id: str
    cell_index: int
    prompt_index: int
    repeat_index: int = 0
    stream: bool = True


class EvalRunSummary(BaseModel):
    id: str
    axes: list[Axis]
    base_config: dict[str, Any]
    repeat_count: int
    hosted_baseline: HostedBaselineConfig | None = None
    status: str
    cell_count: int
    prompt_count: int
    updated_at: str


class EvalResultOut(BaseModel):
    cell_index: int
    prompt_index: int
    repeat_index: int
    status: str
    response: str | None = None
    thinking: str | None = None
    stats: dict[str, Any] | None = None
    error: str | None = None


class JudgmentOut(BaseModel):
    cell_index: int
    prompt_index: int
    repeat_index: int | None   # None = a set-level metric (e.g. repeat variance), not one generation
    scorer_name: str
    score: float | None
    label: str | None
    rationale: str | None


class EvalRunDetail(BaseModel):
    id: str
    axes: list[Axis]
    base_config: dict[str, Any]
    repeat_count: int
    hosted_baseline: HostedBaselineConfig | None = None
    status: str
    prompts: list[str]
    cells: list[EvalCellOut]
    results: list[EvalResultOut]
    judgments: list[JudgmentOut]   # ALL judgments across ALL scorers ever run on this run —
                                   # the grid recolors client-side by picking which scorer_name to
                                   # aggregate, so switching metrics never needs a new request.


# ── Scoring ──────────────────────────────────────────────────────────────────

class ScorerInfo(BaseModel):
    name: str
    description: str
    requires_reference: bool = False
    supports_model_override: bool = False


class ScoreRunRequest(BaseModel):
    # AI Evaluation (see app/scoring/ai_eval.py for the canonical dimension
    # list/order): which of completeness / correctness / hallucination_risk
    # to grade. Replaces the old single `scorer_name` string now that the
    # scoring UI is one judge-model call covering N checked dimensions
    # instead of picking one scorer from a registry.
    dimensions: list[str]
    # Judge model for this scoring pass — None means "use ai_eval's own
    # default judge model".
    model: str | None = None


class ScoreRunResponse(BaseModel):
    # Every judgment this one request produced: one row per (generation,
    # requested dimension), plus — when the run's repeat_count >= 2 — one
    # extra row per (cell, prompt, dimension) holding that dimension's
    # repeat-variance, distinguishable by its "<scorer_name>:variance" name
    # and its repeat_index of None. See eval.py's score_run().
    #
    # NOTE: /api/eval/runs/{run_id}/score streams NDJSON now (progress lines
    # + one final line), not a single JSON body — this model documents the
    # shape of that final `{"type": "done", "judgments": [...]}` line's
    # "judgments" field, not the whole HTTP response.
    judgments: list[JudgmentOut]

