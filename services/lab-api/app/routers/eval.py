import asyncio
import itertools
import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..models import (
    Axis, HostedBaselineConfig, KNOWN_AXIS_PARAMS, OLLAMA_OPTION_PARAMS,
    CreateSweepRequest, CreateSweepResponse, EvalCellOut,
    PatchEvalRunRequest, EvalGenerateRequest,
    EvalRunSummary, EvalRunDetail, EvalResultOut, JudgmentOut,
    ScorerInfo, ScoreRunRequest,
)
from ..db import get_db
from ..config import settings
from ..ollama_proxy import open_ollama_stream, close_ollama_stream, accumulate_line, compute_stats, OllamaError
from ..hosted_proxy import stream_hosted_chat, HostedError
from ..scoring import registry
from ..scoring.ai_eval import DIMENSIONS as AI_EVAL_DIMENSIONS, scorer_name as ai_eval_scorer_name, judge_dimensions


router = APIRouter()

# Bounded concurrency for THIS router only (see config.eval_max_concurrency's
# docstring) — a sweep's cell x prompt x repeat count can be in the hundreds;
# without this, every one of them would hit Ollama at once. /api/chat
# (chat.py, Lab UI) is untouched and keeps calling open_ollama_stream()
# directly with no limit, exactly as before this redesign.
_ollama_semaphore = asyncio.Semaphore(settings.eval_max_concurrency)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Sweep creation: axes -> materialized cartesian-product cells ───────────

def _validate_params(names: set[str]) -> None:
    unknown = names - KNOWN_AXIS_PARAMS
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown parameter(s) {sorted(unknown)} — must be one of {sorted(KNOWN_AXIS_PARAMS)}",
        )


def _build_cells(axes: list[Axis]) -> list[dict[str, Any]]:
    """The cartesian product, materialized as one config dict per cell. Order
    matches itertools.product: the last axis varies fastest. Each cell's
    config holds ONLY the values that vary — never the full resolved config
    — matching eval_cells.config_json's documented shape in db.py."""
    if not axes:
        return [{}]
    value_lists = [axis.values for axis in axes]
    if any(len(v) == 0 for v in value_lists):
        raise HTTPException(status_code=400, detail="Every axis needs at least one value")
    param_names = [axis.param for axis in axes]
    return [dict(zip(param_names, combo)) for combo in itertools.product(*value_lists)]


@router.post("/api/eval/runs", response_model=CreateSweepResponse)
async def create_sweep(req: CreateSweepRequest):
    axis_params = [a.param for a in req.axes]
    if len(axis_params) != len(set(axis_params)):
        raise HTTPException(status_code=400, detail="Each parameter can only be swept as one axis")
    _validate_params(set(axis_params) | set(req.base_config.keys()))
    if "model" not in axis_params and "model" not in req.base_config:
        raise HTTPException(status_code=400, detail="model must be set, either as an axis or in base_config")
    if req.repeat_count < 1:
        raise HTTPException(status_code=400, detail="repeat_count must be at least 1")
    if not req.prompts:
        raise HTTPException(status_code=400, detail="Need at least one prompt")

    cell_configs = _build_cells(req.axes)
    now = _now()

    async with get_db() as db:
        await db.execute(
            """INSERT INTO eval_runs
                 (id, axes_json, base_config_json, repeat_count, hosted_baseline_json, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'running', ?, ?)""",
            (
                req.id,
                json.dumps([a.model_dump() for a in req.axes]),
                json.dumps(req.base_config),
                req.repeat_count,
                json.dumps(req.hosted_baseline.model_dump()) if req.hosted_baseline else None,
                now, now,
            ),
        )
        for i, prompt in enumerate(req.prompts):
            await db.execute(
                "INSERT INTO eval_run_prompts (run_id, prompt_index, prompt) VALUES (?, ?, ?)",
                (req.id, i, prompt),
            )

        cells_out: list[EvalCellOut] = []
        cell_index = 0
        for cfg in cell_configs:
            await db.execute(
                "INSERT INTO eval_cells (run_id, cell_index, config_json, is_baseline) VALUES (?, ?, ?, 0)",
                (req.id, cell_index, json.dumps(cfg)),
            )
            cells_out.append(EvalCellOut(cell_index=cell_index, config=cfg, is_baseline=False))
            cell_index += 1

        if req.hosted_baseline is not None:
            baseline_cfg = {"model": req.hosted_baseline.model}
            await db.execute(
                "INSERT INTO eval_cells (run_id, cell_index, config_json, is_baseline) VALUES (?, ?, ?, 1)",
                (req.id, cell_index, json.dumps(baseline_cfg)),
            )
            cells_out.append(EvalCellOut(cell_index=cell_index, config=baseline_cfg, is_baseline=True))
            cell_index += 1

        await db.commit()

    return CreateSweepResponse(
        id=req.id, cells=cells_out, prompt_count=len(req.prompts), repeat_count=req.repeat_count,
    )


