import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..config import settings
from ..models import PullRequest, DeleteRequest
from .. import ollama_proxy
from ..ollama_proxy import open_ollama_stream, close_ollama_stream, OllamaError

router = APIRouter()


@router.get("/api/tags")
async def get_tags():
    async with ollama_proxy.make_client() as client:
        try:
            res = await client.get(f"{settings.ollama_base_url}/api/tags")
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Could not reach Ollama: {e}")
        if res.status_code >= 400:
            raise HTTPException(status_code=res.status_code, detail=res.text)
        return res.json()


@router.post("/api/pull")
async def pull_model(req: PullRequest):
    try:
        client, stream_cm, response = await open_ollama_stream("/api/pull", req.model_dump())
    except OllamaError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)

    async def gen():
        try:
            async for line in response.aiter_lines():
                if line:
                    yield line + "\n"
        finally:
            await close_ollama_stream(client, stream_cm)

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@router.delete("/api/delete")
async def delete_model(req: DeleteRequest):
    async with ollama_proxy.make_client() as client:
        try:
            res = await client.request(
                "DELETE", f"{settings.ollama_base_url}/api/delete", json=req.model_dump()
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Could not reach Ollama: {e}")
        if res.status_code >= 400:
            raise HTTPException(status_code=res.status_code, detail=res.text)
        return {"deleted": req.name}
