# LLM Local Lab

A modular local LLM research stack. Run any Ollama model with a purpose-built experimentation UI featuring live parameter controls, detailed response timing, and streaming output — switchable between GPU and CPU with one command.

**Stack:** [Ollama](https://ollama.com) (inference) · Custom Lab UI · [Open WebUI](https://github.com/open-webui/open-webui) (optional full chat UI)

---

## Architecture

The project is built from **composable layers** — each file is independent and can be combined as needed:

```
docker-compose.yml          ← Base: Ollama + model-init (always included)
docker-compose.gpu.yml      ← GPU overlay  
docker-compose.cpu.yml      ← CPU overlay  
docker-compose.lab.yml      ← Custom Lab UI on :3001
docker-compose.webui.yml    ← Open WebUI on :3000  (optional)
```

```
llm-local/
├── docker-compose.yml
├── docker-compose.gpu.yml
├── docker-compose.cpu.yml
├── docker-compose.lab.yml
├── docker-compose.webui.yml
├── services/
│   └── lab-ui/
│       ├── Dockerfile          ← nginx serving the UI
│       └── index.html          ← Complete lab interface
├── .env.example
├── .env                        ← Your config (gitignored)
├── Makefile
└── README.md
```

---

## Quick Start

```bash
# 1. Set up config
cp .env.example .env

# 2a. Start with GPU (RTX 2070) — most common
make gpu

# 2b. Start with CPU (Ryzen 5 1600)
make cpu

# 3. Open the Lab UI
open http://localhost:3001
```

The first run pulls the default model (`qwen3:2b` unless changed in `.env`). This takes a few minutes.

---

## Lab UI Features

The custom UI at `http://localhost:3001` is built specifically for LLM experimentation:

### Live Parameter Controls
All parameters apply to every request — change them mid-conversation:

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

Every response shows a stats card with:
- **Time to First Token (TTFT)** — how long until output started
- **Total Response Time** — end-to-end wall clock time
- **Generation Speed** — tokens/second
- **Tokens Generated** / **Prompt Tokens** — exact counts
- **Prompt Eval Time** / **Generation Time** — broken down
- **Model Load Time** — non-zero only when model was cold-loaded

Click any stats card to expand the full breakdown.

### Other Features
- Model selector — switches instantly, lists all pulled models
- System prompt — persistent per-session
- Streaming output with live token rendering
- `<think>` block rendering (Qwen3, Deepseek R1, etc.)
- Stop button — cancel generation mid-stream
- Pull model — trigger a pull from the browser (check Ollama logs for progress)
- `Ctrl+Enter` to send

---

## All Make Commands

```
make gpu            GPU + Lab UI       (default)
make gpu-webui      GPU + Open WebUI
make gpu-all        GPU + both UIs
make cpu            CPU + Lab UI
make cpu-webui      CPU + Open WebUI

make stop           Stop all containers (keep volumes)
make clean          Stop + delete volumes ⚠ removes model cache

make rebuild-ui     Rebuild Lab UI after editing services/lab-ui/index.html

make pull MODEL=…   Pull a model
make models         List downloaded models
make rm-model MODEL=… Remove a model

make logs           Follow all logs
make logs-ollama    Follow Ollama logs
make logs-ui        Follow Lab UI logs
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

## Editing the Lab UI

The entire UI is a single HTML file:

```
services/lab-ui/index.html
```

After editing:
```bash
make rebuild-ui
```

This rebuilds only the `lab-ui` container and restarts it without touching Ollama or loaded models.