@router.patch("/api/eval/runs/{run_id}")
async def patch_eval_run(run_id: str, req: PatchEvalRunRequest):
    now = _now()
    async with get_db() as db:
        await db.execute(
            "UPDATE eval_runs SET status = ?, updated_at = ? WHERE id = ?",
            (req.status, now, run_id),
        )
        await db.commit()
    return {"id": run_id, "status": req.status}


@router.get("/api/eval/runs", response_model=list[EvalRunSummary])
async def list_eval_runs():
    async with get_db() as db:
        cur = await db.execute(
            """SELECT r.id, r.axes_json, r.base_config_json, r.repeat_count, r.hosted_baseline_json,
                      r.status, r.updated_at,
                      (SELECT COUNT(*) FROM eval_cells c WHERE c.run_id = r.id) AS cell_count,
                      (SELECT COUNT(*) FROM eval_run_prompts p WHERE p.run_id = r.id) AS prompt_count
               FROM eval_runs r ORDER BY r.updated_at DESC"""
        )
        rows = await cur.fetchall()
    return [
        EvalRunSummary(
            id=row["id"],
            axes=[Axis(**a) for a in json.loads(row["axes_json"])],
            base_config=json.loads(row["base_config_json"]),
            repeat_count=row["repeat_count"],
            hosted_baseline=HostedBaselineConfig(**json.loads(row["hosted_baseline_json"])) if row["hosted_baseline_json"] else None,
            status=row["status"],
            cell_count=row["cell_count"],
            prompt_count=row["prompt_count"],
            updated_at=row["updated_at"],
        )
        for row in rows
    ]


