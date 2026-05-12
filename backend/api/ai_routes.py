"""Klipper Wire Configurator - AI Chat Backend Proxy"""
from enum import Enum
from functools import lru_cache
from pathlib import Path
import re
from urllib.parse import urlparse, urlunparse

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

REFERENCE_DIR = Path(__file__).parent.parent.parent / "reference"
CONFIG_REFERENCE_PATH = REFERENCE_DIR / "reference_docs" / "klipper_docs" / "Config_Reference.md"
OFFICIAL_CONFIG_REFERENCE_URL = "https://www.klipper3d.org/Config_Reference.html"
QUERY_STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "can",
    "cfg",
    "config",
    "configuration",
    "do",
    "for",
    "from",
    "help",
    "how",
    "i",
    "in",
    "is",
    "it",
    "klipper",
    "me",
    "my",
    "of",
    "on",
    "or",
    "please",
    "printer",
    "set",
    "settings",
    "show",
    "tell",
    "that",
    "the",
    "this",
    "to",
    "use",
    "what",
    "with",
}
MAX_CONFIG_REFERENCE_RESULTS = 3
MAX_CONFIG_REFERENCE_SECTION_CHARS = 3200
MAX_REFERENCE_LOOKBACK_USER_MESSAGES = 3
MAX_REFERENCE_LOOKUP_QUERY_CHARS = 1800
CONFIG_REFERENCE_SECTION_RE = re.compile(r"^### \[([^\]]+)\]\s*$", re.MULTILINE)
CONFIG_REFERENCE_ALIAS_RE = re.compile(r"^\[([^\]]+)\]\s*$", re.MULTILINE)
LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID = "mcp/klipper-docs"
LM_STUDIO_MAX_INPUT_CHARS = 48000
LM_STUDIO_MAX_HISTORY_MESSAGES = 16
LM_STUDIO_INPUT_TRUNCATED_NOTICE = (
    "[Conversation context truncated before sending to the LM Studio REST chat endpoint.]"
)
LM_STUDIO_MCP_FALLBACK_HINTS = (
    "allow calling servers from mcp.json",
    "allow per-request mcps",
    "api token",
    "authorization",
    "integration",
    "mcp",
    "plugin",
)

