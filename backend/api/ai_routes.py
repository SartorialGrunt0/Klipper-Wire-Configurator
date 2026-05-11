"""Klipper Wire Configurator - AI Chat Backend Proxy"""
from fastapi import APIRouter
from pydantic import BaseModel
from enum import Enum

router = APIRouter()

SYSTEM_PROMPT = (
    "You are a klipper firmware and configuration expert who responds in clear, "
    "short, and concise answers to help with klipper firmware questions."
)


class AiProvider(str, Enum):
    chatgpt = "chatgpt"
    google = "google"
    anthropic = "anthropic"
    github = "github"
    openai_compatible = "openai-compatible"
    lm_studio = "lm-studio"
    ollama = "ollama"


class ChatRequest(BaseModel):
    messages: list[dict]
    apiKey: str
    model: str = "gpt-4o"
    apiUrl: str = "https://api.openai.com/v1/chat/completions"
    apiProvider: AiProvider = AiProvider.chatgpt


def _is_local_provider(provider: str) -> bool:
    return provider in ("lm-studio", "ollama")


def _prepare_messages(messages: list[dict]) -> list[dict]:
    system_parts = [SYSTEM_PROMPT]
    prepared: list[dict] = []

    for msg in messages:
        role = msg.get("role")
        content = str(msg.get("content", "")).strip()
        if role not in {"system", "user", "assistant"} or not content:
            continue
        if role == "system":
            if content != SYSTEM_PROMPT:
                system_parts.append(content)
            continue
        prepared.append({"role": role, "content": content})

    return [{"role": "system", "content": "\n\n".join(system_parts)}] + prepared


def _build_google_payload(messages: list[dict], model: str) -> dict:
    system_parts: list[str] = []
    contents: list[dict] = []

    for msg in messages:
        if msg["role"] == "system":
            system_parts.append(msg["content"])
            continue
        contents.append(
            {
                "role": "model" if msg["role"] == "assistant" else "user",
                "parts": [{"text": msg["content"]}],
            }
        )

    payload = {
        "contents": contents,
        "generationConfig": {},
    }
    if model:
        payload["model"] = model
    if system_parts:
        payload["systemInstruction"] = {
            "parts": [{"text": "\n\n".join(system_parts)}],
        }
    return payload


@router.get("/ai/models")
async def list_models(apiUrl: str = None, apiKey: str = None):
    """List available models from a local server (LM Studio, Ollama, etc.)."""
    import httpx
    from urllib.parse import urlparse, urlunparse

    if not apiUrl:
        return {"models": []}

    # Strip the path (e.g., /v1/chat/completions) to get the base URL
    parsed = urlparse(apiUrl)
    base_url = urlunparse((parsed.scheme, parsed.netloc, '', '', '', ''))
    models_url = f"{base_url}/v1/models"

    headers = {"Content-Type": "application/json"}
    if apiKey and apiKey.strip():
        headers["Authorization"] = f"Bearer {apiKey}"

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(models_url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            model_ids = [m["id"] for m in data.get("data", [])]
            return {"models": model_ids}
        except httpx.HTTPError as e:
            return {"models": [], "error": str(e)}


@router.post("/ai/chat")
async def chat_proxy(req: ChatRequest):
    """Proxy chat messages to the user's configured API provider."""
    import httpx

    messages = _prepare_messages(req.messages)

    # Local providers don't require an API key
    if not _is_local_provider(req.apiProvider) and not req.apiKey:
        return {"error": "AI settings not configured. Please configure your API key in settings."}

    # Build headers based on provider
    if req.apiProvider == "anthropic":
        # Anthropic uses x-api-key header instead of Bearer
        headers = {
            "x-api-key": req.apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
    elif req.apiProvider == "google":
        # Google uses a different format entirely
        headers = {
            "Content-Type": "application/json",
        }
    elif _is_local_provider(req.apiProvider):
        # LM Studio and Ollama: auth optional, include key if provided
        headers = {
            "Content-Type": "application/json",
        }
        if req.apiKey:
            headers["Authorization"] = f"Bearer {req.apiKey}"
    else:
        # OpenAI, GitHub Copilot, and OpenAI Compatible all use Bearer token
        headers = {
            "Authorization": f"Bearer {req.apiKey}",
            "Content-Type": "application/json",
        }

    # Build payload based on provider
    if req.apiProvider == "google":
        payload = _build_google_payload(messages, req.model)
    elif req.apiProvider == "anthropic":
        # Claude uses a different format - extract system message
        system = None
        filtered_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system = msg["content"]
            else:
                filtered_messages.append(msg)
        if system:
            payload = {
                "model": req.model,
                "messages": filtered_messages,
                "system": system,
            }
        else:
            payload = {
                "model": req.model,
                "messages": filtered_messages,
            }
    else:
        # OpenAI, GitHub, compatible: standard format
        payload = {
            "model": req.model,
            "messages": messages,
        }

    timeout = httpx.Timeout(connect=15.0, read=None, write=120.0, pool=120.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.post(req.apiUrl, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()

            # Check for error in response body (some servers return 200 with error info)
            if "error" in data:
                return {"error": f"API error: {data['error'].get('message', data['error'])}"}

            # Parse response based on provider
            if req.apiProvider == "google":
                content = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
            elif req.apiProvider == "anthropic":
                content = data.get("content", [{}])[0].get("text", "")
            else:
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "")

            if not content:
                return {"error": "Empty response from API. Make sure a model is loaded in your local server."}

            return {"content": content}
        except httpx.TimeoutException:
            return {"error": "API request timed out before the model finished responding."}
        except httpx.HTTPError as e:
            return {"error": f"API request failed: {str(e)}"}
