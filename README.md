# LLM Local Lab

A self-hosted lab for running and comparing local LLMs — pick any [Ollama](https://ollama.com) model, tune generation parameters live, and see exactly how fast and how good the output is. Chat with one model, diff two side by side, or sweep a whole grid of models and parameters against a prompt set at once. Everything runs on your own hardware, GPU or CPU, with one command.

**Stack:** Ollama (inference) · Lab API (backend: proxy + persistence + scoring) · Lab App (Chat · A/B Diff · Eval Harness, one app) · [Open WebUI](https://github.com/open-webui/open-webui) (optional full chat UI)

---

## What's inside

- **Ollama** — runs the models. GPU or CPU, swappable with one flag.
- **Lab API** — the backend everything else talks to. Proxies requests to Ollama, persists conversations and eval runs to SQLite, and hosts a pluggable scoring registry.
- **Lab App** (`:3001`) — one app, three tabs: **Chat** (a chat interface built for experimentation: live parameter controls, per-response timing stats, conversation history), **A/B Diff** (comparing two configurations live), and **Eval Harness** (sweeping any number of parameters against a whole prompt dataset and scoring the results). Model management (pull/delete) is shared across all three from one "⚙ Manage Models" button. Switching between them is instant — a button toggle, not a page navigation — so a running Eval sweep keeps going in the background if you switch to Chat.
- **Open WebUI** — optional, if you want a full-featured chat client alongside the custom tools.

The browser never talks to Ollama directly. Lab App calls Lab API, which proxies to Ollama server-to-server and persists everything to SQLite — one backend, one CORS origin to configure, one place for chat history and eval results to live past a page refresh.

```
                          ┌──────────────┐
  Browser  ───────────▶  │   Lab App     │
                          │  Chat · Diff  │
                          │  · Eval (:3001)│
                          └──────┬────────┘
                                 │ HTTP
                                 ▼
                          ┌───────────────────┐
                          │      Lab API       │   (:8000)
                          │  proxy · persist ·  │
                          │  scorer registry    │
                          └─────┬───────────┬───┘
                                │           │
                                ▼           ▼
                          ┌─────────┐  ┌──────────┐
                          │ Ollama  │  │ SQLite   │
                          │ :11434  │  │ (volume) │
                          └─────────┘  └──────────┘
```

```
llm-local/
├── docker-compose.yml
├── docker-compose.gpu.yml
├── docker-compose.cpu.yml
├── docker-compose.lab.yml
├── docker-compose.webui.yml
├── services/
│   ├── shared/                  ← CSS/JS shared across Lab App
│   │   ├── tokens.css           ← design tokens (colors etc.)
│   │   ├── base.css             ← component styles common to every view
│   │   ├── markdown.js          ← escaping / markdown rendering / <think> parsing
│   │   ├── toast.js             ← toast notifications
│   │   ├── stats-card.js        ← response-timing stats card
│   │   └── api-client.js        ← the only module that talks to Lab API
│   ├── lab-app/
│   │   ├── Dockerfile
│   │   ├── index.html           ← markup shell — header/tabs + all 3 views
│   │   └── src/
│   │       ├── app.js           ← entry point, wires all 3 views together
│   │       ├── params-panel.js  ← generalized param panel (CHAT/L/R/BASE)
│   │       ├── model-select.js  ← model dropdown sync, all 4 panels at once
│   │       ├── model-catalog.js ← "Manage Models" — browse/pull/delete
│   │       ├── bundled-models.js
│   │       ├── chat/            ← chat-view.js, conversations.js
│   │       ├── diff/            ← diff-view.js
│   │       └── eval/            ← eval-harness.js, axis-panel.js,
│   │                              grid-view.js, ai-eval-panel.js,
│   │                              eval-history.js
│   └── lab-api/
│       ├── Dockerfile
│       ├── requirements.txt
│       ├── app/
│       │   ├── main.py          ← FastAPI app, CORS, router mounting
│       │   ├── config.py        ← settings from env vars
│       │   ├── db.py             ← SQLite schema + connection helper
│       │   ├── models.py         ← Pydantic request/response schemas
│       │   ├── ollama_proxy.py   ← talks to Ollama
│       │   ├── hosted_proxy.py   ← talks to an optional OpenAI-compatible
│       │   │                        baseline endpoint
│       │   ├── routers/          ← chat, conversations, eval, models
│       │   └── scoring/          ← the pluggable scorer registry (see below)
│       └── tests/                ← pytest suite, Ollama mocked, real SQLite
├── .env.example
├── .env                          ← your config (gitignored)
├── Makefile
└── README.md
```

---

## Quick Start

```bash
# 1. Set up config
cp .env.example .env

# 2a. Start with GPU  — most common
make gpu

# 2b. Start with CPU
make cpu

# 3. Open Lab App — Chat / A/B Diff / Eval Harness are tabs inside it
open http://localhost:3001
```

The first run pulls the default model (`qwen3:2b` unless changed in `.env`). This takes a few minutes.

---

## Lab App

One app, one port, three tabs — **Chat**, **A/B Diff**, and **Eval Harness** — switched with a button, not a page navigation, so a running Eval sweep keeps going if you switch tabs. Model management ("⚙ Manage Models": browse a curated library, pull by name, or delete anything installed) and the connection status indicator are shared across all three.

### Chat

A chat interface built specifically for LLM experimentation, not general-purpose chat.

### Live Parameter Controls
Every parameter applies to every request — change mid-conversation:

| Parameter | Range | Effect |
|-----------|-------|--------|
| **Temperature** | 0 – 2 | Randomness. 0 = deterministic, 1.0+ = creative |
| **Top-P** | 0 – 1 | Nucleus sampling cutoff |
| **Top-K** | 1 – 100 | Limit to K most probable tokens |
| **Repeat Penalty** | 1.0 – 2.0 | Penalise repeated tokens (1.0 = off) |
| **Max Tokens** | 64 – 32768 | Maximum tokens to generate |
| **Context Window** | 512 – 131072 | Total prompt + reply token budget |
| **Seed** | -1 to 2^31 | -1 = random; fixed = reproducible output |

### Response Timing
Every response shows a stats card with TTFT, total time, tokens/sec, token counts, and model load time.

### Conversation History
Every chat is persisted by Lab API. Click **🕘 History** to reopen or delete a past conversation.

### Other Features
- Model selector, system prompt, streaming output, `<think>` block rendering
- Stop button — cancel generation mid-stream
- Pull/delete models via the shared "⚙ Manage Models" modal (browse a curated library or type any name)
- `Enter` to send, `Shift+Enter` for a new line

---

Two more views live in the same app: a live two-column **Diff View**, and a batch **Eval Harness** that sweeps any number of configurations at once.

### A/B Diff View
Two independent chat columns, each with its own model selector and full parameter set. Send one prompt, both sides respond in parallel with independent streaming, stats, and persisted history per side.

### Eval Harness
Sweep **any number of axes** against a whole prompt dataset in one run. An axis is any parameter (model, temperature, top_p, top_k, repeat_penalty, max tokens, context window, seed, thinking mode, even system prompt) plus a list of values to try; the harness computes the cartesian product automatically (2 models × 3 temperatures = 6 cells) and runs every cell against every prompt.

Results render as a colored grid/heatmap: one axis is a colored strip, two axes are a proper 2D grid, and more than two give you row/column pickers plus a "held at" selector for the rest. Recoloring by a different metric is instant — every stat and every judgment for a run is fetched once and kept client-side, so switching **Color by** between judge scores and tokens/sec (or total time) re-renders the identical grid with no re-run.

Other pieces:
- **Hosted baseline** (optional) — point one field at any OpenAI-compatible endpoint (OpenAI itself, or anything mimicking its API: vLLM, llama.cpp's shim, OpenRouter) to add a single reference cell alongside your local sweep.
- Paste prompts or import `.txt`/`.json`, watch cells populate live, export the whole sweep as JSON or Markdown. Runs are persisted; click **🕘 Runs** to reopen a past one.
- The backend bounds how many cells run against Ollama at once (`EVAL_MAX_CONCURRENCY` in `.env`, default 2), separate from the client-side worker pool that keeps the browser from opening hundreds of streams at once.
- **Color by** always includes two free stats with no scoring pass needed — **Speed (tokens/sec)**, **Total time**, and **Avg word count** — available the instant a sweep finishes.
- **Staged progress feedback** — the progress label distinguishes "Loading {model}…" (request sent, nothing streamed back yet — the model is cold-loading into Ollama) from "Running N of Total generations…" (the first token has arrived). The loading state reappears every time the sweep moves on to a different, not-yet-warm model, but never twice in a row for cells on the same already-warm model.

### AI Evaluation
The Eval Harness can grade a finished run with a judge model. Pick a **Judge model** (defaults to `qwen3.5:9b` if it's installed), check whichever of the three dimensions you want, and click **Run AI Evaluation** — every generation across every cell in the sweep gets graded in one pass:

| Dimension | What it measures |
|---|---|
| **Completeness** | Does the response address everything the prompt asked for, with nothing left out? Breadth, not accuracy — a response can be complete about the part it answers and still incomplete overall. |
| **Correctness** | Is the core answer/conclusion/solution itself right, given what was asked? Scoped strictly to the main deliverable, not incidental details. |
| **Hallucination Risk** | Does the response state anything as fact that appears fabricated or unverifiable, in the core answer OR incidental details? **Inverted** — higher score means *more* risk (worse), unlike the other two dimensions. |

However many dimensions are checked, it's always **one combined judge-model call per generation** — never one call per dimension — with one shared rationale covering whatever was scored. Any dimension can come back `null` ("not applicable") instead of a forced number.

Each checked dimension is stored under its own name (`llm-judge:completeness`, `llm-judge:correctness`, `llm-judge:hallucination_risk`) and becomes its own independent **Color by** option automatically — the grid discovers metrics generically from whatever scorer names exist on a run, so no per-dimension frontend code was needed for that part.

---

## Testing

**Backend** (pytest, Ollama mocked via `httpx.MockTransport`, real temp-file SQLite):
```bash
cd services/lab-api
pip install -r requirements.txt pytest pytest-asyncio
pytest tests/ -v
# or: make test-api
```
Covers the full chat-persistence flow, the axis-sweep eval lifecycle (cartesian-product cell creation, axis/model validation, the hosted-baseline cell, generation + persistence), the AI Evaluation judge (dynamic per-dimension rubrics, null handling, per-dimension repeat variance, the streaming NDJSON `/score` progress lines), the two legacy registry scorers kept as extension examples, and the model-management proxy routes.

**Frontend** (jsdom smoke tests — optional, not part of the Docker image):
```bash
cd services
npm install jsdom
node smoke_test.mjs                    # the app loads + inits with zero errors
node functional_test_lab_ui.mjs        # simulates an actual Chat send → stream → render
node functional_test_lab_eval.mjs      # simulates a parallel A/B Diff send
node functional_test_eval_harness.mjs  # drives a real axis sweep + AI Evaluation through the DOM: grid, scoring, staged progress feedback, dedicated AI Evaluation grid
```

---

## All Make Commands

```
make gpu            GPU + Lab API + Lab App      (default)
make gpu-webui      GPU + Open WebUI
make gpu-all        GPU + everything
make cpu            CPU + Lab API + Lab App
make cpu-webui      CPU + Open WebUI

make stop           Stop all containers (keep volumes)
make clean          Stop + delete volumes ⚠ removes model cache AND lab.db

make rebuild-app     Rebuild Lab App after editing services/lab-app/
make rebuild-api     Rebuild Lab API after editing services/lab-api/app/
make test-api        Run the backend pytest suite

make pull MODEL=…   Pull a model
make models          List downloaded models
make rm-model MODEL=… Remove a model

make logs           Follow all logs
make logs-ollama    Follow Ollama logs
make logs-app       Follow Lab App logs
make logs-api       Follow Lab API (backend) logs
make logs-init      Show model-init logs (check if first pull succeeded)
make status         Container status + GPU memory
make chat MODEL=…   Terminal chat (no UI)
make help           Show this help
```

---

## Switching Modes

```bash
make stop && make gpu    # switch to GPU
make stop && make cpu    # switch to CPU
```

---

## Prerequisites

### Always
- Docker Desktop or Docker Engine + Compose v2

### GPU mode only
```bash
# Ubuntu/Debian — NVIDIA Container Toolkit
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

---

## Editing Lab App / Lab API

Edit whichever module under `services/lab-app/src/` owns the thing you're changing — `chat/` for Chat, `diff/` for A/B Diff, `eval/` for the Eval Harness, or the files directly under `src/` (`app.js`, `params-panel.js`, `model-select.js`, `model-catalog.js`) if it's shared across views — or `services/shared/` if it's used across the whole app, then:

```bash
make rebuild-app     # Lab App (Chat + A/B Diff + Eval Harness)
make rebuild-api     # Lab API backend
```

Each rebuilds only that one container and restarts it without touching Ollama or loaded models.

## Known limitations

- **Single user, no auth.** Anyone who can reach the published ports (3001/8000/11434) can use these tools — fine for one trusted machine, not for a shared network without adding auth in front of Lab API.
- **Ports bind to all interfaces by default**, not just localhost. On a shared network, consider binding `127.0.0.1:PORT:PORT` in the compose files if you don't want LAN access.
- **Chat, A/B Diff, and Eval Harness are one app now, not two.** They used to be separate containers on separate ports (Lab UI on 3001, Lab Eval on 3002); they're merged into one Lab App container/port with tab navigation, since nothing about how the three tools work required them to be separately deployed for a single local user. Editing one rebuilds the container all three live in — see "Editing Lab App / Lab API" above.
- **The scorer registry is populated at import time**, not hot-reloaded — restart Lab API (`make rebuild-api`) after adding a new scorer.
- **No hard cap on axis/value counts.** A 10×10 sweep over 50 prompts is 5,000 generations — `EVAL_MAX_CONCURRENCY` protects Ollama from being hit all at once, but it won't stop you from queuing up a sweep that takes a long time to finish. Size sweeps with your own hardware in mind.
- **Hosted-baseline timing is approximate.** OpenAI-compatible streaming APIs don't expose Ollama's internal timing fields, so tokens/sec for that one reference cell is estimated from wall-clock time and a ~4-chars/token heuristic — good enough to tell "same ballpark as local" apart from "way off," not a precise benchmark.

## License

MIT © 2026 [Nkonstan](https://github.com/Nkonstan/llm-local-lab)
