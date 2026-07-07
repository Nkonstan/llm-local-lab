import os


class Settings:
    """All configuration is read from the environment (see docker-compose.lab.yml
    and .env.example) so the backend has zero required setup beyond env vars."""

    ollama_base_url: str = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
    db_path: str = os.environ.get("LAB_DB_PATH", "/data/lab.db")

    # Origins allowed to call this API from a browser. This replaces
    # OLLAMA_ORIGINS from the old direct-to-Ollama architecture: instead of
    # Ollama needing to know about every frontend port, only this backend
    # does. Lab UI and Lab Eval used to be two separate frontends (hence a
    # two-origin default here); they're merged into one Lab App now, so
    # there's normally just the one.
    allowed_origins: list[str] = [
        o.strip()
        for o in os.environ.get(
            "LAB_API_ORIGINS", "http://localhost:3001"
        ).split(",")
        if o.strip()
    ]

    # Timeouts for talking to Ollama. Generous because model loads and long
    # generations are expected; httpx needs an explicit read timeout override
    # or it defaults to 5s, which is far too short for LLM inference.
    ollama_connect_timeout: float = float(os.environ.get("OLLAMA_CONNECT_TIMEOUT", "10"))
    ollama_read_timeout: float = float(os.environ.get("OLLAMA_READ_TIMEOUT", "600"))

    # Bounded concurrency for the Eval Harness specifically (see eval.py). A
    # sweep can now generate hundreds of cells; without a cap the eval router
    # would fire all of them at Ollama at once. Deliberately NOT touching
    # ollama_proxy.py's shared open_ollama_stream() — /api/chat (Lab UI) is
    # out of scope for this redesign and keeps its old unbounded behavior.
    # Default of 2 assumes a single local GPU that mostly serializes anyway;
    # raise it if you're on hardware that genuinely benefits from more.
    eval_max_concurrency: int = int(os.environ.get("EVAL_MAX_CONCURRENCY", "2"))

    # Timeouts for the one optional hosted-baseline endpoint (item 6). Same
    # generous read timeout reasoning as Ollama above.
    hosted_connect_timeout: float = float(os.environ.get("HOSTED_CONNECT_TIMEOUT", "10"))
    hosted_read_timeout: float = float(os.environ.get("HOSTED_READ_TIMEOUT", "600"))


settings = Settings()
