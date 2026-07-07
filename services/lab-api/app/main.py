from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .db import init_db
from .routers import chat, conversations, eval, models


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Lab API", lifespan=lifespan)

# The browser only ever talks to this backend now — not to Ollama directly —
# so this is the one place CORS needs configuring, and it only ever needs to
# know about the two frontend ports (see .env: LAB_API_ORIGINS). This is what
# replaces OLLAMA_ORIGINS from the old architecture.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(models.router)
app.include_router(chat.router)
app.include_router(conversations.router)
app.include_router(eval.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