SYSTEM_PROMPT = (
    "You are a klipper firmware and configuration expert who responds in clear, "
    "short, and concise answers to help with klipper firmware questions. If you edit a configuration section, always show the whole section in your response"
)
DOCS_GROUNDING_PROMPT = (
    "Ground all Klipper configuration guidance in documentation before answering. "
    "If your runtime exposes a `klipper-docs` MCP server or tool, call it first for "
    "configuration questions. If the tool is unavailable or the tool call fails, use "
    f"the official Klipper Config Reference at {OFFICIAL_CONFIG_REFERENCE_URL}. "
    "Treat any bundled Config_Reference excerpts included in this prompt as authoritative "
    "offline reference material. Do not invent section names, parameters, defaults, "
    "units, commands, or supported behavior. If the docs do not confirm a detail, say "
    "that explicitly and ask one short clarifying question or state what must be verified. "
    "When suggesting config changes, use the exact Klipper section headers and parameter "
    "names from the docs and prefer minimal edits over full-file rewrites."
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
    lmStudioMcpPluginId: str | None = None


def _tokenize_query(text: str) -> list[str]:
    tokens = re.findall(r"[a-z0-9_\-]{2,}", text.lower())
    return [token for token in tokens if token not in QUERY_STOP_WORDS]


@lru_cache(maxsize=1)
def _load_config_reference_sections() -> list[tuple[str, str, set[str]]]:
    if not CONFIG_REFERENCE_PATH.exists():
        return []

    try:
        content = CONFIG_REFERENCE_PATH.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []

    matches = list(CONFIG_REFERENCE_SECTION_RE.finditer(content))
    sections: list[tuple[str, str, set[str]]] = []

    for index, match in enumerate(matches):
        header = match.group(1).strip()
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(content)
        section_text = content[start:end].strip()
        aliases = {header}
        aliases.update(alias.strip() for alias in CONFIG_REFERENCE_ALIAS_RE.findall(section_text))
        sections.append((header, section_text, {alias for alias in aliases if alias}))

    return sections


def _normalize_lookup_text(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _score_config_reference_section(query_text: str, aliases: set[str]) -> int:
    query_words = set(query_text.split())
    score = 0

    for alias in aliases:
        alias_text = _normalize_lookup_text(alias)
        if not alias_text:
            continue

        alias_words = set(alias_text.split())
        if query_text == alias_text:
            score = max(score, 100)
            continue
        if alias_text in query_text:
            score = max(score, 70)
            continue
        if alias_words and alias_words.issubset(query_words):
            score = max(score, 50)
            continue

        overlap = len(alias_words & query_words)
        if overlap:
            score = max(score, overlap * 10)

    return score


def _trim_config_reference_section(section_text: str) -> str:
    if len(section_text) <= MAX_CONFIG_REFERENCE_SECTION_CHARS:
        return section_text

    return (
        f"{section_text[:MAX_CONFIG_REFERENCE_SECTION_CHARS].rstrip()}\n\n"
        f"[Section truncated after {MAX_CONFIG_REFERENCE_SECTION_CHARS} characters.]"
    )


def _get_config_reference_context(query: str, limit: int = MAX_CONFIG_REFERENCE_RESULTS) -> list[str]:
    query_text = _normalize_lookup_text(query)
    if not query_text:
        return []

    scored_sections: list[tuple[int, str]] = []

    for _header, section_text, aliases in _load_config_reference_sections():
        score = _score_config_reference_section(query_text, aliases)
        if score == 0:
            continue

        scored_sections.append((score, _trim_config_reference_section(section_text)))

    scored_sections.sort(key=lambda item: item[0], reverse=True)
    return [section_text for _, section_text in scored_sections[:limit]]


def _build_reference_lookup_query(messages: list[dict]) -> str:
    recent_user_messages: list[str] = []

    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue

        content = str(msg.get("content", "")).strip()
        if not content:
            continue

        recent_user_messages.append(content)
        if len(recent_user_messages) >= MAX_REFERENCE_LOOKBACK_USER_MESSAGES:
            break

    if not recent_user_messages:
        return ""

    combined = "\n\n".join(reversed(recent_user_messages))
    if len(combined) <= MAX_REFERENCE_LOOKUP_QUERY_CHARS:
        return combined
    return combined[-MAX_REFERENCE_LOOKUP_QUERY_CHARS:]


def _is_local_provider(provider: str) -> bool:
    return provider in ("lm-studio", "ollama")


def _prepare_messages(messages: list[dict]) -> list[dict]:
    system_parts = [SYSTEM_PROMPT, DOCS_GROUNDING_PROMPT]
    reference_lookup_query = _build_reference_lookup_query(messages)
    config_reference_context = _get_config_reference_context(reference_lookup_query)
    if config_reference_context:
        system_parts.append(
            "Relevant sections from the bundled Config_Reference.md for the recent user request(s):\n\n"
            + "\n\n---\n\n".join(config_reference_context)
        )
    else:
        system_parts.append(
            "No bundled Config_Reference excerpts were matched for the recent user request(s). "
            f"If you cannot use `klipper-docs`, fall back to {OFFICIAL_CONFIG_REFERENCE_URL} "
            "and avoid guessing."
        )
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


def _extract_api_error_message(data: dict) -> str | None:
    error = data.get("error")
    if error is None:
        return None
    if isinstance(error, dict):
        message = error.get("message") or error.get("error")
        return str(message or error)
    return str(error)


def _extract_provider_content(provider: str, data: dict) -> str:
    if provider == "google":
        return data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
    if provider == "anthropic":
        return data.get("content", [{}])[0].get("text", "")
    return data.get("choices", [{}])[0].get("message", {}).get("content", "")


def _build_api_base_url(api_url: str) -> str:
    parsed = urlparse(api_url)
    if not parsed.scheme or not parsed.netloc:
        return api_url.rstrip("/")
    return urlunparse((parsed.scheme, parsed.netloc, "", "", "", "")).rstrip("/")


def _normalize_lm_studio_mcp_plugin_id(plugin_id: str | None) -> str | None:
    if plugin_id is None:
        return LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID

    normalized = plugin_id.strip()
    return normalized or None


def _truncate_lm_studio_input(text: str) -> str:
    if len(text) <= LM_STUDIO_MAX_INPUT_CHARS:
        return text

    keep_chars = max(0, LM_STUDIO_MAX_INPUT_CHARS - len(LM_STUDIO_INPUT_TRUNCATED_NOTICE) - 2)
    return f"{LM_STUDIO_INPUT_TRUNCATED_NOTICE}\n\n{text[-keep_chars:]}"


def _format_lm_studio_chat_input(messages: list[dict]) -> str:
    non_system_messages = [msg for msg in messages if msg.get("role") in {"user", "assistant"}]
    if not non_system_messages:
        return ""

    recent_messages = non_system_messages[-LM_STUDIO_MAX_HISTORY_MESSAGES:]
    latest_message = recent_messages[-1]
    prior_messages = recent_messages[:-1]

    if not prior_messages and latest_message.get("role") == "user":
        return _truncate_lm_studio_input(str(latest_message.get("content", "")).strip())

    parts: list[str] = []
    if prior_messages:
        history_parts = []
        for msg in prior_messages:
            role = "User" if msg.get("role") == "user" else "Assistant"
            content = str(msg.get("content", "")).strip()
            if not content:
                continue
            history_parts.append(f"{role}:\n{content}")
        if history_parts:
            parts.append("Conversation so far:")
            parts.append("\n\n".join(history_parts))

    latest_content = str(latest_message.get("content", "")).strip()
    if latest_content:
        if latest_message.get("role") == "user":
            parts.append("Current user request:")
            parts.append(latest_content)
        else:
            parts.append(f"Assistant:\n{latest_content}")

    return _truncate_lm_studio_input("\n\n".join(part for part in parts if part))


def _build_lm_studio_chat_url(api_url: str) -> str:
    return f"{_build_api_base_url(api_url)}/api/v1/chat"


def _build_lm_studio_chat_payload(messages: list[dict], model: str, mcp_plugin_id: str | None = LM_STUDIO_KLIPPER_DOCS_PLUGIN_ID) -> dict:
    system_prompt = ""
    for msg in messages:
        if msg.get("role") == "system":
            system_prompt = str(msg.get("content", "")).strip()
            break

    payload = {
        "model": model,
        "input": _format_lm_studio_chat_input(messages),
        "store": False,
    }

    if system_prompt:
        payload["system_prompt"] = system_prompt
    if mcp_plugin_id:
        payload["integrations"] = [mcp_plugin_id]

    return payload


def _extract_lm_studio_message_content(data: dict) -> str:
    output = data.get("output")
    if not isinstance(output, list):
        return ""

    messages: list[str] = []
    for item in output:
        if item.get("type") != "message":
            continue
        content = str(item.get("content", "")).strip()
        if content:
            messages.append(content)

    return "\n\n".join(messages)


def _lm_studio_response_needs_fallback(data: dict) -> bool:
    output = data.get("output")
    if not isinstance(output, list):
        return False
    return any(item.get("type") == "invalid_tool_call" for item in output)


def _extract_lm_studio_tool_names(data: dict, plugin_id: str | None) -> list[str]:
    if not plugin_id:
        return []

    output = data.get("output")
    if not isinstance(output, list):
        return []

    tool_names: list[str] = []
    for item in output:
        if item.get("type") != "tool_call":
            continue
        provider_info = item.get("provider_info") or {}
        if provider_info.get("type") != "plugin":
            continue
        if provider_info.get("plugin_id") != plugin_id:
            continue

        tool_name = str(item.get("tool", "")).strip()
        if tool_name:
            tool_names.append(tool_name)

    return tool_names


def _build_lm_studio_mcp_metadata(
    plugin_id: str | None,
    route: str,
    *,
    tool_names: list[str] | None = None,
    fallback_reason: str | None = None,
) -> dict:
    normalized_tool_names = tool_names or []
    return {
        "requested": plugin_id is not None,
        "pluginId": plugin_id,
        "route": route,
        "toolUsed": bool(normalized_tool_names),
        "toolNames": normalized_tool_names,
        "fallbackUsed": fallback_reason is not None,
        "fallbackReason": fallback_reason,
    }


def _summarize_lm_studio_fallback_reason(default_message: str, response_text: str | None = None) -> str:
    if not response_text:
        return default_message

    normalized = re.sub(r"\s+", " ", response_text).strip()
    if not normalized:
        return default_message
    if len(normalized) > 160:
        normalized = f"{normalized[:157].rstrip()}..."
    return f"{default_message} {normalized}"


async def _post_openai_compatible_chat(client, api_url: str, headers: dict, payload: dict) -> tuple[dict, str]:
    resp = await client.post(api_url, headers=headers, json=payload)
    resp.raise_for_status()
    data = resp.json()
    error_message = _extract_api_error_message(data)
    if error_message:
        raise ValueError(error_message)
    return data, _extract_provider_content("lm-studio", data)


def _should_fallback_lm_studio_request(status_code: int, response_text: str) -> bool:
    if status_code in {404, 405}:
        return True
    if status_code not in {400, 401, 403, 422, 500, 502, 503}:
        return False

    normalized = response_text.lower()
    return any(hint in normalized for hint in LM_STUDIO_MCP_FALLBACK_HINTS)


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
            if req.apiProvider == "lm-studio":
                lm_studio_mcp_plugin_id = _normalize_lm_studio_mcp_plugin_id(req.lmStudioMcpPluginId)
                lm_studio_mcp_metadata: dict

                if lm_studio_mcp_plugin_id:
                    if not req.apiKey:
                        data, content = await _post_openai_compatible_chat(client, req.apiUrl, headers, payload)
                        lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(
                            lm_studio_mcp_plugin_id,
                            "openai-compatible",
                            fallback_reason=(
                                "LM Studio MCP plugin access requires an API token, so the proxy used the OpenAI-compatible endpoint."
                            ),
                        )
                    else:
                        lm_studio_url = _build_lm_studio_chat_url(req.apiUrl)
                        lm_studio_payload = _build_lm_studio_chat_payload(messages, req.model, lm_studio_mcp_plugin_id)

                        try:
                            resp = await client.post(lm_studio_url, headers=headers, json=lm_studio_payload)
                            resp.raise_for_status()
                            data = resp.json()
                            error_message = _extract_api_error_message(data)
                            if error_message:
                                return {"error": f"API error: {error_message}"}

                            tool_names = _extract_lm_studio_tool_names(data, lm_studio_mcp_plugin_id)
                            content = _extract_lm_studio_message_content(data)
                            if not content and _lm_studio_response_needs_fallback(data):
                                fallback_reason = "LM Studio returned invalid MCP tool output, so the proxy retried on the OpenAI-compatible endpoint."
                                data, content = await _post_openai_compatible_chat(client, req.apiUrl, headers, payload)
                                lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(
                                    lm_studio_mcp_plugin_id,
                                    "openai-compatible",
                                    fallback_reason=fallback_reason,
                                )
                            else:
                                lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(
                                    lm_studio_mcp_plugin_id,
                                    "api-v1-chat",
                                    tool_names=tool_names,
                                )
                        except httpx.HTTPStatusError as exc:
                            response_text = exc.response.text if exc.response is not None else ""
                            if not _should_fallback_lm_studio_request(exc.response.status_code, response_text):
                                raise

                            fallback_reason = _summarize_lm_studio_fallback_reason(
                                "LM Studio MCP routing was unavailable, so the proxy retried on the OpenAI-compatible endpoint.",
                                response_text,
                            )
                            data, content = await _post_openai_compatible_chat(client, req.apiUrl, headers, payload)
                            lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(
                                lm_studio_mcp_plugin_id,
                                "openai-compatible",
                                fallback_reason=fallback_reason,
                            )
                        except httpx.TimeoutException:
                            data, content = await _post_openai_compatible_chat(client, req.apiUrl, headers, payload)
                            lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(
                                lm_studio_mcp_plugin_id,
                                "openai-compatible",
                                fallback_reason=(
                                    "LM Studio MCP routing timed out, so the proxy retried on the OpenAI-compatible endpoint."
                                ),
                            )
                else:
                    data, content = await _post_openai_compatible_chat(client, req.apiUrl, headers, payload)
                    lm_studio_mcp_metadata = _build_lm_studio_mcp_metadata(None, "openai-compatible")
            else:
                resp = await client.post(req.apiUrl, headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()

                error_message = _extract_api_error_message(data)
                if error_message:
                    return {"error": f"API error: {error_message}"}

                content = _extract_provider_content(req.apiProvider, data)

            if not content:
                return {"error": "Empty response from API. Make sure a model is loaded in your local server."}

            if req.apiProvider == "lm-studio":
                return {"content": content, "lmStudioMcp": lm_studio_mcp_metadata}

            return {"content": content}
        except ValueError as e:
            return {"error": f"API error: {str(e)}"}
        except httpx.TimeoutException:
            return {"error": "API request timed out before the model finished responding."}
        except httpx.HTTPError as e:
            return {"error": f"API request failed: {str(e)}"}
