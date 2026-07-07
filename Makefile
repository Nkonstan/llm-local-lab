# ─────────────────────────────────────────────────────────────────────────────
#  LLM Local Lab — Makefile
#
#  Compose layers:
#    docker-compose.yml          Base (Ollama + model-init)
#    docker-compose.gpu.yml      GPU override  
#    docker-compose.cpu.yml      CPU override  
#    docker-compose.lab.yml      Lab API (port 8000) + Lab App (3001)
#    docker-compose.webui.yml    Open WebUI    (port 3000, optional)
#
#  Lab App no longer talks to Ollama directly — it calls Lab API, which
#  proxies to Ollama and persists conversations/eval runs/judgments to
#  SQLite. See README.md for the full architecture.
#
#  Lab App is Chat / A-B Diff / Eval Harness as one app, one port, tab-
#  switched — it used to be two containers (Lab UI + Lab Eval) on two
#  ports; see README.md > Architecture for why they're merged now.
#
#  Default target is GPU + Lab App (make gpu).
# ─────────────────────────────────────────────────────────────────────────────

COMPOSE_BASE  := docker compose -f docker-compose.yml
COMPOSE_GPU   := $(COMPOSE_BASE) -f docker-compose.gpu.yml
COMPOSE_CPU   := $(COMPOSE_BASE) -f docker-compose.cpu.yml
COMPOSE_LAB   := -f docker-compose.lab.yml
COMPOSE_WEBUI := -f docker-compose.webui.yml

# Load .env directly as Make variables (falls back to these defaults if .env
# or a given key doesn't exist yet) instead of shelling out to grep/cut for
# every port in every echo line below — simpler and doesn't depend on which
# shell `make` happens to invoke recipes with.
-include .env
LAB_PORT     ?= 3001
LAB_API_PORT ?= 8000
WEBUI_PORT   ?= 3000
DEFAULT_MODEL ?= qwen3:2b

.DEFAULT_GOAL := help

# ── Startup: GPU ──────────────────────────────────────────────────────────────

.PHONY: gpu
gpu: _env_check                         ## 🚀  GPU + Lab App  (default)
	@echo "🚀  Starting with GPU + Lab App..."
	$(COMPOSE_GPU) $(COMPOSE_LAB) up -d --build --remove-orphans
	@echo "✅  Lab App  → http://localhost:$(LAB_PORT)  (Chat · A/B Diff · Eval Harness)"
	@echo "   Lab API  → http://localhost:$(LAB_API_PORT)"
	@echo "   Ollama   → http://localhost:11434"
	@echo "   If models are missing: make logs-init"


.PHONY: gpu-webui
gpu-webui: _env_check                   ## 🚀  GPU + Open WebUI
	@echo "🚀  Starting with GPU + Open WebUI..."
	$(COMPOSE_GPU) $(COMPOSE_WEBUI) up -d --remove-orphans
	@echo "✅  WebUI   → http://localhost:$(WEBUI_PORT)"

.PHONY: gpu-all
gpu-all: _env_check                     ## 🚀  GPU + Lab App + Open WebUI
	@echo "🚀  Starting with GPU + all UIs..."
	$(COMPOSE_GPU) $(COMPOSE_LAB) $(COMPOSE_WEBUI) up -d --build --remove-orphans
	@echo "✅  Lab App  → http://localhost:$(LAB_PORT)  (Chat · A/B Diff · Eval Harness)"
	@echo "   Lab API  → http://localhost:$(LAB_API_PORT)"
	@echo "   WebUI    → http://localhost:$(WEBUI_PORT)"

# ── Startup: CPU ──────────────────────────────────────────────────────────────

.PHONY: cpu
cpu: _env_check                         ## 🖥️   CPU + Lab App
	@echo "🖥️  Starting with CPU + Lab App..."
	$(COMPOSE_CPU) $(COMPOSE_LAB) up -d --build --remove-orphans
	@echo "✅  Lab App  → http://localhost:$(LAB_PORT)  (Chat · A/B Diff · Eval Harness)"
	@echo "   Lab API  → http://localhost:$(LAB_API_PORT)"
	@echo "   If models are missing: make logs-init"