@router.get("/api/eval/runs/{run_id}", response_model=EvalRunDetail)
async def get_eval_run(run_id: str):
    async with get_db() as db:
        cur = await db.execute(
            "SELECT id, axes_json, base_config_json, repeat_count, hosted_baseline_json, status FROM eval_runs WHERE id = ?",
            (run_id,),
        )
        run_row = await cur.fetchone()
        if run_row is None:
            raise HTTPException(status_code=404, detail="Run not found")

        cur = await db.execute(
            "SELECT prompt_index, prompt FROM eval_run_prompts WHERE run_id = ? ORDER BY prompt_index", (run_id,)
        )
        prompt_rows = await cur.fetchall()

        cur = await db.execute(
            "SELECT cell_index, config_json, is_baseline FROM eval_cells WHERE run_id = ? ORDER BY cell_index", (run_id,)
        )
        cell_rows = await cur.fetchall()

        cur = await db.execute(
            """SELECT cell_index, prompt_index, repeat_index, status, response, thinking, stats_json, error
               FROM eval_results WHERE run_id = ? ORDER BY cell_index, prompt_index, repeat_index""",
            (run_id,),
        )
        result_rows = await cur.fetchall()

        cur = await db.execute(
            """SELECT cell_index, prompt_index, repeat_index, scorer_name, score, label, rationale
               FROM judgments WHERE run_id = ? ORDER BY id""",
            (run_id,),
        )
        judgment_rows = await cur.fetchall()

    return EvalRunDetail(
        id=run_row["id"],
        axes=[Axis(**a) for a in json.loads(run_row["axes_json"])],
        base_config=json.loads(run_row["base_config_json"]),
        repeat_count=run_row["repeat_count"],
        hosted_baseline=HostedBaselineConfig(**json.loads(run_row["hosted_baseline_json"])) if run_row["hosted_baseline_json"] else None,
        status=run_row["status"],
        prompts=[r["prompt"] for r in prompt_rows],
        cells=[EvalCellOut(cell_index=r["cell_index"], config=json.loads(r["config_json"]), is_baseline=bool(r["is_baseline"])) for r in cell_rows],
        results=[
            EvalResultOut(
                cell_index=r["cell_index"], prompt_index=r["prompt_index"], repeat_index=r["repeat_index"],
                status=r["status"], response=r["response"], thinking=r["thinking"],
                stats=json.loads(r["stats_json"]) if r["stats_json"] else None, error=r["error"],
            )
            for r in result_rows
        ],
        judgments=[
            JudgmentOut(
                cell_index=r["cell_index"], prompt_index=r["prompt_index"], repeat_index=r["repeat_index"],
                scorer_name=r["scorer_name"], score=r["score"], label=r["label"], rationale=r["rationale"],
            )
            for r in judgment_rows
        ],
    )


# ── Config resolution ────────────────────────────────────────────────────────

async def _load_resolved(db, run_id: str, cell_index: int, prompt_index: int):
    """Loads and merges base_config + this cell's overrides, and looks up the
    prompt text — the single source of truth for what a generation actually
    sends, so the client only ever needs to say WHICH cell/prompt, never
    reconstruct the resolved options itself."""
    cur = await db.execute(
        "SELECT base_config_json, hosted_baseline_json FROM eval_runs WHERE id = ?", (run_id,)
    )
    run_row = await cur.fetchone()
    if run_row is None:
        raise HTTPException(status_code=404, detail="Run not found")

    cur = await db.execute(
        "SELECT config_json, is_baseline FROM eval_cells WHERE run_id = ? AND cell_index = ?",
        (run_id, cell_index),
    )
    cell_row = await cur.fetchone()
    if cell_row is None:
        raise HTTPException(status_code=404, detail="Cell not found")

    cur = await db.execute(
        "SELECT prompt FROM eval_run_prompts WHERE run_id = ? AND prompt_index = ?",
        (run_id, prompt_index),
    )
    prompt_row = await cur.fetchone()
    if prompt_row is None:
        raise HTTPException(status_code=404, detail="Prompt not found")

    base_config = json.loads(run_row["base_config_json"])
    cell_config = json.loads(cell_row["config_json"])
    merged = {**base_config, **cell_config}
    is_baseline = bool(cell_row["is_baseline"])
    hosted_baseline = json.loads(run_row["hosted_baseline_json"]) if run_row["hosted_baseline_json"] else None

    model = merged.pop("model", None)
    if not model:
        raise HTTPException(status_code=400, detail="Resolved config has no model")
    think = merged.pop("think", False)
    system_prompt = merged.pop("system_prompt", None)
    options = {k: v for k, v in merged.items() if k in OLLAMA_OPTION_PARAMS}

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt_row["prompt"]})

    return {
        "model": model, "think": think, "options": options, "messages": messages,
        "is_baseline": is_baseline, "hosted_baseline": hosted_baseline,
    }


# ── Generation (persists into eval_results) ─────────────────────────────────

