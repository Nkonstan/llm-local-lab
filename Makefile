# ─────────────────────────────────────────────────────────────────────────────
#  LLM Local Lab — Makefile
#
#  Compose layers:
#    docker-compose.yml          Base (Ollama + model-init)
#    docker-compose.gpu.yml      GPU override  
#    docker-compose.cpu.yml      CPU override  
#    docker-compose.lab.yml      Custom Lab UI (port 3001)
#    docker-compose.webui.yml    Open WebUI    (port 3000, optional)
#
#  Default target is GPU + Lab UI (make gpu).
# ─────────────────────────────────────────────────────────────────────────────

COMPOSE_BASE  := docker compose -f docker-compose.yml
COMPOSE_GPU   := $(COMPOSE_BASE) -f docker-compose.gpu.yml
COMPOSE_CPU   := $(COMPOSE_BASE) -f docker-compose.cpu.yml
COMPOSE_LAB   := -f docker-compose.lab.yml
COMPOSE_WEBUI := -f docker-compose.webui.yml

.DEFAULT_GOAL := help

# ── Startup: GPU ──────────────────────────────────────────────────────────────

.PHONY: gpu
gpu: _env_check                         ## 🚀  GPU + Lab UI  (default)
	@echo "🚀  Starting with GPU + Lab UI..."
	$(COMPOSE_GPU) $(COMPOSE_LAB) up -d --build --remove-orphans
	@echo "✅  Lab UI  → http://localhost:$$(grep '^LAB_PORT' .env | cut -d= -f2)"
	@echo "   Ollama   → http://localhost:11434"

.PHONY: gpu-webui
gpu-webui: _env_check                   ## 🚀  GPU + Open WebUI
	@echo "🚀  Starting with GPU + Open WebUI..."
	$(COMPOSE_GPU) $(COMPOSE_WEBUI) up -d --remove-orphans
	@echo "✅  WebUI   → http://localhost:$$(grep '^WEBUI_PORT' .env | cut -d= -f2)"

.PHONY: gpu-all
gpu-all: _env_check                     ## 🚀  GPU + Lab UI + Open WebUI
	@echo "🚀  Starting with GPU + all UIs..."
	$(COMPOSE_GPU) $(COMPOSE_LAB) $(COMPOSE_WEBUI) up -d --build --remove-orphans
	@echo "✅  Lab UI  → http://localhost:$$(grep '^LAB_PORT'  .env | cut -d= -f2)"
	@echo "   WebUI   → http://localhost:$$(grep '^WEBUI_PORT' .env | cut -d= -f2)"

# ── Startup: CPU ──────────────────────────────────────────────────────────────

.PHONY: cpu
cpu: _env_check                         ## 🖥️   CPU + Lab UI
	@echo "🖥️  Starting with CPU + Lab UI..."
	$(COMPOSE_CPU) $(COMPOSE_LAB) up -d --build --remove-orphans
	@echo "✅  Lab UI  → http://localhost:$$(grep '^LAB_PORT' .env | cut -d= -f2)"

.PHONY: cpu-webui
cpu-webui: _env_check                   ## 🖥️   CPU + Open WebUI
	@echo "🖥️  Starting with CPU + Open WebUI..."
	$(COMPOSE_CPU) $(COMPOSE_WEBUI) up -d --remove-orphans
	@echo "✅  WebUI   → http://localhost:$$(grep '^WEBUI_PORT' .env | cut -d= -f2)"

# ── Teardown ──────────────────────────────────────────────────────────────────

.PHONY: stop
stop:                                   ## ⏹   Stop all containers (keep volumes)
	$(COMPOSE_BASE) $(COMPOSE_LAB) $(COMPOSE_WEBUI) down

.PHONY: clean
clean:                                  ## 🗑   Stop + remove volumes (⚠ deletes model cache)
	$(COMPOSE_BASE) $(COMPOSE_LAB) $(COMPOSE_WEBUI) down -v --remove-orphans

.PHONY: rebuild-ui
rebuild-ui:                             ## 🔨  Rebuild the Lab UI image only (after editing HTML)
	$(COMPOSE_BASE) $(COMPOSE_LAB) build lab-ui
	$(COMPOSE_BASE) $(COMPOSE_LAB) up -d lab-ui

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

.PHONY: logs-ui
logs-ui:                                ## 📜  Follow Lab UI logs only
	docker logs -f lab-ui

.PHONY: status
status:                                 ## ℹ️   Container status + GPU memory
	@echo "\n── Containers ────────────────────────────────"
	$(COMPOSE_BASE) ps
	@echo "\n── GPU ───────────────────────────────────────"
	@nvidia-smi --query-gpu=name,memory.used,memory.free,utilization.gpu \
	  --format=csv,noheader 2>/dev/null || echo "(nvidia-smi not available)"

.PHONY: chat
chat:                                   ## 💬  Terminal chat  →  make chat MODEL=qwen3:2b
	docker exec -it ollama ollama run $(or $(MODEL),$(shell grep '^DEFAULT_MODEL' .env | cut -d= -f2))

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
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  Compose layers stacked:  base  +  gpu/cpu  +  lab/webui"
	@echo ""