.PHONY: cpu-webui
cpu-webui: _env_check                   ## 🖥️   CPU + Open WebUI
	@echo "🖥️  Starting with CPU + Open WebUI..."
	$(COMPOSE_CPU) $(COMPOSE_WEBUI) up -d --remove-orphans
	@echo "✅  WebUI   → http://localhost:$(WEBUI_PORT)"

# ── Teardown ──────────────────────────────────────────────────────────────────

.PHONY: stop
stop:                                   ## ⏹   Stop all containers (keep volumes)
	$(COMPOSE_BASE) $(COMPOSE_LAB) $(COMPOSE_WEBUI) down

.PHONY: clean
clean:                                  ## 🗑   Stop + remove volumes (⚠ deletes model cache)
	$(COMPOSE_BASE) $(COMPOSE_LAB) $(COMPOSE_WEBUI) down -v --remove-orphans

.PHONY: rebuild-app
rebuild-app:                            ## 🔨  Rebuild the Lab App image only (after editing HTML/JS)
	$(COMPOSE_BASE) $(COMPOSE_LAB) build lab-app
	$(COMPOSE_BASE) $(COMPOSE_LAB) up -d lab-app

.PHONY: rebuild-api
rebuild-api:                            ## 🔨  Rebuild the Lab API backend (after editing app/)
	$(COMPOSE_BASE) $(COMPOSE_LAB) build lab-api
	$(COMPOSE_BASE) $(COMPOSE_LAB) up -d lab-api

.PHONY: test-api
test-api:                               ## 🧪  Run the Lab API backend test suite (needs: pip install -r services/lab-api/requirements.txt pytest pytest-asyncio)
	cd services/lab-api && python3 -m pytest tests/ -v

# ── Model management ──────────────────────────────────────────────────────────

.PHONY: pull
pull:                                   ## 📥  Pull a model  →  make pull MODEL=mistral:7b-q4_0
ifndef MODEL
	$(error ❌  Specify a model: make pull MODEL=mistral:7b-q4_0)
endif
	@echo "📥  Pulling $(MODEL)..."
	docker exec ollama ollama pull $(MODEL)

.PHONY: models
models:                                 ## 📋  List all downloaded models
	docker exec ollama ollama list

.PHONY: rm-model
rm-model:                               ## 🗑   Remove a model  →  make rm-model MODEL=mistral:7b-q4_0
ifndef MODEL
	$(error ❌  Specify a model: make rm-model MODEL=mistral:7b-q4_0)
endif
	docker exec ollama ollama rm $(MODEL)

# ── Utilities ─────────────────────────────────────────────────────────────────

.PHONY: logs
logs:                                   ## 📜  Follow all logs
	$(COMPOSE_BASE) $(COMPOSE_LAB) logs -f

.PHONY: logs-ollama
logs-ollama:                            ## 📜  Follow Ollama logs only
	docker logs -f ollama

.PHONY: logs-app
logs-app:                               ## 📜  Follow Lab App logs only
	docker logs -f lab-app

.PHONY: logs-api
logs-api:                               ## 📜  Follow Lab API (backend) logs only
	docker logs -f lab-api

.PHONY: logs-init
logs-init:                              ## 📜  Show model-init logs (check if first pull succeeded)
	docker logs model-init

.PHONY: status
status:                                 ## ℹ️   Container status + GPU memory
	@echo "\n── Containers ────────────────────────────────"
	$(COMPOSE_BASE) ps
	@echo "\n── GPU ───────────────────────────────────────"
	@nvidia-smi --query-gpu=name,memory.used,memory.free,utilization.gpu \
	  --format=csv,noheader 2>/dev/null || echo "(nvidia-smi not available)"

.PHONY: chat
chat:                                   ## 💬  Terminal chat  →  make chat MODEL=qwen3:2b
	docker exec -it ollama ollama run $(or $(MODEL),$(DEFAULT_MODEL))

# ── Internal ──────────────────────────────────────────────────────────────────

.PHONY: _env_check
_env_check:
	@if [ ! -f .env ]; then \
	  echo "⚠️  .env not found — copying from .env.example"; \
	  cp .env.example .env; \
	fi

.PHONY: help
help:                                   ## 📖  Show this help
	@echo ""
	@echo "  LLM Local Lab"
	@echo "  ─────────────────────────────────────────────────────────"
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  Compose layers stacked:  base  +  gpu/cpu  +  lab/webui"
	@echo ""

