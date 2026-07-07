import os
import aiosqlite
from contextlib import asynccontextmanager

from .config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    model TEXT,
    system_prompt TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT,
    thinking TEXT,
    stats_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

-- ── Eval Harness v2: axis-generic sweeps ────────────────────────────────────
-- Replaces the old two-column (config_a/config_b, a_json/b_json) schema.
-- The one-time DROP of the old eval_runs/judgments/eval_items tables lives in
-- MIGRATION_V2 below, gated by PRAGMA user_version, so it runs exactly once
-- per database — NOT on every startup (see init_db()). This block only ever
-- creates the current tables; it never drops anything.

-- One row per sweep. Axes + fixed (non-swept) params are stored once here,
-- not repeated per cell — a cell only ever stores what varies (see
-- eval_cells.config_json below).
CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY,
    axes_json TEXT NOT NULL,          -- ordered list: [{"param": "model", "values": [...]}, ...]
    base_config_json TEXT NOT NULL,   -- every param NOT in axes_json, fixed across all cells
    repeat_count INTEGER NOT NULL DEFAULT 1,
    hosted_baseline_json TEXT,        -- nullable: {"endpoint": "...", "model": "..."} for the one optional baseline cell
    status TEXT NOT NULL DEFAULT 'running',   -- running | done | stopped
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Prompt dataset, normalized out so a 25-cell run doesn't store the same
-- prompt text 25 times.
CREATE TABLE IF NOT EXISTS eval_run_prompts (
    run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
    prompt_index INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    PRIMARY KEY (run_id, prompt_index)
);

-- One row per point in the cartesian product, plus one more if
-- hosted_baseline_json is set. Materialized rather than decoded on the fly
-- from cell_index, so every consumer (grid API, export, hosted-baseline
-- lookup) reads the same simple table instead of re-implementing a
-- mixed-radix decode of axes_json.
CREATE TABLE IF NOT EXISTS eval_cells (
    run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
    cell_index INTEGER NOT NULL,
    config_json TEXT NOT NULL,   -- ONLY this cell's axis-value overrides, e.g. {"model": "qwen3:2b", "temperature": 0.8}
    is_baseline INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, cell_index)
);

-- One row per (cell × prompt × repeat) generation — the hot table. A 5×5
-- grid over 20 prompts is 500 rows here, not 500 duplicated prompt strings
-- (those live once in eval_run_prompts) and not 25 duplicated configs
-- (those live once in eval_cells).
CREATE TABLE IF NOT EXISTS eval_results (
    run_id TEXT NOT NULL,
    cell_index INTEGER NOT NULL,
    prompt_index INTEGER NOT NULL,
    repeat_index INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | error
    response TEXT,
    thinking TEXT,
    stats_json TEXT,   -- same shape as compute_stats() produces today (ttft, tokensPerSec, evalCount, ...)
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, cell_index, prompt_index, repeat_index),
    FOREIGN KEY (run_id, cell_index) REFERENCES eval_cells(run_id, cell_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_eval_results_prompt ON eval_results(run_id, prompt_index);

-- Judgments stay a separate table from raw results, same reasoning as
-- before: re-scoring a run with a new/improved judge is an INSERT here, not
-- a mutation of eval_results, and multiple scorers can coexist on one run.
-- Widened from (item_index, side) to (cell_index, prompt_index, repeat_index).
-- repeat_index is nullable on purpose: a normal per-generation judgment sets
-- it to match the eval_results row it scores, while a variance-across-repeats
-- metric writes one row per (cell, prompt) with repeat_index = NULL, meaning
-- "describes the whole repeat-set" rather than one draw. This overloads the
-- column's meaning slightly rather than adding a parallel
-- eval_variance_metrics table.
--
-- scorer_name being free text (not an enum/foreign key) is what let the AI
-- Evaluation feature (app/scoring/ai_eval.py) land with NO schema change:
-- each checked dimension is stored under its own name
-- ("llm-judge:completeness", "llm-judge:correctness",
-- "llm-judge:hallucination_risk"), and that dimension's own repeat-variance
-- reuses the exact same NULL-repeat_index convention above under
-- "<dimension's scorer_name>:variance" — e.g. "llm-judge:completeness:variance".
-- The grid's "Color by" dropdown discovers all of these generically from
-- whatever scorer_name values exist on a run; no per-dimension code needed
-- there.
CREATE TABLE IF NOT EXISTS judgments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    cell_index INTEGER NOT NULL,
    prompt_index INTEGER NOT NULL,
    repeat_index INTEGER,
    scorer_name TEXT NOT NULL,
    score REAL,
    label TEXT,
    rationale TEXT,
    raw_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_judgments_run_cell ON judgments(run_id, cell_index, prompt_index);
"""

# Bump this when a change needs a one-time destructive migration (like the
# rewrite below). init_db() only ever runs MIGRATION_V2 while the database's
# PRAGMA user_version is behind this number, then advances it — so the drop
# happens once per database, not once per process start.
SCHEMA_VERSION = 2

# One-time migration: drops the old two-column (config_a/config_b, a_json/
# b_json) eval schema so the axis-generic tables above can be created clean.
# This is a personal research tool, not a multi-tenant service, so there's no
# migration path from "two hardcoded sides" to "N axes" worth preserving old
# run rows for — but it must only run once. Previously this ran unconditionally
# on every startup (via executescript(SCHEMA)), which silently wiped every
# eval run, cell, prompt, and judgment on every restart because
# eval_cells/eval_run_prompts/eval_results all have ON DELETE CASCADE foreign
# keys onto eval_runs, and SQLite performs an implicit cascading delete before
# DROP TABLE when foreign_keys is on. Gating on PRAGMA user_version fixes that:
# a fresh database migrates once (dropping nothing, since the old tables never
# existed) and a database that's already current is never touched by this
# block again.
MIGRATION_V2 = """
DROP TABLE IF EXISTS judgments;
DROP TABLE IF EXISTS eval_items;
DROP TABLE IF EXISTS eval_runs;
"""


async def init_db():
    os.makedirs(os.path.dirname(settings.db_path) or ".", exist_ok=True)
    async with aiosqlite.connect(settings.db_path) as db:
        await db.execute("PRAGMA foreign_keys = ON")

        cur = await db.execute("PRAGMA user_version")
        row = await cur.fetchone()
        current_version = row[0] if row else 0

        if current_version < SCHEMA_VERSION:
            await db.executescript(MIGRATION_V2)
            await db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

        await db.executescript(SCHEMA)
        await db.commit()


@asynccontextmanager
async def get_db():
    db = await aiosqlite.connect(settings.db_path)
    db.row_factory = aiosqlite.Row
    try:
        await db.execute("PRAGMA foreign_keys = ON")
        yield db
    finally:
        await db.close()