async def _persist_result(run_id: str, cell_index: int, prompt_index: int, repeat_index: int, model: str, collector: dict) -> None:
    stats = compute_stats(collector.get("final_chunk"), model)
    now = _now()
    status = "done" if collector.get("final_chunk") else "error"
    error = collector.get("error") or (None if collector.get("final_chunk") else "Stream ended without a final chunk")

    async with get_db() as db:
        await db.execute(
            """INSERT INTO eval_results
                 (run_id, cell_index, prompt_index, repeat_index, status, response, thinking, stats_json, error, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (run_id, cell_index, prompt_index, repeat_index) DO UPDATE SET
                 status = excluded.status, response = excluded.response, thinking = excluded.thinking,
                 stats_json = excluded.stats_json, error = excluded.error, updated_at = excluded.updated_at""",
            (
                run_id, cell_index, prompt_index, repeat_index, status,
                collector.get("full_content", ""), collector.get("full_thinking") or None,
                json.dumps(stats) if stats else None, error, now, now,
            ),
        )
        await db.execute("UPDATE eval_runs SET updated_at = ? WHERE id = ?", (now, run_id))
        await db.commit()


@router.post("/api/eval/generate")
async def eval_generate(req: EvalGenerateRequest):
    async with get_db() as db:
        resolved = await _load_resolved(db, req.run_id, req.cell_index, req.prompt_index)

    collector = {"full_content": "", "full_thinking": "", "final_chunk": None, "error": None}

    if resolved["is_baseline"]:
        hb = resolved["hosted_baseline"]
        if not hb:
            raise HTTPException(status_code=400, detail="Cell is marked baseline but run has no hosted_baseline configured")

        # Hosted calls aren't bound by _ollama_semaphore (that's specifically
        # about protecting one local Ollama instance) — item 6 is a single
        # reference cell, never more than one per sweep, so there's no
        # meaningful pile-up to guard against here.
        async def gen():
            try:
                async for line in stream_hosted_chat(hb["endpoint"], hb.get("api_key"), resolved["model"], resolved["messages"], resolved["options"]):
                    yield line
                    accumulate_line(collector, line)
            except HostedError as e:
                collector["error"] = e.detail
            finally:
                await _persist_result(req.run_id, req.cell_index, req.prompt_index, req.repeat_index, resolved["model"], collector)

        return StreamingResponse(gen(), media_type="application/x-ndjson")

    body = {
        "model": resolved["model"],
        "messages": resolved["messages"],
        "stream": req.stream,
        "think": resolved["think"],
        "options": resolved["options"],
    }

    # IMPORTANT: the semaphore has to be held from before open_ollama_stream()
    # (the actual network call that puts a job in Ollama's queue) all the way
    # through to the end of the streamed response — NOT just around this
    # setup. An `async with` scoped to this function would release the moment
    # this function returns the StreamingResponse object, which happens
    # before Starlette has actually driven gen() to completion — i.e. it
    # would release immediately and every cell would still fire at once. So
    # this acquires manually here and releases inside gen()'s finally block,
    # once the stream is fully drained and persisted. Verified with a test
    # that fires N concurrent generations and asserts peak in-flight count
    # against EVAL_MAX_CONCURRENCY — a bug in this exact spot slipped through
    # a first pass that only *looked* right.
    await _ollama_semaphore.acquire()
    try:
        client, stream_cm, response = await open_ollama_stream("/api/chat", body)
    except OllamaError as e:
        _ollama_semaphore.release()
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    except BaseException:
        _ollama_semaphore.release()
        raise

    async def gen():
        try:
            async for line in response.aiter_lines():
                if not line:
                    continue
                yield line + "\n"
                accumulate_line(collector, line)
        finally:
            await close_ollama_stream(client, stream_cm)
            await _persist_result(req.run_id, req.cell_index, req.prompt_index, req.repeat_index, resolved["model"], collector)
            _ollama_semaphore.release()

    return StreamingResponse(gen(), media_type="application/x-ndjson")


# ── Scoring ──────────────────────────────────────────────────────────────────

@router.get("/api/scorers", response_model=list[ScorerInfo])
async def list_scorers():
    return [
        ScorerInfo(name=s.name, description=s.description, requires_reference=s.requires_reference,
                   supports_model_override=s.supports_model_override)
        for s in registry.list()
    ]


@router.post("/api/eval/runs/{run_id}/score")
async def score_run(run_id: str, req: ScoreRunRequest):
    """AI Evaluation: one combined judge-model call per generation, covering
    whichever of the three dimensions were checked - never one call per
    dimension, to keep cost bounded regardless of selection. Each dimension
    is stored under its own scorer_name (see ai_eval.scorer_name()) so it
    becomes its own independent "Color by" option automatically.

    Repeat-variance (item 5) is computed as part of this SAME request right
    below, whenever the run's repeat_count >= 2 - not a second network call
    the frontend has to make, specifically so a variance failure can never
    silently strand the user without the variance they expected.

    TRANSPORT: streaming NDJSON, not a single JSON body (redesign item 2,
    option (a) - chosen over an indeterminate spinner because a real N-of-
    Total counter is worth more to the user, and /api/eval/generate already
    established the NDJSON-over-StreamingResponse pattern this mirrors). One
    `{"type": "progress", ...}` line is emitted after each generation is
    judged; the stream always ends with exactly one
    `{"type": "done", "judgments": [...]}` line carrying the COMPLETE
    judgments list for this pass (per-generation scores + variance rows),
    same shape the old single-response body used to return - so a client
    that only reads the final line still gets everything it used to.
    """
    requested = set(req.dimensions)
    unknown = requested - set(AI_EVAL_DIMENSIONS)
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown dimension(s) {sorted(unknown)} - must be one of {AI_EVAL_DIMENSIONS}",
        )
    dimensions = [d for d in AI_EVAL_DIMENSIONS if d in requested]
    if not dimensions:
        raise HTTPException(status_code=400, detail="Select at least one dimension to evaluate")

    async with get_db() as db:
        cur = await db.execute("SELECT repeat_count FROM eval_runs WHERE id = ?", (run_id,))
        run_row = await cur.fetchone()
        if run_row is None:
            raise HTTPException(status_code=404, detail="Run not found")
        repeat_count = run_row["repeat_count"]

        cur = await db.execute(
            """SELECT r.cell_index, r.prompt_index, r.repeat_index, r.response, p.prompt
               FROM eval_results r JOIN eval_run_prompts p
                 ON p.run_id = r.run_id AND p.prompt_index = r.prompt_index
               WHERE r.run_id = ? AND r.status = 'done'
               ORDER BY r.cell_index, r.prompt_index, r.repeat_index""",
            (run_id,),
        )
        rows = await cur.fetchall()

    if not rows:
        raise HTTPException(status_code=404, detail="Run has no completed generations to score yet")

    # All validation above still raises a normal HTTPException BEFORE any
    # streaming commits - a 400/404 here still looks like an ordinary error
    # response to the client, not a broken stream.

    async def gen():
        # Every judgment THIS request writes - the per-generation dimension
        # scores below, and the per-dimension variance rows further down -
        # shares this one timestamp. That's what lets the variance step
        # select exactly "what this pass just wrote" instead of accidentally
        # blending in an older AI Evaluation pass's scores if the user
        # re-scores this run later (possibly with a different judge model).
        batch_ts = _now()
        judgments: list[JudgmentOut] = []
        total = len(rows)

        async with get_db() as db:
            for i, row in enumerate(rows):
                scores, rationale, error = await judge_dimensions(
                    prompt=row["prompt"], response=row["response"] or "", model=req.model, dimensions=dimensions,
                )
                for dim in dimensions:
                    score = scores.get(dim)
                    name = ai_eval_scorer_name(dim)
                    label = f"{score:g}/10" if score is not None else None
                    row_rationale = error if error is not None else rationale
                    await db.execute(
                        """INSERT INTO judgments (run_id, cell_index, prompt_index, repeat_index, scorer_name, score, label, rationale, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            run_id, row["cell_index"], row["prompt_index"], row["repeat_index"], name,
                            score, label, row_rationale, batch_ts,
                        ),
                    )
                    judgments.append(JudgmentOut(
                        cell_index=row["cell_index"], prompt_index=row["prompt_index"], repeat_index=row["repeat_index"],
                        scorer_name=name, score=score, label=label, rationale=row_rationale,
                    ))
                await db.commit()
                yield json.dumps({"type": "progress", "completed": i + 1, "total": total}) + "\n"

        if repeat_count >= 2:
            judgments.extend(await _score_ai_eval_variance(run_id, dimensions, batch_ts))

        yield json.dumps({"type": "done", "judgments": [j.model_dump() for j in judgments]}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


# ── Repeat-run variance (item 5) ────────────────────────────────────────────
#
# Computed per dimension, independently — never blended into one number.
# Auto-triggered from score_run() above (no separate manual endpoint/button
# any more), scoped to exactly the judgments `batch_ts` just wrote via the
# created_at match below, so a later re-score never mixes two different
# judge passes' scores into one variance calculation.
#
# Deliberately NOT a registry Scorer, same reasoning as before this redesign:
# the Scorer ABC scores one (prompt, response) pair, but variance is a
# property of a *set* of per-dimension scores (the repeat_count draws for
# one cell+prompt+dimension), so it doesn't fit that interface.

async def _score_ai_eval_variance(run_id: str, dimensions: list[str], batch_ts: str) -> list[JudgmentOut]:
    names = [ai_eval_scorer_name(d) for d in dimensions]
    placeholders = ",".join("?" for _ in names)
    async with get_db() as db:
        cur = await db.execute(
            f"""SELECT cell_index, prompt_index, scorer_name, score FROM judgments
                WHERE run_id = ? AND created_at = ? AND scorer_name IN ({placeholders})""",
            (run_id, batch_ts, *names),
        )
        rows = await cur.fetchall()

    # Group by (cell, prompt, dimension) — never mixing dimensions together —
    # and skip null/not-applicable scores entirely rather than treating them
    # as zero (a dimension the judge marked N/A for one repeat shouldn't drag
    # that repeat's "score" to 0 in the variance math).
    groups: dict[tuple[int, int, str], list[float]] = {}
    for r in rows:
        if r["score"] is None:
            continue
        groups.setdefault((r["cell_index"], r["prompt_index"], r["scorer_name"]), []).append(r["score"])

    now = _now()
    out: list[JudgmentOut] = []
    async with get_db() as db:
        for (cell_index, prompt_index, name), scores in groups.items():
            # Only produce a variance value when at least 2 real scores
            # remain after null-filtering — a single data point would be a
            # misleading "0% variance" rather than an omission.
            if len(scores) < 2:
                continue
            mean = sum(scores) / len(scores)
            if mean == 0:
                cv = 0.0
            else:
                variance = sum((s - mean) ** 2 for s in scores) / len(scores)
                cv = (variance ** 0.5) / mean   # coefficient of variation, same approach as the old length-based repeat variance

            # Lower variance = more reliable = "better", universally — even
            # for Hallucination Risk, whose underlying SCORE is inverted
            # (higher score = worse). Variance itself is never inverted the
            # same way; that's handled purely by this naming convention
            # ("...:variance") on the frontend's isInverted(), not here.
            variance_name = f"{name}:variance"
            label = "stable" if cv < 0.15 else "variable"
            rationale = f"Coefficient of variation across {len(scores)} non-null repeat score(s): {cv:.3f}"
            await db.execute(
                """INSERT INTO judgments (run_id, cell_index, prompt_index, repeat_index, scorer_name, score, label, rationale, created_at)
                   VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)""",
                (run_id, cell_index, prompt_index, variance_name, cv, label, rationale, now),
            )
            out.append(JudgmentOut(
                cell_index=cell_index, prompt_index=prompt_index, repeat_index=None,
                scorer_name=variance_name, score=cv, label=label, rationale=rationale,
            ))
        await db.commit()

    return out
