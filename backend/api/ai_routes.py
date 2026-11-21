"""Klipper Wire Configurator - AI Chat Backend Proxy"""
import asyncio
import json
import logging
import os
import time
from collections import OrderedDict
from enum import Enum
from pathlib import Path
import re
from urllib.parse import urlparse, urlunparse

import httpx
from fastapi import APIRouter, Request
from pydantic import BaseModel

from api.printer_memory_routes import (  # noqa: E402
    derive_hardware_inventory,
    derive_machine_facts,
    format_hardware_inventory,
    load_printer_memory,
    printer_memory_to_context,
    is_printer_memory_blank,
)
from mcp_server import McpServer
from services.ai_context_overflow import (
    CONTEXT_OVERFLOW_ERROR_CODE,
    CONTEXT_OVERFLOW_MESSAGE,
    is_context_overflow_error,
    preflight_overflow,
)
from services.ai_draft_apply import extract_config_code_blocks
from services.ai_edit_tools import (
    APPROVAL_TIMEOUT_SECONDS,
    EDIT_NUDGE_TEXT,
    EDIT_NUDGE_TEXT_NATIVE,
    EDIT_PROTOCOL_PROMPT,
    EDIT_TOOL_NAMES,
    EDIT_TOOL_SPECS,
    EditSession,
    cap_grant_per_applied_write,
    create_approval,
    find_approval_for_request,
    format_approval_result,
    get_approval,
    remove_approval,
    resolve_change_chain,
    was_decided,
)

router = APIRouter()

# ── Logging ────────────────────────────────────────────────────────────
logger = logging.getLogger("kwc.ai")
logger.setLevel(logging.DEBUG)

BACKEND_DIR = Path(__file__).parent.parent
AI_CHAT_LOG = BACKEND_DIR / "ai_chat.log"

# Add handlers if none exist (avoids duplicate handlers on reload)
if not logger.handlers:
    # Console handler (stdout) for live visibility
    _console_handler = logging.StreamHandler()
    _console_handler.setLevel(logging.DEBUG)
    # File handler for persistent record
    _file_handler = logging.FileHandler(AI_CHAT_LOG, mode="a", encoding="utf-8")
    _file_handler.setLevel(logging.DEBUG)
    _formatter = logging.Formatter(
        "%(asctime)s [AI %(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    _console_handler.setFormatter(_formatter)
    _file_handler.setFormatter(_formatter)
    logger.addHandler(_console_handler)
    logger.addHandler(_file_handler)
    # Prevent propagating to root logger's handlers (avoid double output)
    logger.propagate = False


# ── Embedded MCP server for tool access ──
_mcp_server = McpServer()

# Match fenced code blocks tagged ```tool ... ```
# Captures the JSON payload which we parse with json.loads
MCP_TOOL_BLOCK_RE = re.compile(
    # The closing fence may sit on the SAME line as the JSON
    # (`{"name": ...}```) — qwen3.5-4b does this constantly (observed live
    # 2026-09-09 accuracy bank, LIVE-06/07). Requiring a newline before the
    # closer made such calls undetectable AND un-strippable: raw markup
    # reached the chat bubble. Consumers strip() the group themselves.
    r"```tool\s*\n(.+?)```",
    re.DOTALL,
)
# Alternative tool call formats emitted by models that use native
# function-calling special tokens instead of the fenced ```tool block.
# This matches <|tool_call|>, <tool_call>, and similar wrappers around
# JSON or natural-language tool call text.
# Note: \n is included as a boundary so the regex doesn't eat text
# that follows the tool call on subsequent lines.
ALT_TOOL_CALL_CONTENT_RE = re.compile(
    r"<\|?tool_call\|?>\s*(.*?)(?:</?\|?tool_call\|?>|\n|$)",
    re.DOTALL,
)
# Matches "call tool_name{...}" or "tool_name{...}" for non-JSON tool call text.
# Also accepts the llama.cpp/Qwen-style "call:tool_call:tool_name{...}" prefix
# emitted inside <|tool_call|> tokens by models with native tool templates.
# Guarded against Klipper macro syntax: the brace must NOT be a Jinja tag
# ({% / {{) and the args must contain a key-value signature (':' or '=') —
# otherwise legit macro content like "G28\n    {% endif %}" or
# "{action_respond_info(...)}" is misparsed as a tool call and the final
# cleanup strips it from the visible reply (2026-08-02: this was eating
# BED_MESH_CALIBRATE + {% endif %} and G28 + {% else %} out of correct
# model replies).
# Key-signature lookahead (`(?=[^}]*[:=])`): the args must contain a ':' or
# '=' before the first '}'. Klipper macro bodies contain the idiom
# `RESUME_BASE {get_params}` — a macro call followed by a Jinja dict — and
# without this guard it extracted a phantom zero-arg RESUME_BASE tool call
# inside a correct macro-move answer (AMBI-02 r3b run 2026-09-15). Real
# text-protocol calls always carry key=value or key: value.
CALL_SYNTAX_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?(?:tool_call[\s:]*)?(\w+)\s*\{(?!%|\{)"
    r"(?=[^}]*[:=])(.+)\}",
    re.DOTALL,
)
# Matches Python-style "function_name(arg1=\"val1\", arg2=123)" or
# "function_name(arg1: \"val1\")" without curly braces
FUNC_CALL_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?(?:tool_call[\s:]*)?(\w+)\s*\(" +
    r"(.+?)" +
    r"\)\s*(?:\n|$)",
    re.DOTALL,
)
# Cleanup regexes for stripping bare function call text from output.
# These match on line boundaries to avoid mangling prose.
# Same Jinja/key-value guards as CALL_SYNTAX_RE so Klipper macro bodies
# (G-code lines followed by {% ... %} or {action_respond_info(...)}) are
# never stripped from the visible reply.
CALL_SYNTAX_CLEANUP_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?(?:tool_call[\s:]*)?\w+\s*\{(?!%|\{)[^}]*[:=][^}]*\}\s*(?=\n|$)",
    re.DOTALL,
)
FUNC_CALL_CLEANUP_RE = re.compile(
    r"(?:^|\n)\s*(?:call[\s:]?\s*)?(?:tool_call[\s:]*)?\w+\s*\([^)]*\)\s*(?=\n|$)",
    re.DOTALL,
)
# Bracket-wrapped Python-style calls: [tool_name(arg1="val1", arg2=val2)].
# Emitted as plain text by models that know the OpenAI-style [tool(args)]
# rendering but not the configured protocol (observed 2026-08 on local
# models: [read_user_config(filename=Hotkey.cfg)] leaked into chat because
# FUNC_CALL_RE is line-anchored and the '[' defeats it). Extraction and
# cleanup are gated on KNOWN tool names so config headers ([probe]) and
# prose with parens are never treated as calls.
BRACKET_CALL_RE = re.compile(
    r"\[\s*(\w+)\s*\(\s*(.+?)\s*\)\s*\]",
    re.DOTALL,
)
# DeepSeek DSML (Data Structure Markup Language) native tool-call markup.
# DeepSeek V3.2/V4 models emit tool calls as:
#   <||DSML||tool_calls>
#   <||DSML||invoke name="search_klipper_docs">
#   <||DSML||parameter name="limit" string="false">10</||DSML||parameter>
#   <||DSML||parameter name="query" string="true">bed_mesh adaptive</||DSML||parameter>
#   </||DSML||invoke>
#   </||DSML||tool_calls>
# Some serving stacks (vLLM/sglang bugs, plain-text content mode) return this
# markup inside message.content instead of structured tool_calls, so KWC must
# parse it from text. Tolerates both ||DSML|| and |DSML| delimiters and stray
# whitespace around the pipes.
DSML_INVOKE_RE = re.compile(
    r"<\|{1,2}\s*DSML\s*\|{1,2}\s*invoke\s+name=\"([^\"]*)\"[^>]*>(.*?)"
    r"</\|{1,2}\s*DSML\s*\|{1,2}\s*invoke\s*>",
    re.DOTALL,
)
DSML_PARAM_RE = re.compile(
    r"<\|{1,2}\s*DSML\s*\|{1,2}\s*parameter\s+name=\"([^\"]*)\"[^>]*>(.*?)"
    r"</\|{1,2}\s*DSML\s*\|{1,2}\s*parameter\s*>",
    re.DOTALL,
)
# Full DSML tool_calls block; used to strip leaked markup from final content.
DSML_CLEANUP_RE = re.compile(
    r"<\|{1,2}\s*DSML\s*\|{1,2}\s*tool_calls\s*>.*?</\|{1,2}\s*DSML\s*\|{1,2}\s*tool_calls\s*>",
    re.DOTALL,
)

# Bare XML tool-call blocks (Anthropic/DeepSeek style) emitted as plain
# text when the model cannot use native tool_calls (e.g. an empty-reprompt
# sent without the tools parameter). DeepSeek V3.2/V4 "flash" models ignore
# the no-tools instruction and emit:
#   <tool_calls>
#   <invoke name="search_example_configs">
#   <parameter name="query" string="true">PC2 PB9 PC3</parameter>
#   </invoke>
#   </tool_calls>
XML_INVOKE_RE = re.compile(
    r"<invoke\s+name=\"([^\"]*)\"[^>]*>(.*?)</invoke>",
    re.DOTALL,
)
XML_PARAM_RE = re.compile(
    r"<parameter\s+name=\"([^\"]*)\"[^>]*>(.*?)</parameter>",
    re.DOTALL,
)
# Full <tool_calls>...</tool_calls> wrapper; stripped from visible content.
XML_TOOL_CALLS_CLEANUP_RE = re.compile(
    r"<tool_calls>.*?</tool_calls>",
    re.DOTALL,
)

# Orphan tool-call RESIDUE — the TAIL of a native call whose opening tokens
# the parser already consumed. Every cleanup regex above is anchored on a
# call OPENER, so a tail-only fragment survived into the chat bubble.
# Observed live 2026-09-29 (bank106-r1 sweep), three shapes:
#   * the WHOLE reply was "<parameter=filename>\nprinter.cfg\n</parameter>\n
#     </function>\n</tool_call>"            (qwen3.5-4b AMBI-07)
#   * the same block appended after prose   (qwen3.6-35B-A3B AMBI-02)
#   * a bare trailing "</tool_call>"        (qwen3.5-9b RENAME-03)
# These shapes cannot occur in Klipper config, macro, or G-code text, so the
# strip is unconditional — but the residue keeps its '<name=' form, so a
# documentation quote like "<parameter name=\"x\">" is left alone.
TOOL_RESIDUE_RE = re.compile(
    r"<parameter\s*=\s*[^>]*>.*?</parameter\s*>"
    r"|<parameter\s*=\s*[^>]*/?>"
    r"|<function\s*=\s*[^>]*/?>"
    r"|</?\|?(?:tool_calls?|function)\|?>"
    r"|<\|?tool_calls?\|?>",
    re.IGNORECASE | re.DOTALL,
)

# Prose edit protocol (fenced cfg blocks / mini-diff) RETIRED 2026-09-22 with
# the Phase-4 ratchet (.hermes/plans/2026-09-10_tool-mediated-config-editing.md):
# config edits go through config_edit/config_write + the approval card; fenced
# cfg output is display-only text. Models may still paste cfg fences in prose —
# that is fine, nothing consumes them as edits anymore.


SYSTEM_PROMPT = (
    "You are an expert Klipper firmware, configuration, and macro assistant. "
    "You help users by answering questions, editing configs, and drafting macros "
    "without inventing details.\n\n"
    "Guidelines:\n"
    "1. Keep answers short and focused.\n"
    "2. Prefer minimal targeted edits. Preserve unrelated settings, comments, and file "
    "structure unless the user explicitly asks for a larger refactor.\n"
    "3. Never invent section names, parameter names, defaults, units, commands, or supported "
    "behavior. If the bundled docs or the provided config do not confirm a detail, say so "
    "explicitly.\n"
    "4. If the request depends on unknown printer details (kinematics, probe, MCU, toolhead, "
    "bed size, macros, sensors), ask one short clarifying question unless the provided config "
    "already resolves it. Config content provided in the conversation "
    "(attached files, context sections, or read_user_config results) is "
    "already available to you — never ask the user to re-provide it.\n"
    "5. If a macro changes motion or extrusion state, preserve or restore it unless the user "
    "clearly wants persistent changes.\n"
    "6. If no safe grounded answer is possible, say what must be verified next instead of "
    "guessing.\n\n"
    "Edit protocol:\n"
    "- Before editing or answering about a config file, fetch its current "
    "content with read_user_config (or list_user_configs to see which files "
    "exist) if it is not already in your context. Never ask the user to paste "
    "content the tools can fetch.\n"
    "- When the request covers a CLASS of items ('all my LEDs', 'every fan', "
    "'all my macros'), enumerate the whole class BEFORE drafting: class "
    "members frequently live in OTHER files (toolhead/board configs), not "
    "just the attached ones. Seeing some members in the attached context is "
    "NOT proof the class is complete — sections in files you cannot see are "
    "invisible to you. Call list_hardware(type='led'|'fan'|'stepper'|...) "
    "FIRST — it enumerates EVERY member of the class in one call from "
    "the working state, with full section text and file+line (text "
    "search finds only sections whose name contains the keyword). "
    "search_user_configs with the class keyword (e.g. query='neopixel') "
    "remains a fallback for things list_hardware has no class for. "
    "Edit every member "
    "found, and before finishing, check your edit lines against the "
    "enumerated list: every member must be covered. Never silently handle "
    "only the subset visible in your context; if some files cannot be "
    "checked, name what you covered and what you could not verify.\n"
    "- When the user asks to ADD or SETUP a section or parameter, verify the "
    "exact section name and its valid parameters BEFORE writing the draft: "
    "list the supported sections with list_config_reference_sections, then "
    "fetch the exact one with get_config_reference_section(section_name=...) "
    "(or search_klipper_docs). A section absent from the user's config may "
    "still be valid Klipper. Do not invent section names or parameters from "
    "memory. Never claim a section 'does not support' a parameter or that "
    "Klipper 'lacks' a feature from memory either — check "
    "get_section_schema(section='...') first; if the schema lists it, use "
    "it. If the user did not specify values, use the documented defaults "
    "or a safe standard value and SAY what you chose — do not ask the user "
    "to provide values the reference already documents.\n"
    "- For macros: valid Klipper syntax, conservative motion and temperature behavior. Never "
    "drop, reorder, or reword lines that were not part of the request.\n"
    "- When asked to validate or error-check a macro or g-code, check execution "
    "prerequisites, not just syntax — e.g. BED_MESH_CALIBRATE needs homed axes (G28 "
    "first), G1 E moves need an active extruder with temperature. Name the missing "
    "prerequisite explicitly in your answer.\n"
    "- After config or macro code, briefly explain what changed, why, and cite the exact "
    "documentation section header and parameter or command names you relied on.\n"
    "- Klipper G-code commands and macro names (G28, M104, BED_MESH_CALIBRATE, "
    "SET_FAN_SPEED, PRINT_START, etc.) are NOT tools — never invoke them as "
    "tool calls.\n"
    "- After edits are applied, the FINAL reply must not re-quote the edited "
    "config as fenced code blocks — quote section and parameter names inline "
    "instead. The edited text is already visible to the user in the review "
    "pane, and pasting a block there is a duplicate that reads as an unsaved "
    "draft. The restriction covers ONLY content the review pane already "
    "shows: when nothing was staged and the user asked for a snippet or "
    "template as text (e.g. 'return it as a cfg block'), include the "
    "fenced block — it is the only way the user sees what you wrote.\n"
)


class AiProvider(str, Enum):
    chatgpt = "chatgpt"
    google = "google"
    anthropic = "anthropic"
    github = "github"
    openai_compatible = "openai-compatible"

class ModelsRequest(BaseModel):
    """Model-list proxy request — mirrors the fields the chat proxy needs."""
    apiKey: str = ""
    apiUrl: str = "https://api.openai.com/v1/chat/completions"
    apiProvider: AiProvider = AiProvider.chatgpt


class ContextWindowRequest(ModelsRequest):
    """W7 context-window probe: the same credentials plus the active model."""
    model: str = ""


class ChatRequest(BaseModel):
    messages: list[dict]
    apiKey: str
    model: str = "gpt-4o"
    apiUrl: str = "https://api.openai.com/v1/chat/completions"
    apiProvider: AiProvider = AiProvider.chatgpt
    requestId: str | None = None
    maxTokens: int = 4096
    # Sampling temperature. None = use the provider's default for the
    # request type (0.1 for OpenAI-compatible, Anthropic's default otherwise).
    temperature: float | None = None
    # Loaded user-config content sent by the frontend (filename ->
    # {"content", "label"}) for the config-grounding fallback. Held
    # server-side only — it is NOT injected into the first prompt; the
    # fallback uses it when the model answers without calling any tool.
    contextFiles: dict[str, dict[str, str]] = {}
    # Tool-calling protocol override (frontend setting / harness runs).
    # "auto" (default) uses NATIVE function calling for every provider,
    # local llama.cpp included — the machine channel keeps protocol text out
    # of prompts and results out of user-role messages (verified b456
    # --jinja 2026-09); the loop still regex-extracts text calls as a
    # fallback. "text" forces the ```tool protocol (escape hatch for
    # servers that advertise tools but emit template garbage); "native"
    # pins native explicitly. scripts/ai_chat_accuracy_test.py A/Bs these.
    toolProtocol: str = "auto"
    # Tool-mediated editing override (harness A/B runs ONLY; the frontend
    # never sends it). The write tools are unconditional product behavior
    # since the Phase-6 flag removal (2026-09-24); True/False forces
    # them on/off for this request only (False = read-only arm). Mirrors
    # the toolProtocol precedent so A/B runs don't need backend restarts.
    editTools: bool | None = None
    # Skill-gate override (harness A/B runs ONLY; the frontend never
    # sends it). The model-triggered skill gate is product behavior:
    # write tools stay hidden until the model calls load_skill itself.
    # True forces the skill ACTIVE for the request (write tools advertised
    # immediately) so SKILL-* evals can grade traces on both arms;
    # None/False = the model must call load_skill to unlock the write
    # tools.
    editSkill: bool | None = None
    # Names of skills whose load_skill ACTUALLY ran in THIS conversation
    # (W4-R2 generalization of the W0 editSkillLoaded boolean — single
    # path, the boolean is deleted). Derived by the CLIENT from its stored
    # tool trace (frontend/src/utils/chatSkillTrace.ts): the frontend's
    # lean replay strips native tool_calls, so without this the gate
    # re-closes on every follow-up turn and sticky knowledge bodies are
    # lost. Conversation-scoped (derived per send from the conversation's
    # own trace, never a global setting). config-editing here STARTS the
    # request armed (atomic armament: tools + body move together); STICKY
    # non-gating skills here (macro-authoring) re-inject their body at the
    # trailing seam. Knowledge names NEVER arm write tools by themselves —
    # gates_write in _SKILL_REGISTRY is the only unlock. The harness
    # editSkill override above still wins for the edit gate.
    loadedSkills: list[str] = []
    # Conversation work-ledger (W6): per-section outcomes of the model's
    # own write tools across earlier turns — staged rows plus the human's
    # kept/undone review decisions plus failures with the harness's error
    # line. Derived client-side (utils/chatWorkLedger + workLedgerStore):
    # the review ledger splices silently and the lean replay strips tool
    # results, so kept/undone is the ONE record that exists only on the
    # client. Same trust class as editSkillLoaded/contextFiles (the client
    # is ground truth for its own state). The backend renders it verbatim
    # as one trailing system message and NEVER decides anything from it
    # (review law: the backend re-delivers the record, decisions stay
    # client-side); names + verdicts only, no payloads.
    workLedger: list[dict] = []
    # C1 ledger byte-stability: the client's user-message count at send
    # time (the absolute turn the ledger is rendered against). With rows
    # carrying absolute turnOrdinal values the rendered '- turn N:'
    # headers stop recomputing every send — the merged system prefix
    # stays byte-identical turn to turn and the provider's prefix cache
    # keeps hitting. Absent = legacy client: rows render via turnOffset
    # with the old relative labels.
    workLedgerCurrentTurn: int | None = None
    # Approval-gate override (harness A/B runs ONLY; the frontend never
    # sends it). INERT since the post-hoc review change (2026-10-02):
    # nothing in the edit path suspends, so there is no wait to skip and
    # nothing reads this field today — this declaration is its only
    # occurrence in the backend.
    #
    # KEPT ON PURPOSE as the bypass hook for the DORMANT gate. When the
    # first IRREVERSIBLE tool lands (a disk write, a firmware restart, a
    # command sent to the printer) the gate gets a caller back, and a
    # bank question covering that tool needs this flag to run past the
    # card. See the REVIVAL note on _run_approval_gate for the wiring.
    #
    # It never guarded against a 422 — pydantic ignores unknown request
    # fields (ChatRequest sets no extra="forbid"), so a stale sender
    # cannot fail here either way. The hook is the only reason to keep it.
    #
    # Do NOT point this at an IRREVERSIBLE tool without deciding that
    # deliberately: a blanket harness auto-approve on the irreversible
    # class is exactly what the gate exists to prevent.
    autoApproveEdits: bool = False
    # Merge every system message into a single leading system message.
    # Default off: most OpenAI-compatible servers accept multiple system
    # messages and the trailing task anchor is positionally meaningful
    # (it points the model at the last user message after tool rounds).
    # Some strict chat templates (e.g. models enforcing "system message
    # must be at the beginning") reject any non-leading system message.
    # Merge is now the DEFAULT for every OpenAI-compatible request — a
    # single leading system message is the canonical shape every server
    # accepts. Set False explicitly only for A/B testing the trailing
    # task-anchor position.
    # C2 (2026-11-20): the DEFAULT FLIPPED to False. Merging every system
    # block into messages[0] is what parked the volatile work-ledger AHEAD of
    # the replayed transcript, so its first-appearance byte busted ~11K tokens
    # of cache. Strict system-first templates (Qwen3.x) are now answered by
    # the wire-shape ladder in _query_provider instead of by this flag, which
    # stays available as an explicit override.
    mergeSystemMessages: bool = False
    # Explicitly attached context from the docked text-view panel: highlighted
    # line ranges and pinned tree rows, each with the findings in its scope as
    # the FRONTEND resolved them (severity visibility is frontend state, so the
    # server cannot re-derive which tiers the user wants to see).
    #
    # Rendered server-side into one extra system message. Empty (the default)
    # adds nothing at all, so an ordinary turn's prompt is byte-identical to
    # what it was before this feature existed.
    context_references: list[dict] = []
    # W8 pre-flight: the REAL context window the CLIENT already probed via
    # /ai/context-window (W7's store), sent per request so the backend can
    # refuse an obviously-over prompt without spending a provider call —
    # llama.cpp hangs rather than errors on over-long prompts, and the chat
    # path has no response timeout by design. Null/omitted = unknown window
    # = no block (W7 law: silence over guessing); harness and older clients
    # never send it.
    knownContextWindow: int | None = None
    # Prose-draft machinery (the fullRewriteGuard request field, server-side
    # draft validation/audit, and the KWC_SERVER_DRAFT_VALIDATION /
    # KWC_POST_APPLY_AUDIT env switches) was removed with the Phase-4 ratchet
    # (2026-09-22): prose→draft ingestion no longer exists.


@router.get("/ai/chat/approval")
async def chat_approval_poll(requestId: str = ""):
    """Poll the pending approval card for an in-flight /ai/chat request.

    The chat request itself stays open while the loop suspends on the
    approval Future (plan §97); the frontend discovers the card through
    this lightweight poll. ``{pending: false}`` when no card is open.
    """
    if not requestId:
        return {"pending": False}
    approval = find_approval_for_request(requestId)
    if approval is None:
        return {"pending": False}
    return {"pending": True, **approval.card_payload()}


class ApprovalDecisionRequest(BaseModel):
    approvalId: str
    decision: str  # "approve" | "decline"
    reason: str = ""
    # Frontend's latest working content at decision time ({file: {content,
    # label}}). An approve re-applies the op against THIS state — a manual
    # edit during the pending window can invalidate an anchor or create a
    # new error (never clobber).
    contextFiles: dict[str, dict[str, str]] = {}


@router.post("/ai/chat/approval")
async def chat_approval_decide(req: ApprovalDecisionRequest):
    """Resolve a pending approval card.

    approve  → op re-validated+committed against contextFiles (when
               provided); decision accepted only if clean. On anchor
               miss / new errors the decision is NOT accepted:
               {status: 'invalidated', reason} and the card stays open
               (user can decline or resolve the conflict and retry).
    decline  → accepted immediately; the model loop resumes with an
               honest declined tool result.
    """
    approval = get_approval(req.approvalId)
    if approval is None:
        # A decided-then-removed card answers already_decided, not
        # not_found (race: the loop completed between the first decision
        # and this POST). See remove_approval()'s tombstone.
        if was_decided(req.approvalId):
            return {"status": "already_decided"}
        return {"status": "not_found"}
    if req.decision not in ("approve", "decline"):
        return {"status": "invalid", "reason": "decision must be approve or decline"}
    outcome = approval.decide(
        req.decision,
        reason=req.reason[:500],
        context_files=req.contextFiles or None,
    )
    logger.info(
        "Approval decision | approvalId=%s decision=%s outcome=%s",
        req.approvalId, req.decision, outcome.get("status"),
    )
    return outcome


class ChatStopRequest(BaseModel):
    requestId: str


class ChatSteerRequest(BaseModel):
    requestId: str
    message: str


# Mid-loop steering (2026-10-02): user speech injected at the next tool-turn
# boundary of an IN-FLIGHT request. The channel is the same request id the
# progress poll uses, symmetrically (GET /ai/chat/progress -> pollChatProgress,
# POST /ai/chat/steer -> the steer). Queued, not applied inline: the loop is
# already turn-by-turn, so the boundary is free and no generation is ever
# cancelled mid-provider-call.
_chat_steers: dict[str, list[str]] = {}
STEER_MAX_CHARS = 2000


def _drain_steers(request_id: str | None) -> list[str]:
    """Take every steer queued for this request (in arrival order)."""
    if not request_id:
        return []
    return _chat_steers.pop(request_id, []) or []


class ChatStoppedError(Exception):
    """Raised when the user requests to stop the current AI chat request."""


# Registry of in-flight chat request stop events, keyed by client requestId.
_chat_stop_events: dict[str, asyncio.Event] = {}

# ── Mid-loop progress registry (Phase 6.5) ──
# Mirrors _chat_stop_events: registered by chat_proxy when a requestId is
# present, popped in its finally. Entries are written at the tool-loop emit
# point — after tool calls are EXTRACTED (canonical loop state), BEFORE
# execution — so GET /ai/chat/progress never observes in-flight-only
# guesses. Invariants carried from Hermes (response-loss class #65919):
# progress narration NEVER counts as the final answer — the registry is
# display state, fully disjoint from final_content.
_chat_progress: dict[str, dict] = {}

# Trailing-sentence tail of the ack guard's injected correction. Kept
# separate from the tool-availability prefix so tests can assert the guard
# picked the arm matching the CURRENT tool surface (locked vs unlocked).
_ACK_GUARD_TAIL = (
    " Do not describe the change in prose — an edit written in chat text "
    "is inert. Keep going with the tools."
)

# Continue-intent promise shapes: the model announces it WILL do the work
# and ends the turn with no tool call (the 2026-09 qwen-class ack loops).
# Sentence-level match only: the tail check requires the promise to sit at
# the END of the reply, so "I will read the file now. Here is what it
# means: ..." (an answered question) never matches.
_CONTINUE_INTENT_RE = re.compile(
    r"\b(?:i(?:'ll| will)|let me|i'd better|i can now|i need to (?:now )?make|"
    r"now i(?:'ll| will)|next i(?:'ll| will)|i am going to|i'm going to)\b",
    re.IGNORECASE,
)

# Clarifying-question shapes on the TAIL: the model asked the user
# something (interrogative phrase, or the sentence ends on '?'). These
# are an interaction, not a stall — checked BEFORE the promise match so
# 'I'll update max_accel — which value do you want?' stays unanswered
# (final-pass review 2026-09-29).
# Round-2 review 2026-09-29: bare 'which'/'what' triggers over-exempted —
# relative clauses ("I'll apply the change which corrects the offset
# now.") are promises, not asks. Interrogatives must be tied to the
# USER (do you / should I / you want...) or a final '?'.
_CLARIFYING_TAIL_RE = re.compile(
    r"(?:\?|do you (?:want|prefer|mean|need)|should i|let me know|"
    r"i(?:'ll| will) need to know|i need (?:you to|which)|need your input|"
    r"\b(?:which|what)(?:\s+\S+)?\s+(?:do|does|would|should|can|will)\s+(?:i|you)\b)",
    re.IGNORECASE,
)


def _ends_with_continue_intent(content: str) -> bool:
    """True when the reply ENDS on a promise to act rather than an answer.

    The ack guard fires only on a promise-shaped TAIL: strip tool-call
    markup, take the last non-empty paragraph/sentence, and match
    _CONTINUE_INTENT_RE against it. A full answer that merely mentions a
    future action early ("I will read the file now. Here is what it
    means: ...") has a non-matching tail and is left alone — answering is
    never gaslit (Q20 r3/B lesson).

    Final-pass review 2026-09-29: a tail that ASKS the user something is
    also never continue-intent. 'Let me know which fan you mean' and
    \"I'll need to know which extruder\" matched the promise regex, so the
    guard answered an honest clarifying question with 'Execute the edit
    now — do not describe it', forcing a guess between real candidates.
    """
    text = MCP_TOOL_BLOCK_RE.sub("", content)
    text = ALT_TOOL_CALL_CONTENT_RE.sub("", text)
    text = CALL_SYNTAX_CLEANUP_RE.sub("", text)
    text = FUNC_CALL_CLEANUP_RE.sub("", text)
    text = _strip_bracket_tool_calls(text)
    text = DSML_CLEANUP_RE.sub("", text)
    text = XML_TOOL_CALLS_CLEANUP_RE.sub("", text)
    text = text.strip()
    if not text:
        return False
    # The promise must START the closing sentence — a whole-line match
    # window would false-positive on full answers that merely mention a
    # future action early ("I will check the docs. <the actual answer>").
    tail = text.splitlines()[-1].strip()
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", tail) if s.strip()]
    tail = sentences[-1] if sentences else tail
    if _CLARIFYING_TAIL_RE.search(tail):
        return False
    return bool(_CONTINUE_INTENT_RE.match(tail))


@router.post("/ai/chat/stop")
async def chat_stop(req: ChatStopRequest):
    """Signal an in-flight /ai/chat request to stop processing."""
    event = _chat_stop_events.get(req.requestId)
    logger.info(
        "Stop lookup | requestId=%s found=%s registry_size=%d",
        req.requestId, event is not None, len(_chat_stop_events),
    )
    if event is None:
        return {"stopped": False}
    event.set()
    return {"stopped": True}


@router.post("/ai/chat/steer")
async def chat_steer(req: ChatSteerRequest):
    """Queue a mid-request steer: a real user message for the next turn.

    Not a tool result and not a system nudge — this codebase has a
    documented pathology where machine text sent in the user role gets
    addressed back as if the user had said it, and a steer is the one
    thing here that genuinely IS user speech.

    ``{accepted: false}`` when the request is not in flight (already
    finished, stopped, or unknown): the caller's UI should treat the
    message as a fresh turn instead.
    """
    text = (req.message or "").strip()
    if not req.requestId or not text:
        return {"accepted": False, "reason": "empty steer"}
    if req.requestId not in _chat_stop_events:
        return {"accepted": False, "reason": "no in-flight request"}
    queue = _chat_steers.setdefault(req.requestId, [])
    queue.append(text[:STEER_MAX_CHARS])
    logger.info(
        "Steer queued | requestId=%s chars=%d queue=%d",
        req.requestId, len(text), len(queue),
    )
    return {"accepted": True, "queued": len(queue)}


@router.get("/ai/chat/progress")
async def chat_progress_poll(requestId: str = ""):
    """Poll mid-loop progress for an in-flight /ai/chat request (Phase 6.5.3).

    Shape mirrors the /ai/chat/approval poll rail: no requestId or no
    in-flight entry -> {pending: false}. While the loop runs, returns the
    latest extracted-but-not-yet-executed tool batch plus the turn's
    narration, so the UI can show a subordinate progress strip during long
    tool chains. Display-only: nothing here ever feeds the final answer.

    Also carries the request's staged edits (post-hoc review, 2026-10-02):
    the change set is applied to the working overlay as it accumulates, so
    the transcript rows and the editor are a live view of the same set —
    not a summary reconstructed after the fact.
    """
    if not requestId:
        return {"pending": False}
    entry = _chat_progress.get(requestId)
    if entry is None:
        return {"pending": False}
    payload = {
        "pending": True,
        "turn": entry["turn"],
        "toolNames": list(entry["toolNames"]),
        "narration": entry["narration"],
        "elapsedMs": int((time.monotonic() - entry["startedAt"]) * 1000),
    }
    staged = entry.get("stagedEdits")
    if staged:
        payload["stagedEdits"] = staged
        payload["changeSet"] = entry.get("changeSet")
    return payload


# ── Change-set registry (post-hoc edit review, 2026-10-02) ──
# A request's change set outlives the request: the user reviews it after
# the reply lands, and every keep/undo is a REPLAY of the kept ops onto
# the pre-request baseline (never a text revert), which needs the ops and
# the baseline the session holds. Bounded LRU — a session is a handful of
# file texts plus the op records, and only the most recent conversations
# can still be on screen. Registered only when the request actually
# staged something, so a pure Q&A turn keeps nothing alive.
#
# The bound is generous because the change set is a RUNNING TOTAL: a
# decision can span edits staged across many messages, so every request
# still carrying unreviewed edits has to stay resolvable.
_edit_sessions: "OrderedDict[str, EditSession]" = OrderedDict()
_EDIT_SESSIONS_MAX = 32


def register_edit_session(request_id: str | None, session) -> None:
    """Make a request's session (and so its change set) reachable by id.

    Called when the request STARTS, not when it ends: the user reviews and
    undoes while the model is still working — a group of staged edits can be
    thrown away long before the reply lands — so a session that only became
    resolvable at the end made every mid-loop decision answer 'not_found'
    (live UI find, 2026-10-02). The session object is shared by reference,
    so the registry always sees the live, growing change set.
    """
    if not request_id or session is None:
        return
    _edit_sessions[request_id] = session
    _edit_sessions.move_to_end(request_id)
    while len(_edit_sessions) > _EDIT_SESSIONS_MAX:
        _edit_sessions.popitem(last=False)


def get_edit_session(request_id: str | None):
    if not request_id:
        return None
    session = _edit_sessions.get(request_id)
    if session is not None:
        _edit_sessions.move_to_end(request_id)
    return session


def _publish_staged_edits(request_id: str | None, session) -> None:
    """Publish the accumulating change set to the progress poller.

    Called after every staging write (canonical loop state: the op is
    already in the working state, so this is a read of the session, never
    a prediction). ``stagedEdits`` mirrors the final response's
    ``pendingEdits`` shape — per-file NET text — so the client applies
    snapshots idempotently as they arrive instead of replaying deltas.
    """
    if not request_id or session is None:
        return
    entry = _chat_progress.get(request_id)
    if entry is None:
        return
    entry["stagedEdits"] = session.pending_edits_payload()
    entry["changeSet"] = session.change_set_payload()


class ChangeSetSegment(BaseModel):
    """One request's share of a change set, in the order it was made."""
    requestId: str
    # The edit ids this request KEPT. Everything else it staged is dropped.
    keptEditIds: list[str] = []
    # The ids the user has DECIDED to keep (undecided ones excluded): the
    # frame the text view's pane diffs against, so its marks follow the
    # decisions. Empty means "nothing decided" — the pane falls back to the
    # file's pre-review text.
    frameKeptEditIds: list[str] = []


class ChangeSetResolveRequest(BaseModel):
    # Single-request form (kept for the harness + older clients).
    requestId: str = ""
    keptEditIds: list[str] = []
    # Multi-request form: the change set is a RUNNING TOTAL, so a decision can
    # cover edits staged by several requests. Chronological order matters —
    # each request's ops replay onto the state the previous one left.
    segments: list[ChangeSetSegment] = []
    # The frontend's current working text ({file: {content, label}}). Used
    # only to detect a file the human edited (hard rule 6): their text wins
    # and stale anchors are reported instead of clobbered.
    contextFiles: dict[str, dict[str, str]] = {}


@router.get("/ai/chat/changes")
async def chat_changes(requestId: str = ""):
    """The change set of a recent request (rows + grouped summary)."""
    session = get_edit_session(requestId)
    if session is None:
        return {"found": False}
    return {"found": True, **session.change_set_payload()}


@router.post("/ai/chat/changes/resolve")
async def chat_changes_resolve(req: ChangeSetResolveRequest):
    """Keep/undo a change set (or a chain of them): replay the kept ops.

    Undo is ``replay(kept ops, baseline)`` — never a text revert — so a
    rejected op cannot leave residue behind, including residue a later op
    depended on. Ops whose anchors no longer apply come back in ``stale``
    with an honest reason; nothing is forced through.

    A segment whose session is gone (server restart, LRU eviction) fails the
    whole call rather than replaying a partial chain: the text that would come
    back silently drops the missing request's edits.
    """
    specs = list(req.segments)
    if not specs and req.requestId:
        specs = [ChangeSetSegment(requestId=req.requestId,
                                  keptEditIds=req.keptEditIds)]
    if not specs:
        return {"status": "not_found"}

    chain = []
    missing: list[str] = []
    for spec in specs:
        session = get_edit_session(spec.requestId)
        if session is None:
            missing.append(spec.requestId)
            continue
        chain.append((session, spec.keptEditIds, spec.requestId))
    if missing:
        logger.warning(
            "Change set resolve | missing sessions requestIds=%s", missing)
        return {"status": "not_found", "missing": missing}

    outcome = resolve_change_chain(chain, req.contextFiles or None)
    logger.info(
        "Change set resolved | segments=%d files=%d stale=%d",
        len(chain), len(outcome.get("files", {})),
        len(outcome.get("stale", [])),
    )

    # The pane's FRAME (Sir, 2026-10-03): the same chain replayed with only
    # the ops the user has DECIDED to keep, so the text view can diff "the
    # document as far as the decisions go" against the document now and mark
    # exactly what is still awaiting a decision. With nothing decided the
    # frame IS the baseline, which the change-set payload already carries, so
    # this pass is skipped — no work, no field, and the client falls back to
    # the pre-review text it was given.
    if any(spec.frameKeptEditIds for spec in specs):
        frame_chain = [
            (session, spec.frameKeptEditIds, spec.requestId)
            for spec, (session, _kept, _rid) in zip(specs, chain)
        ]
        frame = resolve_change_chain(frame_chain, None, update_pushed=False)
        outcome["frames"] = {
            file_name: entry.get("content", "")
            for file_name, entry in (frame.get("files") or {}).items()
            if not entry.get("deleted")
        }
    return outcome


def _is_local_provider(provider: str, api_url: str = "") -> bool:
    """Check if the provider is a local server (OpenAI Compatible).

    OpenAI-compatible endpoints on plain http are local servers (LM Studio,
    Ollama, llama.cpp on the LAN): auth optional, text-based ```tool
    protocol. https endpoints are cloud OpenAI-compatible APIs (DeepSeek,
    OpenRouter, Groq, ...): they get the cloud treatment — required API key
    and native function calling.
    """
    if provider != "openai-compatible":
        return False
    return not api_url.strip().lower().startswith("https://")


def _get_openai_compatible_default_url(provider: str) -> str:
    """Get the default API URL for an OpenAI-compatible provider."""
    defaults = {
        "chatgpt": "https://api.openai.com/v1/chat/completions",
        "google": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        "openai-compatible": "http://localhost:11434/api/chat",
    }
    return defaults.get(provider, "")


CONTEXT_REFERENCE_FINDING_CAP = 20


def _reference_basename(path: str) -> str:
    return path.replace("\\", "/").rsplit("/", 1)[-1]


def _reference_label(ref: dict) -> str:
    """One-line heading for a reference — mirrors the panel's chip label."""
    name = _reference_basename(str(ref.get("file") or ""))
    kind = str(ref.get("kind") or "")
    if kind == "lines":
        start = ref.get("startLine")
        end = ref.get("endLine")
        if start == end:
            return f"{name}:{start}"
        return f"{name}:{start}-{end}"
    if kind == "section":
        return f"{name}:[{ref.get('section') or ''}]"
    if kind == "param":
        return f"{name}:[{ref.get('section') or ''}] {ref.get('param') or ''}".rstrip()
    if kind == "finding":
        return f"{ref.get('severity') or 'info'} · line {ref.get('line') or '?'}"
    return name


def render_context_references(references: list | None) -> str | None:
    """Render user-attached context as ONE trailing system message.

    Returns None when nothing usable is attached, so an ordinary turn's prompt
    is byte-identical to what it was before this feature existed.

    Rendered HERE rather than on the client on purpose: the block is prompt
    content, and this is where every other prompt element is built. Keeping a
    second formatter in TypeScript would mean two sources of truth for one
    format, drifting the moment either side is reworded. The client sends
    structured references — findings included, already filtered through the
    user's severity-visibility settings, which is frontend state the server
    cannot see.
    """
    if not references:
        return None

    parts = [
        "CONTEXT THE USER ATTACHED TO THIS MESSAGE",
        "These are the exact regions of the user's project they pointed at. "
        "Treat them as the subject of the question — do not ask which part of "
        "the config they mean.",
    ]

    rendered = 0
    for ref in references:
        if not isinstance(ref, dict):
            continue
        rendered += 1
        body = [f"[{rendered}] {_reference_label(ref)}"]

        text = ref.get("text")
        if isinstance(text, str) and text.strip():
            start = ref.get("startLine")
            if not isinstance(start, int) or start < 1:
                start = 1
            body.append("\n".join(
                f"{start + offset}| {line}"
                for offset, line in enumerate(text.splitlines())
            ))

        findings = ref.get("findings")
        if isinstance(findings, list) and findings:
            body.append(f"findings in [{rendered}]:")
            for finding in findings[:CONTEXT_REFERENCE_FINDING_CAP]:
                if not isinstance(finding, dict):
                    continue
                body.append(
                    f"  - {finding.get('severity') or 'info'} · "
                    f"line {finding.get('line_number')}: {finding.get('message') or ''}"
                )

        parts.append("\n".join(body))

    if rendered == 0:
        return None
    return "\n\n".join(parts)


# ── W3: runtime-error trailing observation ─────────────────────────────────
#
# A pasted Klipper runtime error quotes the RENDERED command line
# (klippy/gcode.py get(): "Error on '%s'" % self._commandline) — never a
# macro or a source line. When the latest user message carries such a
# frame, the harness traces it through the project's macros with the W2
# render engine and attaches ONE trailing system observation naming the
# provenance. Intent-law clean: literal frame extraction + deterministic
# render matching; the output can only be a useless note, never a reroute.
# Silence is the default (no frame / no match / no files / ablation), and
# a trace failure can never break the chat turn.


def _project_trace_sources(context_files: dict | None) -> list:
    """MacroTraceSource per macro section — staged (client) files FIRST,
    then the disk mirror; a staged file shadows the same-named mirror
    entry (same precedence as the edit-session seed, drafts win)."""
    from parser.config_parser import parse_config
    from parser.macro_render import MacroTraceSource

    sources = []
    seen_names: set[str] = set()
    buckets = [list((context_files or {}).items())]
    try:
        buckets.append(list(_mirror_user_config_files().items()))
    except Exception:
        # mirror unreadable → staged files alone still trace; keep the
        # fail-safe but make it observable (review B-L4, 2026-11-14)
        logger.warning("trace mirror unreadable", exc_info=True)
    for entries in buckets:
        for fname, entry in entries:
            if fname in seen_names:
                continue
            seen_names.add(fname)
            text = str((entry or {}).get("content", ""))
            if "gcode_macro" not in text and "delayed_gcode" not in text:
                continue
            try:
                parsed = parse_config(text, filename=fname)
            except Exception:
                logger.warning("trace source unparsable (%s) — skipped",
                               fname, exc_info=True)
                continue
            for section in parsed.sections:
                if section.is_commented_out:
                    continue
                if section.section_type not in ("gcode_macro",
                                                "delayed_gcode"):
                    continue
                body = section.get_value("gcode")
                # The parser's value keeps the newline right after
                # 'gcode:' as a phantom empty line 1; drop it so body
                # line 1 is the first command — the same convention the
                # validate_macro facade uses, so both channels number
                # identically.
                body = body.lstrip("\n")
                if not body.strip():
                    continue
                params = {
                    p.key[len("params_"):].lower(): p.value
                    for p in section.params
                    if p.key.startswith("params_") and not p.is_commented_out
                }
                variables = {
                    p.key[len("variable_"):]: p.value
                    for p in section.params
                    if p.key.lower().startswith("variable_")
                    and not p.is_commented_out
                }
                sources.append(MacroTraceSource(
                    name=section.full_header, body=body,
                    params=params, variables=variables, file=fname))
    return sources


def _runtime_error_observation(messages: list[dict],
                               context_files: dict | None) -> str | None:
    """Trailing-observation text when the latest user message quotes a
    Klipper runtime error whose frame a project macro renders — None in
    every other case (fast literal pre-check first: most turns pay
    nothing)."""
    from parser.macro_render import extract_error_frames, trace_runtime_error

    last_user = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            c = m.get("content")
            last_user = (c if isinstance(c, str)
                         else " ".join(str(p) for p in (c or [])))
            break
    if "Error on " not in last_user:
        return None
    frames = extract_error_frames(last_user)
    if not frames:
        return None
    sources = _project_trace_sources(context_files)
    if not sources:
        return None
    matches = trace_runtime_error(frames, sources)
    if not matches:
        return None
    # Observation budget (review B-L5, 2026-11-14): a generic rendered
    # line can match dozens of macros — 60 matches measured 5 KB and
    # ~0.9 s injected per turn. Show the first five, name the rest.
    _CAP = 5
    lines = [
        f"- `{m.file}` [{m.macro}] body line {m.source_line}: "
        f"`{m.source_text}`  (renders: `{m.rendered}`)"
        for m in matches[:_CAP]
    ]
    if len(matches) > _CAP:
        lines.append(f"- (… {len(matches) - _CAP} more matches truncated — "
                     "the candidate set is larger than shown)")
    out = ("[Runtime error trace — deterministic] The Klipper error quoted "
           "in the latest message matches how these project macros render "
           "with default params (the error itself carries only the RENDERED "
           "command):\n" + "\n".join(lines))
    if len({m.macro for m in matches}) > 1:
        out += ("\nThe failing line is among these candidates — present them "
                "instead of asserting one.")
    return out


def _prepare_messages(messages: list[dict],
                      edit_capable: bool = False, *,
                      skill_active: bool = False,
                      native_mode: bool = False,
                      context_files: dict | None = None,
                      context_references: list | None = None,
                      inject_edit_skill_body: bool = False,
                      loaded_skills: list | None = None,
                      work_ledger: list | None = None,
                      work_ledger_current_turn: int | None = None) -> list[dict]:
    """Build a clean system prompt with MCP tool descriptions, printer memory,
    and user messages.
    """
    minimal = _minimal_prompt_enabled()
    system_prompt = SYSTEM_PROMPT
    no_system = _no_system_prompt_enabled()

    # ── Inject printer memory context ──
    memory = load_printer_memory()
    memory_context = printer_memory_to_context(memory)
    memory_blank = is_printer_memory_blank(memory)

    if no_system:
        # Experiment gate: no system content at all — no tools, no prompt,
        # no memory, no anchor. Just the conversation.
        system_parts: list[str] = []
    elif minimal:
        # Experiment gate: tools only — no SYSTEM_PROMPT, no printer memory,
        # no auto-fill, no task anchor.
        system_parts = [_build_mcp_tool_context()]
    else:
        # All tools are advertised unconditionally (native/text parity);
        # detect_board and other niche helpers live under "Specialized tools".
        tool_context = _build_mcp_tool_context(edit_capable=edit_capable,
                                               skill_active=skill_active,
                                               native_mode=native_mode)
        system_parts = [system_prompt, tool_context, memory_context]
        # The edit law travels inside the load_skill tool result (skill
        # body), persisting in conversation history exactly once — it is
        # never in the system prompt (the model-triggered skill gate is
        # product behavior since the Phase-6 flag removal).

        # If printer memory is completely blank and there are user messages
        # to work with, add an auto-fill instruction asking the AI to
        # investigate.
        if memory_blank:
            auto_fill_prompt = (
                "\n---\n"
                "**Printer Memory Auto-Fill**\n\n"
                "The printer memory above is blank. Fill it in using the config files and tools below:\n"
                "1. Examine the user's config files passed as context for clues about the mainboard, "
                "toolhead board, kinematics, probe type, etc.\n"
                "2. Use `search_example_configs` with board/printer/MCU keywords from the config, then "
                "`read_example_config` on the best matches. Use `search_klipper_docs` and "
                "`get_config_reference_section` to confirm details. Correlate with "
                "the user's config — e.g. a Voron 2.4 usually uses CoreXY kinematics.\n"
                "3. For any field you cannot determine, ask the user to provide it.\n"
                "4. Return your proposal in a fenced `printer-memory` code block containing ONLY valid "
                "JSON — no surrounding explanation or markdown inside the block. Only these 9 fields "
                "are allowed; unsupported fields will be rejected: mainboard, toolheadBoard, "
                "expanderBoards, printerName, kinematics, probe, buildVolume, extruderType, "
                "additionalNotes. extruderType accepts ONLY 'direct' or 'bowden'. Omit fields you "
                "cannot determine — never guess.\n"
                "   ```printer-memory\n"
                "   {\"mainboard\": \"BTT Octopus Pro v1.1\", \"kinematics\": \"CoreXY\", "
                "\"buildVolume\": \"250x250x210\", \"extruderType\": \"direct\"}\n"
                "   ```\n"
                "The user confirms in a review dialog before anything is saved — do NOT save printer "
                "memory directly."
            )
            if edit_capable:
                # The full fact-finding playbook lives in the
                # printer-memory skill; the prompt points there instead
                # of duplicating it. (load_skill is only advertised when
                # the request is edit-capable.)
                auto_fill_prompt += (
                    "\nCall load_skill(name='printer-memory') first — it "
                    "lists exactly where each field's evidence lives in "
                    "the config."
                )
            # Mechanical head-start: kinematics and build volume are
            # derivable from stepper limits (Macro Designer parity —
            # derive_machine_facts), so the server derives them NOW and
            # hands them over verbatim. The model must not re-derive
            # them, and must not ASK for a value the server already
            # computed.
            texts = [
                str((entry or {}).get("content", ""))
                for entry in (context_files or {}).values()
            ]
            try:
                facts = derive_machine_facts(texts)
            except Exception:
                # Review fix 2026-09-26: silently degrading to {} hid
                # derivation bugs entirely; keep the fail-safe but make
                # it observable (sibling seeds use logger.exception).
                logger.exception("Machine-fact derivation failed | prompt degrades to no-facts")
                facts = {}
            if facts:
                known = ", ".join(f"{k}={v}" for k, v in facts.items())
                auto_fill_prompt += (
                    "\n\nDERIVED MACHINE FACTS (computed from the user's "
                    f"config by the app, treat as ground truth): {known}. "
                    "Include these in your block verbatim — do NOT ask "
                    "the user about them."
                )
            # Board roster + major components: the graph view already
            # draws every [mcu] card and probe/accel with this same
            # classification, so the model gets the identical roster
            # instead of struggling to spot boards by prose inference.
            try:
                inv = derive_hardware_inventory(texts)
            except Exception:
                logger.exception("Hardware-inventory derivation failed | prompt degrades to no-inventory")
                inv = {}
            inv_line = format_hardware_inventory(inv) if inv else ""
            if inv_line:
                auto_fill_prompt += (
                    "\n\nDERIVED HARDWARE INVENTORY (parsed from the "
                    f"config by the app — ground truth): {inv_line}. "
                    "Use it to fill toolheadBoard, expanderBoards, and "
                    "probe verbatim (board NAMES are facts even when the "
                    "board model chip is unknown; a CAN uuid board is "
                    "still that named board). Say 'model unconfirmed' "
                    "only for the chip/model nuance, never drop a named "
                    "board."
                )
            system_parts.append(auto_fill_prompt)

    prepared: list[dict] = []
    for msg in messages:
        role = msg.get("role")
        content = str(msg.get("content", "")).strip()
        if role not in {"system", "user", "assistant"} or not content:
            continue
        if role == "system":
            if content != system_prompt:
                system_parts.append(content)
            continue
        prepared.append({"role": role, "content": content})

    system_text = "\n\n".join(system_parts)
    logger.debug(
        "Prepared messages | system=%d chars user_msgs=%d printer_memory_blank=%s",
        len(system_text), len(prepared), is_printer_memory_blank(memory)
    )

    # Task anchor: with a long conversation the model can mistake an earlier
    # question for the current one. A trailing system message explicitly points
    # it at the LAST user message so it stays on task. Anthropic's payload
    # builder merges every system message (see _build_provider_payload), so the
    # anchor also survives there.
    task_anchor = (
        "Your current task is the user's latest (last) message in this conversation. "
        "Earlier messages are history and context only."
    )

    # User-attached context (the docked panel's chips) rides LAST as its own
    # system message. Appending rather than splicing into the system prompt
    # keeps the entire prefix — system prompt, tool context, memory, history —
    # byte-identical to the no-reference case, so the local model's KV cache
    # stays warm. Gated with the task anchor: `minimal` / `no_system` are
    # prompt-ablation instruments and are never run with references attached.
    references_text = render_context_references(context_references)
    reference_messages = (
        [{"role": "system", "content": references_text}] if references_text else []
    )

    # W0 sticky skill armament (Invariant B — trailing injection): while the
    # conversation has earned the edit surface, the skill body re-rides every
    # request as a trailing system message at this same seam. Appending (like
    # the references) keeps the replayed prefix byte-identical for the KV
    # cache, and trailing placement means head-truncation clips chat, never
    # the rulebook. Idempotent: a trail that already carries the body (this
    # turn's or a prior turn's load_skill result) gets no second copy.
    # Invariant A pairs this with the write-tool advertisement — the caller
    # only sets the flag when the effective skill state is active, so tools
    # and body always move together.
    skill_body_messages: list[dict] = []
    if inject_edit_skill_body and not _skill_body_in_trail(
            messages, EDIT_SKILL_NAME):
        skill_body_messages = [{"role": "system", "content": _edit_skill_body()}]

    # W4-R2 sticky knowledge bodies: a loaded sticky skill's rules must
    # survive the lean replay exactly like the edit body — same trailing
    # seam, same Invariant B argument (append-only, prefix byte-identical),
    # same idempotence law (a trail already carrying the body gets no
    # second copy). Only STICKY non-gating skills re-inject: printer-memory
    # is one-shot (its block proposal lands in the history), and the edit
    # body above stays tied to atomic armament (tools + rulebook move
    # together), never to this list. Order: registry declaration order, so
    # the rendered prompt stays deterministic for the KV cache.
    knowledge_messages: list[dict] = []
    for _name in loaded_skills or []:
        _entry = _SKILL_REGISTRY.get(str(_name))
        if not _entry or not _entry["sticky"] or _entry["gates_write"]:
            continue
        if _skill_body_in_trail(messages, str(_name)):
            continue
        knowledge_messages.append(
            {"role": "system", "content": _entry["body"]()})

    # W6 conversation work-ledger: the client's action record (staged /
    # kept / undone / failed per section) rides the same trailing seam —
    # appended last-but-one so the turn-specific W3 observation stays
    # closest to the user message. Trailing placement keeps the replayed
    # prefix byte-identical for the KV cache (Invariant B rationale
    # applies verbatim). Verbatim re-delivery only: the backend never
    # interprets the record (review law). Fail-safe like the W3
    # observation — the chat must not die on the ledger — but never
    # silent (review B-L4 discipline).
    ledger_messages: list[dict] = []
    if not (minimal or no_system):
        try:
            ledger_text = _render_work_ledger(work_ledger,
                                             current_turn=work_ledger_current_turn)
        except Exception:
            logger.warning("work-ledger render failed", exc_info=True)
            ledger_text = None
        if ledger_text:
            ledger_messages = [{"role": "system", "content": ledger_text}]

    # W3 runtime-error traceback (deterministic observation): rides LAST at
    # the same trailing seam. Guarded by the same ablation gates as the
    # references/body — minimal/no_system are prompt instruments and are
    # never run with harness observations attached.
    trace_messages: list[dict] = []
    if not (minimal or no_system):
        try:
            observation = _runtime_error_observation(messages, context_files)
        except Exception:
            # fail-safe (chat must not die on an observation) but never
            # silent — review B-L4, 2026-11-14
            logger.warning("runtime-error observation failed",
                           exc_info=True)
            observation = None
        if observation:
            trace_messages = [{"role": "system", "content": observation}]

    if prepared:
        return [
            *([] if no_system else [{"role": "system", "content": system_text}]),
            *prepared,
            *([] if (minimal or no_system) else [{"role": "system", "content": task_anchor}]),
            *([] if (minimal or no_system) else reference_messages),
            *([] if (minimal or no_system) else skill_body_messages),
            *([] if (minimal or no_system) else knowledge_messages),
            *([] if (minimal or no_system) else ledger_messages),
            *([] if (minimal or no_system) else trace_messages),
        ]
    return ([] if no_system else [{"role": "system", "content": system_text}]) + prepared


# ── MCP Tool Integration ───────────────────────────────────────────


_SPECIALIZED_TOOL_SNIPPETS: dict[str, str] = {
    "detect_board": (
        "Detect the likely printer board/MCU family from a config snippet "
        "(config_text='...') — feed it the user's config to identify the "
        "mainboard for printer memory"
    ),
    "calculate_rotation_distance": (
        "Calculate rotation_distance for a stepper "
        "(method='leadscrew'|'belt'|'from_steps_per_mm')"
    ),
}


_MCP_TOOL_SNIPPETS: dict[str, str] = {
    "search_klipper_docs": (
        "Search the bundled Klipper docs (query='...', limit=N) — ranked "
        "results with snippets to find which doc covers a topic"
    ),
    "read_klipper_doc": (
        "Read a bundled Klipper doc file (filename='Klipper_GCode_Macro_AI_Summary.md' "
        "for macro/Jinja formatting: single-brace { } delimiters, {% if %}/{% endif %} "
        "block closing, comment stripping; supports offset/limit pagination)"
    ),
    "list_klipper_docs": "List all bundled Klipper documentation files (filenames + headings)",
    "list_config_reference_sections": (
        "List every Klipper config section supported by Config_Reference "
        "(e.g. [printer], [bed_mesh], [gcode_arcs]); use BEFORE adding or "
        "editing a section to get the exact name, then read it with "
        "get_config_reference_section(section_name=...)"
    ),
    "get_config_reference_section": (
        "READ the Config_Reference PROSE for a section — what the parameters "
        "do, setup examples, detailed semantics (section_name="
        "'firmware_retraction'). Use when designing a section you don't "
        "fully understand yet. For a quick check of allowed param names, "
        "defaults, enums, and bounds, call get_section_schema instead — "
        "never invent section names or params from memory either way. "
        "list_sections=true returns ONLY the section headers to pick from; "
        "sections=['a','b'] fetches several in one call"
    ),
    "read_user_config": (
        "Read a user config file (filename='printer.cfg' required): "
        "section='extruder' for one section, sections=['a','b'] for several in "
        "one call, list_sections=true for just the section headers, "
        "whole_file=true for one whole file, files=['a.cfg','b.cfg'] for "
        "several whole files. Call list_user_configs (no args) to see all "
        "available user files."
    ),
    "list_user_configs": (
        "List all user config files (from the printer host's native config path and "
        "imported user configs). Use when the user names a macro or section "
        "without saying which file it is in, then read the best candidate."
    ),
    "list_user_config_sections": (
        "List the section headers inside one user config file "
        "(filename='printer.cfg'); use to see what a file already contains "
        "before editing, then read_user_config(section=...)"
    ),
    "search_user_configs": (
        "Search the user's config files by filename or content keyword "
        "(query='level_bed'|'skr'|'bed_mesh', limit=N; several names at once: "
        "keywords=['level_bed','old_probe_home']). Every hit lists a "
        "REFERENCES checklist — each occurrence with section + line number — "
        "so rename/'every reference' jobs edit from the list and re-search "
        "until the counts hit 0. Use when the user names a macro or section "
        "without saying which file it is in."
    ),
    "search_example_configs": "Search example configs by board or printer (query='voron', limit=N)",
    "read_example_config": "Read a full example config file (filename='generic-....cfg')",
    "validate_klipper_config": (
        "VERIFY config TEXT for errors (config_text='...' required) — "
        "'check this for errors' / 'is this section correct' about ANY "
        "config text you can see, pasted by the user or written by you: "
        "required params, types, ranges. A schema or reference list CANNOT "
        "check text — never approve config text from a listing alone. For "
        "the user's saved files use validate_config_project"
    ),
    "validate_macro": (
        "Validate a gcode_macro against Klipper's Jinja rules (macro_text='...' required), "
        "including a render simulation of the default invocation; pass "
        "runtime_error='...' with a pasted Klipper error to trace its command back to the "
        "macro body line it rendered from"
    ),
    "simulate_macro": (
        "SIMULATE a macro on invocations YOU declare and read the exact "
        "commands Klipper would run (macro='NAME' from the current "
        "project — staged edits included — or macro_text='[gcode_macro "
        "...]' for a draft; scenarios=[{name?, params?, printer_state?, "
        "variables?}], e.g. scenarios=[{'name':'bare','params':{}},"
        "{'name':'with S','params':{'S':'215'}}]). variables sets a "
        "DECLARED variable_* by its stripped name (variable_fan_on -> "
        "{'fan_on': 'True'}); an undeclared name is refused with a "
        "warning and not injected. For ONE invocation skip the "
        "scenarios wrapper: params / variables / printer_state at the "
        "TOP LEVEL are that single invocation. runs=N = N consecutive calls from one "
        "starting state with the macro's own SET_GCODE_VARIABLE writes "
        "threaded between them, plus a 'commands differ: YES/NO' verdict "
        "(use runs=2 for toggle/remember questions); each call also "
        "prints expected effects (fan %, LED colours, temperature "
        "targets) as COMMANDED, not observed. A single-path call also prints an 'Execution "
        "trace': moves executed over the geometry the project declares "
        "and heater/fan/LED TARGET changes (before \u2192 after), ending "
        "in a 'Final state' line \u2014 read it before staging a macro "
        "meant to reach a NAMED spot (front centre is not the centre). "
        "Hardware names (FAN=, "
        "LED=, PIN=, SERVO=, HEATER=) are resolved against the project's "
        "own sections — FAN= only takes [fan_generic] names, so FAN=fan "
        "is a run-time refusal even when [fan] exists — and an unknown "
        "name comes back as a warning with Klipper's own near-miss hint. USE IT FOR ANY "
        "runtime-behavior question — 'will it fail when called like X?', "
        "'what does it actually send?', 'what happens on a bare call?' — "
        "before answering from source text; simulation warnings exist "
        "ONLY in its result, no other surface shows them"
    ),
    "validate_config_project": (
        "Validate the user's CURRENT config project on this host (all files, "
        "includes expanded) against the full schema — errors/warnings/infos "
        "with file+line. Call this for 'validate/check/review my config', "
        "'is my config OK?', 'what's wrong with my config' — instead of "
        "reading config files and judging by eye. No args validates "
        "everything; filenames=['printer.cfg'] for a subset. Use before "
        "advising FIRMWARE_RESTART; validate_klipper_config is for drafts "
        "you wrote"
    ),
    "list_connected_devices": (
        "List USB serial (/dev/serial/by-id paths for [mcu] serial:), UART, "
        "and CAN devices on this host, with CAN UUIDs from canbus_query "
        "(scan_can_uuids=false skips the bus scan). Use for serial:/canbus_uuid "
        "lines and 'which board is plugged in?'"
    ),
    "get_section_schema": (
        "LIST a section's allowed parameters from the schema "
        "(section='bed_mesh' or sections=['extruder','gcode_arcs']): types, "
        "defaults, required flags, enum values, numeric bounds. Use to "
        "learn WHICH params/values are legal BEFORE writing a new section; "
        "it cannot check text — for 'is this config correct?' use "
        "validate_klipper_config; get_config_reference_section only for "
        "prose explanations and examples"
    ),
    "get_klippy_status": (
        "Get Klipper's live state (ready / startup error / shutdown), the "
        "active print job, and klippy.log error context (attached "
        "automatically when not ready; include_log_excerpt=true with optional "
        "section_name/error_text forces it while ready). Call BEFORE "
        "recommending FIRMWARE_RESTART — it warns if a print would be "
        "interrupted"
    ),
    "generate_macro_template": (
        "Generate a ready-to-use macro template (macro_name='PRINT_START'|'PRINT_END'|"
        "'PAUSE'|'RESUME'|'CANCEL_PRINT'; include_bed_mesh option)"
    ),
}


# Snippets for the chat-loop write tools (advertised whenever the request is
# edit-capable; they are NOT registered MCP server tools — the
# chat proxy routes them request-scoped. Parity with the native surface
# is enforced by tests/test_ai_edit_tools.py.
_EDIT_TOOL_SNIPPETS: dict[str, str] = {
    "config_edit": (
        "Apply one mechanical edit to the user's config "
        "(file='printer.cfg', op='set_param'|'add_section'|'replace_section' "
        "|'delete_section'|'move_section'|'rename_section'|'patch_section' "
        "|'comment_section'|'uncomment_section'|'delete_file' "
        "|'add_include'"
        "|'remove_include'|'comment_include', section='bed_mesh', key='speed', value='50', "
        "new_section='gcode_macro MY_MACRO' for rename_section (renames the "
        "section header, body kept exactly — ALWAYS use this to rename a "
        "section or macro, never delete+re-add), "
        "to_file='fans.cfg' for move_section (moves the section into that "
        "file, creating it if new — the body is carried exactly and removed "
        "from the source in the same op; ALWAYS use this to move a section "
        "between files, never delete+re-add, and add its [include] with "
        "add_include afterwards when to_file is new), "
        "text='body for add/replace_section — replace_section replaces "
        "the ENTIRE body, include every param to keep', old_text='exact lines to "
        "replace', new_text='replacement lines — new_text REPLACES "
        "old_text; repeat the anchor lines inside new_text when adding; "
        "comment out a line = new_text with '# ' in front, uncomment = "
        "old_text with the '#', new_text without it', "
        "comment_section/uncomment_section disable/restore a WHOLE section "
        "(header + body) with section='<' only, "
        "target_file='x.cfg' for "
        "include ops (comment_include disables an include as '#[include x.cfg]' "
        "instead of deleting it). delete_file removes a whole file from the "
        "project (remove its [include] line first). value must be ONE LINE — "
        "multi-line values (gcode:) are dropped by some tool-call "
        "channels, write those with replace_section/patch_section. "
        "Batch multiple changes to one file in ONE call with "
        "ops=[{op=..., section=..., ...}, ...] (same fields per entry, "
        "file applies to all; applied in order, a failed entry is named "
        "by index while the rest apply) instead of multiple calls; never "
        "abbreviate or elide body content in text/new_text. A single "
        "change is a single-op call; changes are "
        "validated and staged "
        "for user review"
    ),
    "config_write": (
        "Create a NEW config file (file='new.cfg', content='full file "
        "content') — new files only; edit existing files with config_edit"
    ),
}


# ── Model-triggered edit skill ─────────────────────────────────────────
# The heavy edit protocol is lazy-loaded like an agent skill: a tiny index
# block always advertises the skill's NAME+DESCRIPTION; the write tools and
# the edit law stay hidden until the model itself calls load_skill. No
# regex auto-activation — intent guessing would re-admit the half-edit-on-
# a-question failure this gating exists to kill (plan 2026-09-10, Q4).
# Product behavior since the Phase-6 flag removal (2026-09-24): the old
# KWC_EDIT_SKILL_GATE env switch is gone (gate-ON matched gate-OFF at
# 91/94 with verified 5/5 activation); the harness keeps the per-request
# ChatRequest.editSkill override for A/B traces.
EDIT_SKILL_NAME = "config-editing"
MEMORY_SKILL_NAME = "printer-memory"
# W4-R2 (Cliff 2026-11-16): Klipper macro AUTHORING knowledge is its own
# skill — the edit law stays tool mechanics, injected only when editing is
# earned; macro rules load only when macro text is in play. Knowledge-class
# like printer-memory: never gates write tools.
MACRO_SKILL_NAME = "macro-authoring"
MEMORY_SKILL_DESCRIPTION = (
    "Fills in the user's printer memory with hardware facts (boards, "
    "kinematics, build volume, extruder type, probe). Use when the printer "
    "memory shows blank or missing fields, when the user asks to set up or "
    "correct their printer profile, or when a needed hardware fact is "
    "unknown and guessable-but-risky. Do NOT use when memory already "
    "contains the fact you need."
)
EDIT_SKILL_DESCRIPTION = (
    "Applies edits to the user's Klipper config files. Use when the request "
    "asks to change, add, remove, fix, or comment out a section, parameter, "
    "or macro, or the user approves a proposed edit. Do NOT use for "
    "questions about settings, validating pasted config text, drafting or "
    "showing config/macro text to read over or discuss without applying it, "
    "or any request that says not to change the files."
)
MACRO_SKILL_DESCRIPTION = (
    "Writes, fixes, and explains [gcode_macro] gcode: Jinja rendering rules, "
    "params defaults, the validate-and-simulate workflow, terse examples, and "
    "common pitfalls. Use when drafting or fixing macro text, or when asked "
    "what a macro will actually do or send to the printer. Do NOT use for "
    "plain config-parameter changes or questions about non-macro sections."
)

LIST_HARDWARE_SPEC = {
    "name": "list_hardware",
    "description": (
        "List every section of a hardware class in the user's CURRENT "
        "config project (working state, including approved unsaved "
        "edits), each with its full text and file+line location. Use "
        "this BEFORE editing or advising on a component CLASS so the "
        "answer covers ALL of them — text search finds only sections "
        "whose name contains the keyword and misses e.g. [dotstar] or "
        "[output_pin casing_light]. type must be EXACTLY one of: 'led' "
        "(also lights/rgb), 'fan', 'stepper' (includes [tmc2240 "
        "stepper_x]; the extruder's own stepper is NOT a member — a "
        "note in the result names it], 'driver'/'drivers' (stepper "
        "drivers like [tmc2209 ...]), 'extruder' (also 'hotend'/'nozzle'), "
        "'heater'/'heaters'/'bed', 'probe', 'accelerometer', "
        "'mcu'/'board', 'servo', 'display', 'filament_sensor', "
        "'endstop', 'macro' (gcode_macro/delayed_gcode only); or "
        "any literal section type ('bed_mesh', 'idle_timeout'). "
        "Any other type fails and the result lists the valid classes. "
        "No type returns a one-line-per-group summary of everything "
        "present."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "type": {
                "type": "string",
                "description": (
                    "Hardware class ('led', 'fan', 'stepper', ...) or "
                    "literal section type; empty for a summary"),
            },
        },
    },
}

LOAD_SKILL_SPEC = {
    "name": "load_skill",
    "description": (
        "Load the full instructions for a listed skill and unlock its "
        "tools. Call this BEFORE attempting to use a skill; load each "
        "skill at most once per conversation."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "enum": [EDIT_SKILL_NAME, MEMORY_SKILL_NAME, MACRO_SKILL_NAME],
                "description": "Skill name from <available_skills>",
            },
        },
        "required": ["name"],
    },
}

_LOAD_SKILL_SNIPPET = (
    "Load a skill's full instructions before using it — "
    "name='config-editing' (unlocks the edit tools) or 'printer-memory' "
    "(hardware fact-finding playbook)"
)

# Nudge replacement while the skill gate is CLOSED: pointing at a locked
# write tool (EDIT_NUDGE_TEXT) would be incoherent; the correction is the
# load step itself. Placeholder-only law (no real keys/values).
# EXCEPTION-FIRST shape (SKILL-* eval r1-r4, 2026-09-17): pure
# conditionals made gemma ACK the policy and stop (activation 4/5->2/5);
# imperative with a TAIL exception made the exception invisible
# (N04 FP returned). Leading the sentence with the exception ("Unless
# the user explicitly said NOT...") puts the negation first — gemma
# honors it on review-only requests — while the action clause stays the
# only executable path, so edit requests cannot dissolve into an ack.
_LOAD_SKILL_NUDGE_TEXT = (
    "Unless the user explicitly said NOT to change their files, the block "
    "you just wrote in chat text is inert and must be redone through the "
    "tools: call load_skill(name='config-editing') now, then apply the "
    "change with the edit tool (multiple changes to one file go in ONE "
    "call's ops list)."
)


def _edit_skill_body() -> str:
    """The skill body returned by load_skill: the edit law plus the
    unlocked tools' arg shapes (text-protocol models receive no JSON
    schema, so the tool snippets travel WITH the body)."""
    tool_lines = "\n".join(
        f"- {name}: {snippet}" for name, snippet in _EDIT_TOOL_SNIPPETS.items())
    return (
        f"Skill '{EDIT_SKILL_NAME}' loaded — the tools below are now "
        "available for this conversation.\n\n"
        f"{EDIT_PROTOCOL_PROMPT}\n\n"
        "Unlocked tools:\n" + tool_lines
        # W6.5 enrichment (approved 2026-11-13, Claude Code post-compaction
        # re-read bias): the work-ledger tells the model WHAT it touched;
        # this rule is what to do about it — re-ground, never edit from
        # remembered text (the human edits by hand between turns too).
        + "\n\nCross-turn grounding: a Conversation work-ledger may appear "
        "later in this prompt naming the sections you read or edited in "
        "earlier turns ('read' = touched). Their content may have changed "
        "since. Re-read a section with read_user_config immediately before "
        "editing it in a later turn — never edit from remembered text."
    )


_SKILL_INDEX_BLOCK = (
    "<available_skills>\n"
    f"- {EDIT_SKILL_NAME}: {EDIT_SKILL_DESCRIPTION}\n"
    f"- {MEMORY_SKILL_NAME}: {MEMORY_SKILL_DESCRIPTION}\n"
    f"- {MACRO_SKILL_NAME}: {MACRO_SKILL_DESCRIPTION}\n"
    "</available_skills>\n"
    "If the user's request is about editing their config, call load_skill "
    "with the skill name FIRST — the edit tools are not available until "
    "you do. If the request is about WRITING, fixing, or explaining a "
    "macro's gcode (Jinja, params, what it will send or do), also call "
    "load_skill(name='macro-authoring') — the macro rules, examples, and "
    "pitfalls live there; load config-editing on top only when the macro "
    "must actually be saved. If the printer memory has blank fields you "
    "need (or you are about to guess a hardware fact), "
    "load_skill(name='printer-memory') and follow its playbook instead of "
    "guessing. Questions about Klipper that need none of these never need "
    "a skill."
)


def _memory_skill_body() -> str:
    """The skill body returned by load_skill(name='printer-memory'):
    the hardware fact-finding playbook. No tools unlock — every tool it
    uses (read_user_config, search_example_configs, ...) is already
    advertised; what the body adds is WHERE to look for each field."""
    return (
        f"Skill '{MEMORY_SKILL_NAME}' loaded.\n\n"
        "Goal: fill the printer memory fields with FACTS, never guesses.\n"
        "For each field: (1) look for evidence in the user's config and "
        "bundled example configs; (2) ask the user only what you cannot "
        "determine; (3) never invent a value.\n\n"
        "Where to look:\n"
        "- mainboard / toolheadBoard / expanderBoards: check the "
        "DERIVED HARDWARE INVENTORY in this conversation FIRST \u2014 "
        "the app parses every [mcu] section (names, roles, chips, "
        "hosting) and it is ground truth; copy board names from it "
        "verbatim. Without it: the [mcu] sections name MCUs; board "
        "models come from canbus_query-style notes, "
        "# comments, or search_example_configs with the MCU chip + "
        "pin-style clues, confirmed via read_example_config. If the exact "
        "model stays unconfirmed, STILL record the certain part as a "
        "factual description (e.g. 'STM32F446 board — model unconfirmed') "
        "— stating what IS known is not a guess; leaving a known chip "
        "out is worse than a hedged entry.\n"
        "- printerName: user messages or config comments first (e.g. "
        "'# Voron Trident 250'); never guess from kinematics alone.\n"
        "- kinematics: the [printer] section's kinematics: key — read it, "
        "do not infer.\n"
        "- probe: the [probe] / [bltouch] / [load_cell] sections and "
        "probe pin comments (Voron Tap = [probe] with no bltouch).\n"
        "- buildVolume: MECHANICALLY DERIVABLE — do not ask for it if "
        "the config is available. Cartesian/CoreXY: width/depth/height "
        "from [stepper_x]/[stepper_y]/[stepper_z] position_max minus "
        "position_min (position_min defaults to 0), e.g. 250x250x210. "
        "Delta/rotary_delta: 'round Ø' twice the [printer] "
        "print_radius (or delta_radius). The app's Macro Designer "
        "derives it this same way programmatically. If the auto-fill "
        "prompt already gives you derived machine facts, USE them "
        "verbatim.\n"
        "- extruderType: 'direct' or 'bowden' ONLY. Evidence: bowden "
        "tubes show up as long bowden_length / pressure_advance "
        "discussion, Titan/BMG paired with a remote motor, or the user "
        "saying so; typical modern Voron toolheads (AbbottCluster, "
        "Afterwise, Orbiter-on-carriage) are direct drive. If the config "
        "does not settle it, ASK — one short question, both options "
        "named.\n\n"
        "Return the proposal in a fenced `printer-memory` code block "
        "with ONLY these 9 fields (omit the ones that stay unknown):\n"
        "mainboard, toolheadBoard, expanderBoards, printerName, "
        "kinematics, probe, buildVolume, extruderType, additionalNotes.\n"
        "   ```printer-memory\n"
        "   {\"kinematics\": \"CoreXY\", \"buildVolume\": \"250x250x210\", "
        "\"extruderType\": \"direct\"}\n"
        "   ```\n"
        "The user confirms before anything is saved. Leave a field out "
        "rather than guessing — an omitted field is honest; a wrong one "
        "poisons every later answer.\n\n"
        "ALWAYS return the block in the SAME reply, even when you are "
        "also asking questions: emit every fact you have determined NOW "
        "(a partial profile saves fine), then ask about the rest. Never "
        "wait for answers before returning what you already know — your "
        "facts are lost if the conversation moves on."
    )


# Shipped example bodies — constants so tests/test_macro_skill.py re-derives
# them through the real render engine every CI run. Blind-review law
# (2026-11-17): examples are what models copy; an example that does not
# render is a defect, not typography.
MACRO_EX_BLINK = (
    "[gcode_macro BLINK]\n"
    "variable_state: 0\n"
    "gcode:\n"
    "    {% set dur = params.DUR|default(0.5)|float %}\n"
    "    {% set on = (state + 1) % 2 %}\n"
    "    SET_GCODE_VARIABLE MACRO=BLINK VARIABLE=state VALUE={on}\n"
    "    SET_PIN PIN=casing_light VALUE={on}\n"
    "    G4 P{(dur * 1000)|int}\n"
)

MACRO_EX_PARK = (
    "[gcode_macro PARK]\n"
    "gcode:\n"
    "    {% set z = params.Z|default(0)|float %}\n"
    "    SAVE_GCODE_STATE NAME=park_state\n"
    "    G90\n"
    "    G1 Z{ [z, printer.toolhead.axis_maximum.z - 1]|min } F600\n"
    "    RESTORE_GCODE_STATE NAME=park_state\n"
)


def _macro_skill_body() -> str:
    """The skill body returned by load_skill(name='macro-authoring'):
    Klipper macro authoring law. No tools unlock — validate_macro and
    simulate_macro are already advertised; what the body adds is the
    WORKFLOW (simulate before you claim) and the rules the W2 engine
    actually enforces (no unenforced prose drift — W4 law).

    v2 (2026-11-17, double-blind review — both reviewers converged, each
    claim re-verified against the engine/klipper source): filter order is
    default-BEFORE-coerce (numeric filters abort on Undefined; Klipper's
    own Command_Templates.md:127), BLINK gained the SET_GCODE_VARIABLE
    write-back and both examples are engine-pinned, the M104/M140 wait
    claim was inverted (heaters.py 'wait and temp': M104 never waits,
    M109/M190 skip the wait at target 0), the shadow phrasing became the
    registration-conflict load error (gcode.py:144), doc pointers use
    filename= per the real schema, and the simulator's non-recursion is
    disclosed. The verdict-first ANSWER law was REMOVED per Cliff
    (2026-11-17): four prose levers demonstrably failed on MACRO-17; the
    mechanical trace guard (test_sim_verdict_guard.py) carries it.

    Grounding sources: the validator/sim finding codes, reference/klipper
    klippy sources, and reference/reference_docs/klipper_docs/.
    """
    return (
        f"Skill '{MACRO_SKILL_NAME}' loaded.\n\n"
        "You are drafting or fixing [gcode_macro] gcode. This skill is "
        "macro KNOWLEDGE; to save anything to the user's files, "
        "load_skill(name='config-editing') first — staging belongs to "
        "that skill.\n\n"
        "Workflow:\n"
        "1. Read before reasoning: read_user_config requires filename= — "
        "when the user names only a macro, resolve the file first with "
        "list_user_configs or search_user_configs. Read the macro AND "
        "every macro it invokes (a bare command-name line in the body) — "
        "never reason about text you have not read.\n"
        "2. validate_macro takes macro_text= — the FULL '[gcode_macro "
        "...]' section text, not a name — after every draft or patch. "
        "When the user pastes a Klipper error, pass runtime_error='...' "
        "(the error line verbatim): the tool maps the failing command "
        "back to the body line.\n"
        "3. simulate_macro BEFORE answering or staging: macro='NAME' "
        "resolves a macro already in the config; macro_text= renders a "
        "draft. Cover the BARE call (no params) AND every parameter "
        "branch — scenarios=[{params?, printer_state?, variables?}] is "
        "capped at 8 per call, so split across calls and say which "
        "branches were not simulated. Simulator scope: the render covers "
        "THIS macro's template only — macros it invokes are NOT "
        "expanded; read and simulate each callee separately and say "
        "which macro each rendered line came from. Answer runtime "
        "questions FROM the rendered lines and quote them; never narrate "
        "an expansion the simulator did not show.\n"
        "4. Staging: to stage a fix, load_skill(name='config-editing') "
        "first — the staging tools do not exist until it is loaded; "
        "every staged change passes the user's review before anything "
        "lands. An explicit refusal binds: review-only, show-only, or "
        "do-not-change-my-files means return the text in a ```cfg block "
        "and stage nothing.\n\n"
        "Lexical rules (before any Jinja semantics):\n"
        "- Klipper templates use SINGLE braces: SET_PIN VALUE={on}. "
        "{{ expr }} is a syntax error, not a silent no-op.\n"
        "- '#' comments are stripped BEFORE templating: Jinja never sees "
        "commented text, and a '#'-commented {% if %} is inert.\n\n"
        "Rendering law (how Klipper evaluates the body):\n"
        "- The whole macro renders BEFORE any of its commands run. State "
        "changed by an early command is INVISIBLE to later Jinja blocks "
        "in the same macro.\n"
        "- params keys arrive UPPERCASE and as STRINGS; rawparams is the "
        "raw argument tail.\n"
        "- Default BEFORE you coerce: params.SPEED|default(60)|float, "
        "params.N|default(0)|int, params.S|default('X'). Filters run "
        "left-to-right, so |float on an ABSENT param aborts the whole "
        "render before |default can fire.\n"
        "- A param sent EMPTY (MACRO S= with nothing after it) is "
        "DEFINED, so plain |default passes the '' through and the "
        "command fails to parse at runtime ('Unable to parse') — use the "
        "boolean form: params.X|default('10', true). SET_LED color args "
        "RED/GREEN/BLUE are floats 0..1.\n"
        "- A required param is legitimate design: params.S|float with no "
        "default is the macro SAYING S is mandatory, and the bare call "
        "failing is the correct answer — report it as designed; add a "
        "default only when the user wants one.\n"
        "- Prefer simple values (SAVE_VARIABLE, params defaults) over "
        "deep printer.a.b.c lookups — a wrong dotted path resolves to "
        "nothing at runtime. printer.* paths must come from "
        "Status_Reference.md, and a scenario must DECLARE the path "
        "(printer_state={'toolhead.axis_maximum.z': 250}) for the render "
        "to follow it.\n"
        "- {% set %} lives ONE render only. variable_x is exposed to the "
        "template as the bare name x; only SET_GCODE_VARIABLE "
        "MACRO=... VARIABLE=x VALUE=... persists across calls, and the "
        "write lands on the NEXT call (this body already rendered) — "
        "prove toggles and memory with runs=2.\n"
        "- A {% set %} inside a {% for %} block does NOT survive the "
        "loop (if/else blocks are fine); compute accumulated values "
        "outside the loop.\n\n"
        "G-code discipline (what the validators enforce):\n"
        "- M109/M190 are the built-in Set-and-Wait commands: they block "
        "inside macros until the target is reached — never emulate them "
        "with M104 + TEMPERATURE_WAIT for the extruder/bed. Exception: "
        "BOTH skip the wait when the target is 0, so M109 S0 returns "
        "immediately and cools nothing — to wait for a cooldown use "
        "TEMPERATURE_WAIT SENSOR=extruder MAXIMUM=60, which is also the "
        "only wait for heaters with no M109/M190 (chamber, "
        "heater_generic). M104/M140 are Set-only and NEVER wait. "
        "simulate_macro's 'Expected effect' shows Set vs Set and Wait "
        "per command.\n"
        "- Naming a macro after a stock command ([gcode_macro M109]) "
        "without rename_existing is a config LOAD failure — 'gcode "
        "command M109 already registered' — not a silent override. To "
        "wrap the original: [gcode_macro M109] with rename_existing: "
        "M99109 (uncomment a '#rename_existing:' line if the body "
        "carries one) and call the renamed command from the body.\n"
        "- 'params_<name>:' lines inside [gcode_macro] are a config LOAD "
        "error in real Klipper. KWC's simulator honors them as sim-only "
        "defaults, so a draft can LOOK fine resting on one — never rely "
        "on it; defaults live in |default() in the body.\n"
        "- Movement macros: SAVE_GCODE_STATE, explicit G90/G91, an "
        "explicit F on the first G0/G1, then RESTORE_GCODE_STATE. Moves "
        "need homed axes: a standalone movement macro either homes or "
        "checks printer.toolhead.homed_axes and states its "
        "precondition. After drafting a move to a NAMED bed spot, "
        "single-path simulate and read the trace's 'Final state' line "
        "BEFORE staging: its annotation (centre / \u2248front edge / % "
        "of span) must match the spot the user named — a clean render "
        "proves syntax, the trace is what proves placement.\n"
        "- G2/G3 arcs need a [gcode_arcs] section added in the SAME "
        "change — validate macro + section together with "
        "validate_klipper_config (draft text) or validate_config_project "
        "(saved files); validate_macro only sees the macro text.\n"
        "- delayed_gcode is its OWN section ([delayed_gcode NAME] with "
        "initial_duration), not a [gcode_macro] feature: it receives no "
        "params (state comes from variables) and re-arms via "
        "UPDATE_DELAYED_GCODE ID=NAME DURATION=...\n"
        "- Commands the registry does not know come back UNSTAGED from "
        "the staging step with a suggestion: fix the command or name the "
        "plugin that provides it.\n\n"
        "Examples — both verified through the render engine; shapes that "
        "render on every call form:\n"
        "```\n"
        + MACRO_EX_BLINK + "\n"
        + MACRO_EX_PARK +
        "```\n"
        "BLINK toggles ONLY because of the SET_GCODE_VARIABLE line — "
        "drop it and state never changes; verify with runs=2 (VALUE=1, "
        "then VALUE=0). PARK reads axis_maximum as the sanctioned "
        "exception to prefer-simple: declare "
        "printer_state={'toolhead.axis_maximum.z': 250} in the scenario "
        "to verify it, and remember PARK assumes homed axes.\n\n"
        "Deep reference (already-available tools — name the doc, do not "
        "guess its content):\n"
        "- read_klipper_doc(filename='Command_Templates.md') — full "
        "Jinja syntax, params/rawparams, action_respond_info/"
        "action_raise_error. offset/limit are CHARACTERS — paginate a "
        "long doc.\n"
        "- get_config_reference_section(section_name='gcode_macro') — "
        "the [gcode_macro] config prose (delayed_gcode has its own "
        "section name); list_config_reference_sections lists every "
        "section name.\n"
        "- read_klipper_doc(filename='Status_Reference.md') — the ONLY "
        "source of valid printer.* status paths.\n"
        "- search_klipper_docs(query='...') to find which doc covers a "
        "topic; list_klipper_docs to see what docs exist."
    )

# W4-R2 registry: the ONE source for skill facts. gates_write — only
# config-editing earns the write surface (a knowledge load must never arm
# edits, the r4b trap). sticky — a sticky body re-rides every follow-up
# request (lean replay strips tool results); printer-memory is NOT sticky:
# its playbook is one-shot and the block proposal it produces already
# lands in the history.
_SKILL_REGISTRY: dict[str, dict] = {
    EDIT_SKILL_NAME: {
        "description": EDIT_SKILL_DESCRIPTION,
        "body": _edit_skill_body,
        "gates_write": True,
        "sticky": True,
    },
    MEMORY_SKILL_NAME: {
        "description": MEMORY_SKILL_DESCRIPTION,
        "body": _memory_skill_body,
        "gates_write": False,
        "sticky": False,
    },
    MACRO_SKILL_NAME: {
        "description": MACRO_SKILL_DESCRIPTION,
        "body": _macro_skill_body,
        "gates_write": False,
        "sticky": True,
    },
}


def _unknown_skill_text(requested: str) -> str:
    return (f"Unknown skill '{requested}'. Available skills: "
            + ", ".join(f"'{name}'" for name in _SKILL_REGISTRY) + ".")


def _skill_load_in_trail(messages: list[dict], skill_name: str) -> bool:
    """True once load_skill(SKILL) actually ran in this conversation.
    Mechanical evidence only (tool-result markers / echoed native
    tool_calls) — never keyword heuristics. An empty skill name is the
    legacy config-editing convention and counts ONLY for config-editing.
    """
    for msg in messages:
        if str(msg.get("role", "")) not in ("user", "assistant"):
            continue
        content = str(msg.get("content", ""))
        # Name-anchored (r4b trap): a printer-memory load in the history
        # must NOT count as the edit skill being active. The tool-result
        # marker carries `name=<skill>` verbatim.
        if re.search(r"\[Tool result: load_skill\(name=?['\"]?"
                     + re.escape(skill_name), content):
            return True
        for call in msg.get("tool_calls") or []:
            fn = call.get("function") if isinstance(call, dict) else None
            if not isinstance(fn, dict) or fn.get("name") != "load_skill":
                continue
            args = fn.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (json.JSONDecodeError, ValueError):
                    args = {}
            name = str((args or {}).get("name", ""))
            if name == skill_name or (not name
                                      and skill_name == EDIT_SKILL_NAME):
                return True
    return False


def _load_skill_active(messages: list[dict]) -> bool:
    """True once load_skill has actually run for the EDIT skill in this
    conversation (delegates to the generalized per-name scan).

    Follow-up turns from the frontend now carry the client-derived
    loadedSkills flag instead (W0 sticky activation: the lean replay
    strips native tool_calls, so this scan sees nothing on replayed
    trails). This scan STAYS — the text protocol writes its tool-result
    marker into content, and harness arms still rely on it."""
    return _skill_load_in_trail(messages, EDIT_SKILL_NAME)


# A skill body present in text: its own first line (native echoes and
# re-injected bodies) or the text-protocol tool-result marker (which wraps
# the body). Compiled once per skill name.
_SKILL_TRAIL_RES: dict[str, re.Pattern] = {}


def _skill_body_in_trail(messages: list[dict], skill_name: str) -> bool:
    """True when the trail already carries SKILL's body. Keeps the W0/W4-R2
    re-injection idempotent: a sticky body rides the prompt exactly once per
    conversation, from whichever source arrived first."""
    pattern = _SKILL_TRAIL_RES.get(skill_name)
    if pattern is None:
        pattern = re.compile(
            r"Skill '" + re.escape(skill_name) + r"' loaded"
            r"|\[Tool result: load_skill\(name=?['\"]?" + re.escape(skill_name)
        )
        _SKILL_TRAIL_RES[skill_name] = pattern
    return any(pattern.search(str(m.get("content", ""))) for m in messages)


# W6 work-ledger: the client's action-record window. Mirrors the client
# law (utils/chatWorkLedger WORK_LEDGER_MAX_TURNS); rows outside it are
# dropped server-side as a defensive re-cap, never a guess.
WORK_LEDGER_MAX_TURNS = 10
# Defensive flood cap: ~10 turns x a bounded number of sections. The
# client caps turns and row noise; this only stops a hand-built request
# turning the ledger into a payload channel.
WORK_LEDGER_MAX_ROWS = 60

_LEDGER_VERDICTS = ("pending", "kept", "undone", "failed", "touched",
                    # PR #43 review F6/F17: staging whose decision record
                    # did not survive a reload. It must reach the model as
                    # an honest unknown row — DROPPING the row would let
                    # the header teach 'absence = never staged', which is
                    # exactly the false claim F6 exists to stop.
                    "unknown")

# PR #43 review F17: per-field byte bounds (the client bounds detail at
# 120; the backend re-caps defensively — this channel carries names, and
# a hand-built request must not turn a name into a payload channel) and
# whitespace collapsing for ALL THREE text fields: file was only
# strip()'d, so an embedded newline injected extra lines into the ledger
# message verbatim.
_LEDGER_FIELD_MAX = 200
_LEDGER_DETAIL_MAX = 120


def _ledger_field(raw: object, cap: int) -> str:
    """One-line, length-bounded rendering of a ledger text field."""
    text = " ".join(str(raw or "").split())
    if len(text) > cap:
        text = text[:cap - 1] + "…"
    return text


def _render_work_ledger(rows: list | None,
                       current_turn: int | None = None) -> str | None:
    """Render client-derived work-ledger rows as ONE system message body.

    Verbatim re-delivery: names + verdicts only, no interpretation — the
    backend never concludes anything from the record (review law; the
    human's keep/undo decisions stay client-side). Deterministic output
    (oldest turn first, newest last; sections ordered by file then name)
    so the rendered text stays stable for the KV cache. Malformed rows
    drop silently — an absent line claims nothing, a garbage line would.
    """
    # Pass 1: judge each row's turn coordinates ONCE and pair them with
    # the row — a separate filter pass over `rows` would have to
    # re-implement this exact predicate and drift from it (a bool
    # `turnOffset` is `is not None` yet not an int: precisely such a
    # drift). Pass 2 then reads the same pairs.
    ct = current_turn if (isinstance(current_turn, int)
                          and not isinstance(current_turn, bool)
                          and current_turn > 0) else None
    paired: list[tuple[dict, int | None, int | None]] = []
    has_any_ordinal = False
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        raw_offset = row.get("turnOffset")
        offset_opt = (raw_offset if isinstance(raw_offset, int)
                      and not isinstance(raw_offset, bool) else None)
        raw_ordinal = row.get("turnOrdinal")
        # C1: absolute creation turn (the client is ground truth for its
        # own event). A payload with NO ordinals anywhere is a legacy
        # client and keeps the old relative rendering untouched; offset-
        # only rows inside an absolute payload anchor on currentTurn.
        ordinal_opt = (raw_ordinal if isinstance(raw_ordinal, int)
                       and not isinstance(raw_ordinal, bool)
                       and raw_ordinal > 0 else None)
        if offset_opt is None and ordinal_opt is None:
            continue
        if ordinal_opt is not None:
            has_any_ordinal = True
        paired.append((row, offset_opt, ordinal_opt))
    if not paired:
        return None

    valid: list[tuple[int, int | None, str, str, str, str]] = []
    for row, offset_opt, ordinal_opt in paired:
        # Window law offset: for absolute rows it is anchored on the
        # request currentTurn, else on the row's own offset (a coherent
        # client keeps offset == current - ordinal). Rows with neither an
        # offset nor an anchor are unjudgeable against the window —
        # render them (absence would claim more than presence does).
        effective: int | None
        if ordinal_opt is not None:
            if offset_opt is not None:
                anchor = ct if ct is not None else ordinal_opt + offset_opt - 1
                effective = anchor - ordinal_opt
            else:
                effective = ct - ordinal_opt if ct is not None else None
        else:
            # Pre-C1 law, kept: a row whose turnOffset is missing OR not
            # an int has no place in the ledger — in ANY payload mode
            # (a garbage offset claims nothing even beside good rows).
            if offset_opt is None:
                continue
            # Offset-only row inside an absolute payload anchors on
            # currentTurn for the window check.
            effective = offset_opt if ct is None else ct - offset_opt
        if effective is not None and not (1 <= effective <= WORK_LEDGER_MAX_TURNS):
            continue
        window_offset = effective if effective is not None else 1
        # Absolute header iff the payload is an absolute one (some row
        # carries a creation turn); legacy relative header otherwise.
        rendered_ordinal: int | None = None
        if has_any_ordinal:
            rendered_ordinal = ordinal_opt if ordinal_opt is not None else (
                ct - offset_opt if (ct is not None and offset_opt is not None) else None)
        file = _ledger_field(row.get("file"), _LEDGER_FIELD_MAX)
        section = _ledger_field(row.get("section"), _LEDGER_FIELD_MAX)
        verdict = str(row.get("verdict") or "").strip()
        if not file or verdict not in _LEDGER_VERDICTS:
            continue
        detail = _ledger_field(row.get("detail"), _LEDGER_DETAIL_MAX)
        valid.append((window_offset, rendered_ordinal, file, section, verdict, detail))
    if not valid:
        return None
    # Oldest turn first, newest last; deterministic within a turn.
    # C1: the group key is the ABSOLUTE turn (descending = oldest
    # first), not the per-send window offset — otherwise adding a new
    # turn shifts every older group header down one line and rewrites
    # the block's middle. Absolute groups are frozen once written: the
    # ledger block becomes append-only, which is what keeps the merged
    # prefix byte-stable across turns. Legacy offset-only rows anchor on
    # currentTurn (ct - offset, their absolute turn anyway); without a
    # currentTurn every key is None and the stable sort keeps the
    # client's oldest-first row order (the documented row law).
    def _absolute_of(r):
        return r[1] if r[1] is not None else (
            ct - r[0] if ct is not None else None)
    if any(_absolute_of(r) is not None for r in valid):
        # ASCENDING absolute = oldest first. (The pre-C1 key was
        # OFFSET-descending, which was the same order — offsets run
        # backwards to turns. Negating absolute orders the ledger
        # NEWEST-first, rewriting the block's middle every turn.)
        valid.sort(key=lambda r: (_absolute_of(r), r[2], r[3]))
    else:
        # Pure legacy payload without a currentTurn anchor: keep the
        # pre-C1 window sort (offset descending = oldest first).
        valid.sort(key=lambda r: (-r[0], r[2], r[3]))
    # PR #43 B-04: the flood cap must drop the OLDEST rows — turnOffset 1
    # is the NEWEST turn (utils/chatWorkLedger), so with the list sorted
    # oldest-first the tail is what the model needs. The old
    # 'del valid[MAX:]' kept the oldest 60 and threw away the recent
    # staging the ledger is FOR, then told the model the missing recent
    # sections 'were never staged'. Keep the newest MAX rows instead.
    elided = 0
    if len(valid) > WORK_LEDGER_MAX_ROWS:
        elided = len(valid) - WORK_LEDGER_MAX_ROWS
        del valid[:elided]

    def _outcome(verdict: str, detail: str) -> str:
        if verdict == "pending":
            return "staged (awaiting review)"
        if verdict == "kept":
            return "kept"
        if verdict == "undone":
            return "undone by user"
        if verdict == "touched":
            return "read (content may have changed since)"
        if verdict == "unknown":
            return "staged (decision not recorded)"
        return f"FAILED: {detail}" if detail else "FAILED"

    header = (
        "Conversation work-ledger (recorded by the client; the outcomes "
        "of YOUR staged edits and the user's review decisions; oldest "
        "turn first, newest last). A section that no longer appears has "
        "left the recorded window — its absence claims nothing and is "
        "NOT evidence of past staging; config state itself is "
        "always re-derivable via the read tools. Outcomes: 'kept' = user "
        "accepted at review; 'undone by user' = applied successfully, "
        "then removed by the user at review — the edit itself did NOT "
        "fail; 'FAILED' = never applied (the failure code follows); "
        "'staged' = awaiting review; 'staged (decision not recorded)' = "
        "the review outcome is NOT in the record — never infer kept, "
        "undone, or still-pending from it; 'read' = section re-read in a "
        "later turn."
    )
    lines: list[str] = []
    current_key = None
    for offset, row_ordinal, file, section, verdict, detail in valid:
        # Group on the SAME absolute key the sort used, so two rows that
        # share a turn never double-header even if a client's offsets
        # drifted within the payload.
        group_key = row_ordinal if row_ordinal is not None else (
            ct - offset if ct is not None else offset)
        if group_key != current_key:
            # C1: with absolute turn numbers the header bytes are stable
            # across every later send of the same conversation — the
            # point of the whole exercise. Legacy offset-only rows keep
            # the relative labels (baseline behavior).
            if row_ordinal is not None:
                when = f"turn {row_ordinal}"
            elif has_any_ordinal and ct is not None:
                # Offset-only row inside an absolute payload: anchors on
                # currentTurn — same absolute string, group_key holds it.
                when = f"turn {group_key}"
            else:
                when = "previous turn" if offset == 1 else f"{offset} turns ago"
            lines.append(f"- {when}:")
            current_key = group_key
        # Created files are file-level write rows; touched rows mark
        # what earlier turns grounded on.
        if verdict == "touched":
            label = f"[{section}] in {file} (read)" if section else f"{file} (read)"
        else:
            label = f"[{section}]" if section else f"{file} (new file)"
            suffix = f" in {file}" if section else ""
            label += suffix
        lines.append(f"    {label} -> {_outcome(verdict, detail)}")
    if elided:
        # F17 header truthfulness: when the flood cap dropped rows, say
        # so — never let the model read the trimmed window as complete.
        lines.append(f"- ({elided} older entries elided: window full; "
                     "their absence claims nothing)")
    return header + "\n" + "\n".join(lines)


def _build_mcp_tool_context(edit_capable: bool = False, *,
                            skill_active: bool = False,
                            native_mode: bool = False) -> str:
    """Build the 'Available Tools' section for the system prompt.

    Every registered tool is advertised so text-protocol and native providers
    see the SAME tool surface (parity). The everyday tools get a one-line
    snippet each; niche helpers (board detection, rotation_distance math) are
    grouped under a "Specialized tools" heading so they stay visible without
    distracting from the tools that matter for the current task.

    Param-coverage note: every inputSchema param of an advertised tool must
    appear in its snippet (enforced by test_api_routes
    test_tool_context_snippets_cover_schema_params) so text-protocol models
    can discover the same affordances as native function calling.
    """

    parts = [
        "# Available Tools",
        "",
        "Use these tools proactively. They are how you access the user's "
        "configs, the bundled Klipper docs, and validation. Before asking "
        "the user for information, prefer a tool that can fetch or verify "
        "it — read_user_config for config files, search_klipper_docs or "
        "get_config_reference_section for docs, validate_klipper_config / "
        "validate_macro for drafts. Do not guess when a tool can answer. "
        "read_user_config / list_user_config_sections show only what ALREADY "
        "exists in the user's files; list_config_reference_sections / "
        "get_config_reference_section / get_section_schema / "
        "search_klipper_docs show what Klipper SUPPORTS. When the user asks "
        "to ADD or SETUP a section or parameter, look it up first — a valid "
        "Klipper section may not be in the user's config yet. To verify "
        "which PARAMETERS and values a section accepts, call "
        "get_section_schema (fast, exact types/defaults/enums/bounds); use "
        "get_config_reference_section only when you need the prose "
        "explanation or examples of what the section does.",
        "",
        # Format law is protocol-specific. Advertising the ```tool block to
        # a native server is what teaches small models to narrate the
        # protocol back at the user ("I see you've shared the tool-call
        # instructions..."), so native turns get the short machine-channel
        # statement instead. The ```tool block stays for tool_protocol=text.
        *([
            "Use your tools by calling them directly — the tool results come",
            "back to you automatically; never write tool calls as text.",
        ] if native_mode else [
            "Text format (used by providers without native function calling): put a JSON ",
            "code block tagged `tool` in your reply:",
            "",
            "```tool",
            """{"name": "tool_name", "arguments": {"key": "value"}}""",
            "```",
            "",
            "The tool runs and the result is returned as a follow-up message — use it to answer.",
        ]),
        "",
        "Tools:",
    ]
    for name, snippet in _MCP_TOOL_SNIPPETS.items():
        parts.append(f"- {name}: {snippet}")
    parts.append("")
    parts.append("Specialized tools (use only for specific problems):")
    for name, snippet in _SPECIALIZED_TOOL_SNIPPETS.items():
        parts.append(f"- {name}: {snippet}")
    parts.append("")
    parts.append(
        "- list_hardware: List EVERY section of a hardware class "
        "(type='led'|'fan'|'stepper'|'driver'|'extruder'|"
        "'heater'|'probe'|'accelerometer'|'mcu'|'servo'|"
        "'display'|'filament_sensor'|'endstop'|'macro' — "
        "exactly one of these, or a literal section "
        "type like 'bed_mesh'; any other type fails and lists the "
        "valid ones) from the CURRENT working state, "
        "each with full text + file+line — use before class-wide edits "
        "or advice so nothing is missed (text search misses [dotstar] "
        "or [output_pin led_strips]); no type = summary of everything "
        "present"
    )
    if edit_capable:
        if not skill_active:
            # Model-triggered skill (product behavior): advertise the
            # skill INDEX; write tools unlock only after the model calls
            # load_skill itself.
            parts.append("")
            parts.append(_SKILL_INDEX_BLOCK)
        else:
            parts.append("")
            parts.append("Config edit tools (changes are staged for user review, never saved directly):")
            for name, snippet in _EDIT_TOOL_SNIPPETS.items():
                parts.append(f"- {name}: {snippet}")
        parts.append("")
        parts.append(f"- load_skill: {_LOAD_SKILL_SNIPPET}")
    parts.append("")
    parts.append(
        "Klipper G-code commands and macro names (e.g. G28, M104, BED_MESH_CALIBRATE, "
        "SET_FAN_SPEED, PRINT_START) are NOT tools — never wrap them in tool blocks."
    )

    return "\n".join(parts)


# ── Edit-request heuristic ──────────────────────────────────────────────
# Drives the edit-prose nudge gate in chat_proxy. Edit requests must
# never be doc/config-injection targets (models regenerate macros lossily
# under extra load — verified 2026-08 on gemma-4-12b/qwen3.5-9b).

_EDIT_VERB_RE = re.compile(
    r"\b(?:change|update|modify|edit|add|remove|delete|fix|create|set|rename|"
    r"enable|disable|tweak|adjust|comment\s*out|calibrat\w*|move|"
    r"raise|lower|increase|decrease)\b",
    re.IGNORECASE,
)
_EDIT_TARGET_RE = re.compile(
    r"\[[^\]]+\]|\bmacros?\b|\bsection\b|\.cfg\b|"
    r"\b(?:max_accel|max_velocity|serial|pin|probe|bed_mesh|kinematics|"
    r"steps_per_mm|rotation_distance|z_offset|nozzle|extruder|heater|fan)\b",
    re.IGNORECASE,
)
# Review fix 2026-09-26: the widened verb set (move/raise/lower/
# increase/decrease) classified pure ADVICE questions as edit requests
# ("Should I increase max_accel to 5000?" -> True), arming the edit-prose
# nudge and ack guard on Q&A turns. The veto targets the ASK-SOMEONE-ELSE
# shape only: info interrogatives (what/how/why...), self-directed asks
# ("should I", "can I", "am I"), and safety/"good idea" asks. Requests
# addressed to the assistant ("Can you change my max_accel to 3000")
# ARE edit commands — the product's own repro flows use that phrasing —
# so "can/could/would you" must NOT be vetoed.
_QUESTION_RE = re.compile(
    r"^\s*(?:who|what|when|where|why|which)\b|"
    r"^\s*how\s+(?:do|does|did|can|could|would|should|is|are|to)\b|"
    r"\b(?:should|could|would|can|may|might|must)\s+(?:i|we)\b|"
    r"\bam\s+i\b|"
    r"\bis\s+it\s+(?:safe|ok|okay|fine|alright|a\s+good\s+idea)\b|"
    r"\bdoes?\s+it\s+matter\b",
    re.IGNORECASE,
)


def _is_edit_request(messages: list[dict]) -> bool:
    """Heuristic: does the latest user message ask for config/macro changes?

    An edit verb AND a config-ish target, and NOT an interrogative-shaped
    advice question (see _QUESTION_RE). Only the LATEST user message
    decides — a follow-up question after an edit must not be gated. Drives
    the edit-prose nudge gate (the doc/config injection fallbacks this
    once gated were deleted in the Phase-5 gate sweep, 2026-09).
    """
    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue
        content = str(msg.get("content", "")).strip()
        if not content:
            continue
        if _QUESTION_RE.search(content):
            return False
        return bool(_EDIT_VERB_RE.search(content) and _EDIT_TARGET_RE.search(content))
    return False


def _no_system_prompt_enabled() -> bool:
    """Experiment gate (env KWC_NO_SYSTEM=1): send NO system content at all.

    No SYSTEM_PROMPT, no tool list, no printer memory, no task anchor — the
    request is just the conversation, exactly like a bare chat UI. Measures
    the model's raw behavior with zero harness interference.
    """
    return os.environ.get("KWC_NO_SYSTEM", "0") != "0"


def _minimal_prompt_enabled() -> bool:
    """Experiment gate (env KWC_MINIMAL_PROMPT=1): send ONLY the tool list.

    The system prompt, printer memory, auto-fill, and task anchor are all
    omitted so the model's raw behavior with tools can be measured without
    the harness prompt engineering getting in the way. Restart the backend
    with the env var set, then run the accuracy harness.
    """
    return os.environ.get("KWC_MINIMAL_PROMPT", "0") != "0"


# _edit_tools_enabled() was REMOVED by the Phase-6 flag removal
# (2026-09-24): tool-mediated editing is unconditional product behavior
# (the prose draft path died with the Phase-4 ratchet, so the write tools
# are the ONLY edit path). The per-request ChatRequest.editTools override
# remains as the harness A/B knob; chat_proxy arms the session unless the
# request explicitly forces the read-only arm (editTools=False).


# PYTHONIC native tool template leaked as plain text by llama.cpp when the
# SERVED model's chat template has native tool tokens (observed 2026-09 on
# gemma-4-12b @ 192.168.1.135 — the shape comes from the model's training,
# NOT from our advertised text protocol, so no prompt-side format change can
# prevent it; same reason formats 5-6 exist for DSML/XML):
#   <|tool_call>call:NAME{content:<|"|>...multiline value...<|"|>,file: 'macros.cfg'}
#   plus terminator tokens like <tool_call|> / <|tool_call|> around the region.
# The head pipe placement varies (leading-only seen in live traffic). The
# <|"|> sentinel NEVER occurs in legit Klipper/prose text, so sentinel-gated
# regions are deterministic. Fullbank ON run 2026-09-14 AMBI-02: a correct
# config_write with a full macro-file body was lost — ALT_TOOL_CALL_CONTENT_RE
# stops the content group at the first newline, the value is multi-line, and
# the line-bounded cleanup then ATE the visible reply up to the first '}' in
# the body.
TEMPLATE_CALL_HEAD_RE = re.compile(
    r"<\|?tool_call\|?>\s*call:(?:tool_call[\s:]*)?([\w-]+)\s*\{")
TEMPLATE_SENTINEL = '<|"|>'
TEMPLATE_TERM_RE = re.compile(r"</?\|?tool_call\|?>")
# Non-sentineled variant of the same template: call:tool_call:NAME{k: "v"}
# with NO sentinel anywhere. Extraction of the single-line shape already
# works via Format 2/4 (values survive); this regex only removes the leaked
# head/tail tokens from the visible reply. Key-signature guarded like
# CALL_SYNTAX_CLEANUP_RE so macro bodies are never stripped.
TEMPLATE_CALL_CLEANUP_RE = re.compile(
    r"<\|?tool_call\|?>\s*call:(?:tool_call[\s:]*)?[\w-]+\s*\{"
    r"(?!%|\{)[^{}]*[:=][^{}]*\}\s*(?:</?\|?tool_call\|?>)?",
    re.DOTALL,
)


def _parse_pythonic_args(region: str) -> tuple[dict, int]:
    """Parse 'key:<|"|>value<|"|>,key2: raw}' template arguments.

    Scans from the region START so a 'key:' inside a sentineled value
    (gcode: inside a macro body) is consumed as data, never re-read as an
    argument. Non-sentineled values stop at ',' or '}' and are kept only
    when single-line; anything else ends parsing with what was collected.
    Returns (args, consumed_chars).
    """
    args: dict = {}
    pos = 0
    # Optional single/double quotes around the key (JSON-style template
    # rendering: {"file": <S>macros.cfg<S>, "content": <S>...}).
    key_re = re.compile(r"\s*['\"]?(\w+)['\"]?\s*:\s*")
    while pos < len(region):
        rest = region[pos:]
        if rest.startswith(TEMPLATE_SENTINEL):
            # Canonical Hermes joins `,` then re-opens the quote before the
            # key: `...<|"|>,<|"|>content:<|"|>...`. Skip the quoting token.
            pos += len(TEMPLATE_SENTINEL)
            continue
        m = key_re.match(rest)
        if not m:
            break
        key = m.group(1)
        v = pos + m.end()
        if region.startswith(TEMPLATE_SENTINEL, v):
            v += len(TEMPLATE_SENTINEL)
            close = region.find(TEMPLATE_SENTINEL, v)
            if close == -1:
                # Truncated stream: keep the partial value honestly.
                args[key] = region[v:]
                return args, len(region)
            args[key] = region[v:close]
            pos = close + len(TEMPLATE_SENTINEL)
            if pos < len(region) and region[pos] in ",}":
                pos += 1
            continue
        # Non-sentineled value: up to the next ',' or '}' (no braces — a
        # brace here means we ran past the args region).
        end = len(region)
        for i in range(v, len(region)):
            if region[i] in ",}\n":
                end = i
                break
        value = region[v:end].strip()
        if not value:
            break
        args[key] = value.strip("'\"")
        pos = end
        if pos < len(region) and region[pos] in ",}":
            pos += 1
    return args, pos


def _template_call_regions(
    text: str,
) -> list[tuple[int, int, str, dict]]:
    """Locate pythonic template calls: (start, stop, name, args).

    Returns [] unless the literal <|"|> sentinel AND a call head are both
    present — no ordinary text (or a Klipper macro full of {braces}) can
    trigger this path. The region runs from the head through the end of the
    parsed args plus any trailing terminator tokens; if the args can't
    parse at all (prose happened to sit between head and sentinel) the
    region is dropped entirely.
    """
    if TEMPLATE_SENTINEL not in text:
        return []
    regions: list[tuple[int, int, str, dict]] = []
    for head in TEMPLATE_CALL_HEAD_RE.finditer(text):
        name = head.group(1)
        args, consumed = _parse_pythonic_args(text[head.end():])
        if not args:
            continue
        stop = head.end() + consumed
        # Consume trailing terminator tokens (<tool_call|>, <|tool_call|>,
        # </|tool_call|>) and any '}' the parser stopped before.
        while True:
            if stop < len(text) and text[stop] == "}":
                stop += 1
                continue
            m = TEMPLATE_TERM_RE.match(text, stop)
            if m:
                stop = m.end()
                continue
            break
        regions.append((head.start(), stop, name, args))
    return regions


def _extract_template_pythonic_calls(text: str) -> list[dict]:
    return [
        {"name": name, "arguments": args}
        for _start, _stop, name, args in _template_call_regions(text)
    ]


def _strip_template_pythonic_calls(text: str) -> str:
    """Remove template call regions from visible text.

    Sentinel-gated regions (see _template_call_regions) plus the leaked
    head/tail tokens of non-sentineled variants. Regions are code-
    determined — never prose. The generic line-bounded cleanups only ate
    the FIRST line of a region, leaking the rest of a macro body into the
    chat bubble (AMBI-02).
    """
    regions = _template_call_regions(text)
    if regions:
        out: list[str] = []
        cursor = 0
        for start, stop, _name, _args in regions:
            out.append(text[cursor:start])
            cursor = max(cursor, stop)
        out.append(text[cursor:])
        text = "".join(out)
    return TEMPLATE_CALL_CLEANUP_RE.sub("", text)


def _strip_tool_residue(text: str) -> str:
    """Remove orphan tool-call markup (see TOOL_RESIDUE_RE) from visible text.

    A reply that was NOTHING but a fragment must come out empty, so the
    empty-response backstop can act on it instead of raw markup reaching the
    bubble. Blank lines left where a block was removed are collapsed.
    """
    return re.sub(r"\n{3,}", "\n\n", TOOL_RESIDUE_RE.sub("", text)).strip()


def _empty_content_fallback(edit_session: "EditSession | None") -> str:
    """What to show when the model produced no visible text at all.

    The generic "try rephrasing" line is actively misleading once the tool
    turns have STAGED work: the review card sits right there while the bubble
    says nothing happened. In the bank106-r1 sweep (2026-09-29) that hit 11
    qids in ONE model's run — every one of them with a valid pendingEdits
    payload. Name the staged changes instead; the user's next action is to
    review them, not to rephrase the question.
    """
    edits = list(getattr(edit_session, "pending_edits", None) or [])
    if not edits:
        return ("I wasn't able to generate a response. "
                "Please try rephrasing your question.")
    files: list[str] = []
    for edit in edits:
        name = edit.get("file") if isinstance(edit, dict) else None
        if name and name not in files:
            files.append(name)
    plural = "change" if len(edits) == 1 else "changes"
    where = f" to {', '.join(files)}" if files else ""
    return (
        f"I staged {len(edits)} {plural}{where} for your review, but my "
        "summary didn't come through. Approve or discard the card below — "
        "or ask me to explain the change."
    )


def _extract_tool_calls(text: str) -> list[dict]:
    """Extract tool call JSON blocks from a model's response text.

    Handles several formats:
      1. ```tool
         {"name": "...", "arguments": {...}}
         ```
      2. <|tool_call|>{"name": "...", "arguments": {...}} or
         <|tool_call|> call name{arg1="val1", arg2="val2"}
         (native function-calling token from DeepSeek, Llama 3.1+, Qwen, etc.)
      3. name(arg1="val1", arg2=123)
         (Python-style function call without wrapper tokens)
      4. name{arg1="val1", arg2="val2"}
         (brace-style call without wrapper tokens)
      5. DeepSeek DSML:
         <||DSML||invoke name="name">
           <||DSML||parameter name="arg1" string="true">val1</||DSML||parameter>
         </||DSML||invoke>
         (DeepSeek V3.2/V4 native format; returned as plain text by some
         serving stacks instead of structured tool_calls)
      6. Bare XML:
         <tool_calls><invoke name="name">
           <parameter name="arg1">val1</parameter>
         </invoke></tool_calls>
         (Anthropic/DeepSeek style, emitted as plain text by models that
         ignore a no-tools re-prompt)
    """
    calls: list[dict] = []
    seen_contents: set[str] = set()

    # Format 0: pythonic native-template calls with <|"|>-quoted values
    # (multi-line macro bodies the line-bounded formats cannot see). Gated
    # on the sentinel AND known tool names — see TEMPLATE_CALL_HEAD_RE.
    tmpl_known = {t["name"] for t in _mcp_server._list_tools()} | set(EDIT_TOOL_NAMES)
    tmpl_known.add(LOAD_SKILL_SPEC["name"])
    tmpl_known.add(LIST_HARDWARE_SPEC["name"])
    for _start, _stop, t_name, t_args in _template_call_regions(text):
        if t_name not in tmpl_known:
            continue
        key = repr((t_name, sorted(t_args.items())))
        if key in seen_contents:
            continue
        seen_contents.add(key)
        calls.append({"name": t_name, "arguments": t_args})

    # Format 1: standard fenced ```tool block
    for match in MCP_TOOL_BLOCK_RE.finditer(text):
        raw_json = match.group(1).strip()
        if not raw_json or raw_json in seen_contents:
            continue
        seen_contents.add(raw_json)
        try:
            parsed = json.loads(raw_json)
        except json.JSONDecodeError:
            parsed = None
        if not isinstance(parsed, dict):
            # Broken JSON inside an explicit tool fence — attempt mechanical
            # recovery (python-call form, smart/single quotes) before giving
            # up. The fence is unambiguous tool intent, not prose.
            recovered_call = _recover_fenced_tool_call(raw_json)
            if recovered_call:
                # Counted so the A/B can separate silent recoveries from
                # re-prompt corrections (only the latter logs a WARNING).
                logger.debug(
                    "Recovered malformed tool fence | name=%s preview=%s",
                    recovered_call["name"], raw_json[:100].replace("\n", " "),
                )
                calls.append(recovered_call)
            continue
        name = parsed.get("name", "")
        arguments = parsed.get("arguments", {})
        if name and isinstance(arguments, dict):
            calls.append({"name": name, "arguments": arguments})

    # Format 2: <|tool_call|> or <tool_call> native tokens
    for match in ALT_TOOL_CALL_CONTENT_RE.finditer(text):
        content = match.group(1).strip()
        if not content or content in seen_contents:
            continue
        if TEMPLATE_SENTINEL in content:
            # Pythonic template head (Format 0 owns these): this format is
            # line-bounded and would extract a truncated duplicate call
            # from the first line of a multi-line sentinel value.
            continue
        seen_contents.add(content)

        # Try parsing as JSON first
        parsed: dict | None = None
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            pass

        if isinstance(parsed, dict):
            name = parsed.get("name", "")
            arguments = parsed.get("arguments", {})
            if name and isinstance(arguments, dict):
                calls.append({"name": name, "arguments": arguments})
                continue

        # Try parsing "call name{...}" or "name{...}" syntax
        call_match = CALL_SYNTAX_RE.match(content)
        if call_match:
            name = call_match.group(1)
            args_text = call_match.group(2)
            if name:
                recovered = _recover_tool_call(name, args_text)
                if recovered:
                    calls.append({"name": recovered[0], "arguments": recovered[1]})
                    continue
                arguments = _parse_kwargs(args_text)
                calls.append({"name": name, "arguments": arguments})
                continue

        # Try parsing multi-line YAML-style: call:name\nkey: val\nkey2: val2
        # (used by some Gemma variants)
        # ALT_TOOL_CALL_CONTENT_RE only captured first line, so read rest
        # of the tool call from the original text starting after the match.
        name_match = re.match(r"(?:call[\s:]?\s*)?(?:tool_call[\s:]*)?(\w+)", content)
        if name_match and name_match.group(1):
            tool_name = name_match.group(1)
            # Scan subsequent lines in original text for key:value pairs
            remaining = text[match.end():]
            arguments = {}
            for line in remaining.split("\n"):
                line = line.strip()
                if not line:
                    break  # blank line = end of tool call
                kv_match = re.match(r"(\w+)\s*[:=]\s*(.+)", line)
                if kv_match:
                    key = kv_match.group(1)
                    val = kv_match.group(2).strip().strip('"').strip("'")
                    arguments[key] = val
                else:
                    break  # non-key:value line = end of tool call
            if arguments:
                calls.append({"name": tool_name, "arguments": arguments})

    # Format 3: Python-style name(arg1="val1", arg2=123) (no wrapper tokens)
    # This is checked on the full text, not inside a tag wrapper.
    for match in FUNC_CALL_RE.finditer(text):
        content = match.group(0).strip()
        if not content or content in seen_contents:
            continue
        seen_contents.add(content)
        name = match.group(1)
        args_text = match.group(2) if match.lastindex and match.lastindex >= 2 else ""
        if name:
            arguments = _parse_kwargs(args_text)
            calls.append({"name": name, "arguments": arguments})

    # Format 4: name{args} or call name{args} (no wrapper tokens)
    # Checked on the full text, not inside a tag wrapper.
    for match in CALL_SYNTAX_RE.finditer(text):
        content = match.group(0).strip()
        if not content or content in seen_contents:
            continue
        seen_contents.add(content)
        name = match.group(1)
        args_text = match.group(2)
        if name:
            recovered = _recover_tool_call(name, args_text)
            if recovered:
                calls.append({"name": recovered[0], "arguments": recovered[1]})
                continue
            arguments = _parse_kwargs(args_text)
            calls.append({"name": name, "arguments": arguments})

    # Format 5: DeepSeek DSML (Data Structure Markup Language) tool calls.
    # DeepSeek V3.2/V4 native format; some serving stacks return the markup
    # in message.content instead of structured tool_calls.
    for invoke_match in DSML_INVOKE_RE.finditer(text):
        name = invoke_match.group(1).strip()
        body = invoke_match.group(2)
        if not name or body in seen_contents:
            continue
        seen_contents.add(body)
        arguments: dict = {}
        for param_match in DSML_PARAM_RE.finditer(body):
            key = param_match.group(1).strip()
            value = param_match.group(2).strip()
            if key:
                arguments[key] = value
        calls.append({"name": name, "arguments": arguments})

    # Format 6: bare XML tool-call blocks (Anthropic/DeepSeek style):
    #   <tool_calls><invoke name="name"><parameter name="k">v</parameter>
    #   </invoke></tool_calls>
    # Emitted as plain text by models that ignore the no-tools instruction
    # during an empty-response re-prompt.
    for xml_match in XML_INVOKE_RE.finditer(text):
        name = xml_match.group(1).strip()
        body = xml_match.group(2)
        if not name or body in seen_contents:
            continue
        seen_contents.add(body)
        arguments = {}
        for param_match in XML_PARAM_RE.finditer(body):
            key = param_match.group(1).strip()
            value = param_match.group(2).strip()
            if key:
                arguments[key] = value
        calls.append({"name": name, "arguments": arguments})

    # Format 7: bracket-wrapped calls [name(k=v, ...)] (see BRACKET_CALL_RE).
    # Gated on known tool names — config headers ([probe]) and prose with
    # parens must never extract as calls.
    known_tool_names = {t["name"] for t in _mcp_server._list_tools()}
    known_tool_names.add(LIST_HARDWARE_SPEC["name"])
    for bracket_match in BRACKET_CALL_RE.finditer(text):
        content = bracket_match.group(0).strip()
        if not content or content in seen_contents:
            continue
        name = bracket_match.group(1).strip()
        if name not in known_tool_names:
            continue
        seen_contents.add(content)
        arguments = _parse_kwargs(bracket_match.group(2).strip())
        calls.append({"name": name, "arguments": arguments})

    calls = _unwrap_generic_tool_calls(calls)
    if calls:
        names = [c["name"] for c in calls]
        logger.debug("Extracted %d tool call(s): %s", len(calls), names)
    return calls


# Generic wrapper names a template can emit around the REAL call:
#   call:tool{name: "search_klipper_docs", arguments: {...}}
# No real KWC/MCP tool uses any of these names, so seeing one with a
# `name` argument that resolves to a known tool is a literal-shape
# unwrap, not intent inference.
GENERIC_TOOL_WRAPPERS = frozenset({
    "tool", "tool_call", "function", "functions", "call", "invoke",
})


def _balanced_json_object(s: str) -> str | None:
    """Return the first balanced {...} object in s (quote-aware), else None."""
    start = s.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return s[start:i + 1]
    return None


def _unwrap_generic_tool_calls(calls: list[dict]) -> list[dict]:
    """Unwrap call:tool{name: X, arguments: {...}} to name=X.

    Observed live 2026-09-15 (TRIDENT-16, gemma-4-12b via llama.cpp): the
    served template rendered `call:tool{name: "search_klipper_docs",
    arguments: {...}}`; the line-bounded extractor took `tool` as the
    function name and stringified the inner arguments, so the hallucination
    guard skipped a LEGITIMATE call and the answer degraded to ungrounded
    prose. Only unwraps when the wrapper name is generic AND the inner
    name is a known tool (literal-shape inspection only).
    """
    known = {t["name"] for t in _mcp_server._list_tools()} | set(EDIT_TOOL_NAMES)
    known.add(LOAD_SKILL_SPEC["name"])
    known.add(LIST_HARDWARE_SPEC["name"])
    out: list[dict] = []
    for call in calls:
        name = call.get("name", "")
        args = call.get("arguments")
        inner_name = args.get("name") if isinstance(args, dict) else None
        if (
            name in GENERIC_TOOL_WRAPPERS
            and isinstance(inner_name, str)
            and inner_name.strip() in known
        ):
            inner = args.get("arguments", {})
            if isinstance(inner, str):
                obj_text = _balanced_json_object(inner)
                parsed = None
                if obj_text:
                    try:
                        parsed = json.loads(obj_text)
                    except json.JSONDecodeError:
                        parsed = None
                inner = parsed if isinstance(parsed, dict) else _parse_kwargs(inner)
            if not isinstance(inner, dict):
                inner = {}
            call = {"name": inner_name.strip(), "arguments": inner}
        if call not in out:
            out.append(call)
    return out


_KWARG_PAIR_RE = re.compile(r"\s*(\w+)\s*[=:]\s*(.*)$", re.DOTALL)
_KWARG_AHEAD_RE = re.compile(r"\s*\w+\s*[=:]")
# Body-carrying write args. The lenient inner-quote scanner below is only
# sound for these values (Klipper/Jinja bodies are quote-heavy and its
# lookahead rule converges there); among SHORT identifier values a dropped
# quote is genuinely ambiguous and must route to the re-prompt instead of
# being "recovered" into plausible-but-wrong args.
_WRITE_BODY_ARG_RE = re.compile(r'"(?:content|text|new_text|old_text)"\s*:')


def _parse_kwargs(args_text: str) -> dict:
    """Parse keyword arguments from text like 'arg1="val1", arg2=123, key="value"'.

    Handles both colon and equals separators, quoted and unquoted values.
    Splitting is nesting- and quote-aware (Phase-5 text-protocol parity,
    2026-09-24): a value may itself be an object — the llama.cpp wrapper
    renders `call:tool{name: "config_edit", arguments: {op: "set_param",
    file: "printer.cfg", ...}}` with UNQUOTED inner keys, and the old lazy
    regex stopped at the first nested brace, keeping only the opening pair
    and silently dropping every later argument (a write call survived with
    `{"op": "set_param"}` while file/section/key/value vanished). A comma
    separates arguments only at depth 0, outside quotes, and only when what
    follows looks like `key=`/`key:`. An object wrapper around the WHOLE
    text is unwrapped first (the inner fragment arrives braced).
    """
    text = args_text.strip()
    if text.startswith("{") and text.endswith("}"):
        text = text[1:-1]
    parts: list[str] = []
    depth = 0
    quote: str | None = None
    start = 0
    for i, ch in enumerate(text):
        if quote is not None:
            if ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0 and _KWARG_AHEAD_RE.match(text, i + 1):
            parts.append(text[start:i])
            start = i + 1
    parts.append(text[start:])
    arguments: dict = {}
    for part in parts:
        arg_match = _KWARG_PAIR_RE.match(part)
        if not arg_match:
            continue
        arg_name = arg_match.group(1)
        arg_value = arg_match.group(2).strip()
        # Strip ONE matched surrounding quote pair. The old .strip('"\'')
        # also ate quotes that belonged to the value itself.
        if len(arg_value) >= 2 and arg_value[0] == arg_value[-1] \
                and arg_value[0] in "\"'":
            arg_value = arg_value[1:-1]
        arguments[arg_name] = arg_value
    return arguments


# Unterminated ```tool fence: the model opened a tool block and the stream
# ended (or it forgot the closing fence). Such a fence is never legitimate
# content. Bounded at the first BLANK line (review finding #11): fence
# bodies never contain blank lines, but qwen-class models sometimes open a
# broken fence and then recover with real prose — consuming to
# end-of-content silently deleted that answer.
UNTERMINATED_TOOL_FENCE_RE = re.compile(
    r"```tool\b(?:[^\n]*\n)?(?:(?!```)[^\n]+\n)*(?:(?!```)[^\n]*$)?"
)
# Python-call form inside a ```tool fence: name(k=v, ...) / call name(...).
_FENCED_PY_CALL_RE = re.compile(
    r"^(?:call[\s:]?\s*)?(\w+)\s*\((.*)\)\s*$",
    re.DOTALL,
)
# Brace-call form inside a ```tool fence: name{k=v, ...} / call name{...}.
_FENCED_BRACE_CALL_RE = re.compile(
    r"^(?:call[\s:]?\s*)?(\w+)\s*\{(.*)\}\s*$",
    re.DOTALL,
)


def _escape_inner_quotes_json(raw_json: str) -> str | None:
    """Normalize a JSON object whose string values contain unescaped
    double quotes.

    Deterministic scanner, fence-scoped only (a ```tool fence is
    explicit tool intent, never prose): inside a string value, a quote
    terminates the string ONLY when the next non-space character is
    one of , : } ] or the input ends; otherwise it is escaped into the
    value. Klipper macro bodies are full of quotes (SET_LED, Jinja
    string comparisons) and gemma-4-12b emits them raw inside
    config_write JSON content strings (AMBI-02 r6 2026-09-15: the same
    unparseable fence reappeared across 3 nudge rounds + 2 empty
    re-prompts, nothing staged). Genuinely ambiguous shapes close
    early, the retry fails, and the existing re-prompt path takes
    over - fail-closed, same as before.
    """
    Q = chr(34)   # double-quote
    B = chr(92)   # backslash
    WS = " " + chr(9) + chr(13) + chr(10)
    CLOSE = ",:}]"
    out: list[str] = []
    in_str = False
    depth = 0
    i = 0
    n = len(raw_json)
    while i < n:
        c = raw_json[i]
        if in_str:
            if c == B and i + 1 < n:
                out.append(c)
                out.append(raw_json[i + 1])
                i += 2
                continue
            if c == Q:
                j = i + 1
                while j < n and raw_json[j] in WS:
                    j += 1
                if j >= n or raw_json[j] in CLOSE:
                    in_str = False
                    out.append(c)
                else:
                    out.append(B + Q)
            else:
                out.append(c)
        else:
            if c == Q:
                in_str = True
            elif c in "{[":
                depth += 1
            elif c in "}]":
                depth -= 1
            out.append(c)
        i += 1
    # Truncated stream (model hit max_tokens mid-fence — observed live:
    # fence ends `...rear"}` with the closing outer brace missing). Close
    # the open string and append the missing closers; the delta validator
    # still gates the result, so a partial body fails honestly instead of
    # the whole write vanishing.
    if in_str:
        out.append(Q)
    if depth < 0 or depth > 2:
        return None
    if depth:
        out.append("}" * depth)
    return "".join(out)


def _recover_fenced_tool_call(raw_json: str) -> dict | None:
    """Recover a tool call from a ```tool fence whose JSON failed to parse.

    A ```tool fence is explicit tool-call intent, so repairs are scoped to
    fence bodies ONLY (never guessed from prose, per the intent law). Small
    models (qwen 4B class) produce three recurring breakage shapes here:
    python-style ``name(k=v)``, single/smart-quoted pseudo-JSON, and
    unescaped quotes inside values. All are mechanically recoverable.
    """
    # 0) Relaxed JSON retry: `strict=False` accepts LITERAL newlines/tabs
    #    inside string values. The config_write/config_edit content values
    #    ARE multi-line files, and gemma-4-12b emits the macro body with
    #    raw newlines instead of \n escapes (AMBI-02 r4 2026-09-15: the
    #    fence was valid-looking, repeated across 3 nudge rounds, burned
    #    31k tokens, then truncated). Fence-boundary only, so prose is
    #    never touched — the fence is explicit tool intent.
    try:
        parsed = json.loads(raw_json, strict=False)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        name = parsed.get("name", "")
        arguments = parsed.get("arguments", {})
        if isinstance(name, str) and name and isinstance(arguments, dict):
            return {"name": name, "arguments": arguments}
    # 1) Smart quotes → ASCII, then plain JSON retry.
    normalized = (
        raw_json.replace("\u201c", '"').replace("\u201d", '"')
        .replace("\u2018", "'").replace("\u2019", "'")
    )
    if normalized != raw_json:
        try:
            parsed = json.loads(normalized)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            name = parsed.get("name", "")
            arguments = parsed.get("arguments", {})
            if isinstance(name, str) and name and isinstance(arguments, dict):
                return {"name": name, "arguments": arguments}
    # 2) Python call form: name(k=v, ...).
    call_match = _FENCED_PY_CALL_RE.match(normalized.strip())
    if call_match and call_match.group(1):
        return {
            "name": call_match.group(1),
            "arguments": _parse_kwargs(call_match.group(2)),
        }
    # 3) Brace call form: name{k=v, ...}. The brace body may itself be
    #    JSON (llama.cpp `call:tool{"name": ..., "arguments": {...}}`
    #    decoration) — try that before treating it as bare kwargs.
    brace_match = _FENCED_BRACE_CALL_RE.match(normalized.strip())
    if brace_match and brace_match.group(1):
        try:
            parsed = json.loads("{" + brace_match.group(2) + "}")
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            name = parsed.get("name", "")
            arguments = parsed.get("arguments", {})
            if isinstance(name, str) and name and isinstance(arguments, dict):
                return {"name": name, "arguments": arguments}
        return {
            "name": brace_match.group(1),
            "arguments": _parse_kwargs(brace_match.group(2)),
        }
    # 4) Single-quoted pseudo-JSON (only when there are no double quotes to
    #    protect): {"name": ...} with ' throughout.
    if "'" in normalized and '"' not in normalized:
        try:
            parsed = json.loads(normalized.replace("'", '"'))
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            name = parsed.get("name", "")
            arguments = parsed.get("arguments", {})
            if isinstance(name, str) and name and isinstance(arguments, dict):
                return {"name": name, "arguments": arguments}
    # 5) Unescaped double quotes inside string VALUES (macro bodies).
    # Gated to the write tools AND to a body-carrying argument: only
    # config_write/config_edit carry file bodies full of quotes, where the
    # lookahead rule converges. For short identifier values (read_user_config
    # etc., and write calls whose only args are op/file/section/key/value),
    # unescaped quotes are genuinely ambiguous and MUST route to the
    # re-prompt instead of executing corrupted args (locked by
    # test_chat_proxy_malformed_tool_call_gets_one_format_reprompt for reads
    # and test_config_edit_short_value_corruption_routes_to_reprompt for
    # writes — the scanner used to run on ANY config_edit fence and
    # "recovered" a corrupted set_param with the section swallowing
    # `printer" key: max_accel`, Phase-5 parity probe 2026-09-24).
    if re.search(r'"name"\s*:\s*"(?:config_write|config_edit)"', normalized) \
            and _WRITE_BODY_ARG_RE.search(normalized):
        escaped = _escape_inner_quotes_json(normalized)
    else:
        escaped = None
    if escaped:
        try:
            parsed = json.loads(escaped, strict=False)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            name = parsed.get("name", "")
            arguments = parsed.get("arguments", {})
            if isinstance(name, str) and name and isinstance(arguments, dict):
                return {"name": name, "arguments": arguments}
    return None


def _known_tool_names() -> set[str]:
    """Every tool name the chat loop can dispatch.

    MCP server tools plus the chat-layer extras: the write tools, `load_skill`
    (the model-triggered skill gate is product behavior) and
    `list_hardware`. Three copies of this
    set used to live inline (extractor, generic-wrapper unwrap, loop) — they are
    ONE surface, so keep them from drifting.
    """
    known = {t["name"] for t in _mcp_server._list_tools()} | set(EDIT_TOOL_NAMES)
    known.add(LOAD_SKILL_SPEC["name"])
    known.add(LIST_HARDWARE_SPEC["name"])
    return known


# A ```json-fenced block (models use json/json5/javascript labels) whose body
# is a bare tool call. The ```tool extractor cannot see these, so without the
# malformed guard the loop reads the reply as prose and ships the raw JSON
# into the chat bubble (qwen3.5-4b text arm, EDIT-06, 2026-09-24).
_JSON_FENCE_RE = re.compile(
    r"```(?:json|jsonc|json5|javascript|js)[ \t]*\n(.*?)```", re.DOTALL
)


def _json_fence_tool_call(text: str) -> bool:
    """True when a ```json fence IS a tool call, not display JSON.

    Literal shape only, fail-closed: the fence body must parse as ONE object
    carrying a `name` that is a KNOWN tool plus an `arguments` object. Unknown
    names, config content, and JSON examples in prose are never treated as
    intent — the guard only asks for one format correction (it never executes
    the fenced call; execution stays a ```tool-fence privilege).
    """
    known: set[str] | None = None
    for match in _JSON_FENCE_RE.finditer(text):
        try:
            obj = json.loads(match.group(1).strip(), strict=False)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(obj, dict):
            continue
        name = obj.get("name")
        # `arguments` must be PRESENT and an object: a bare {"name": …} is a
        # fragment (often a prose example), not a call shape.
        if "arguments" not in obj or not isinstance(obj.get("arguments"), dict):
            continue
        if not isinstance(name, str):
            continue
        if known is None:
            known = _known_tool_names()
        if name.strip() in known:
            return True
    return False


def _malformed_tool_call_detected(text: str, calls: list[dict]) -> bool:
    """True when the reply contains tool-call intent that failed to parse.

    Deterministic post-hoc detection over explicit ```tool protocol fences
    only: a fence body that mentions a name/call shape but yielded no call,
    or an unterminated ```tool fence (truncated stream). Prose that merely
    mentions tools never triggers this.
    """
    if calls:
        return False
    if _json_fence_tool_call(text):
        return True
    for fence in MCP_TOOL_BLOCK_RE.finditer(text):
        body = fence.group(1)
        if re.search(r"\bname\b|\bcall\b|\w+\s*[({]", body):
            return True
    return bool(UNTERMINATED_TOOL_FENCE_RE.search(text))


# One protocol-correction re-prompt for a malformed tool call. The broken
# call is NEVER quoted (REPAIR-01: models copy broken drafts verbatim) —
# the model only gets the exact format and a clean path back.
MALFORMED_TOOL_REPROMPT_LIMIT = 1
MALFORMED_TOOL_FORMAT_FEEDBACK = (
    "Your previous response contained a tool call that could not be parsed, "
    "so it was not executed. Do not copy or repeat your previous response. "
    'To call a tool, respond with exactly one fenced block in this format:\n\n'
    "```tool\n"
    '{"name": "<tool_name>", "arguments": {"key": "value"}}\n'
    "```\n\n"
    'Use double quotes around every name and string value, keep the JSON on '
    'valid one-line or multi-line form, and always close the fence. If you '
    "no longer need a tool, answer the user's question directly in text "
    "instead."
)


# ── Repeat-read guard ───────────────────────────────────────────────────
#
# Live flash-next full-bank 2026-09-23: every timeout-class ERROR was a
# tool-loop that stopped CONVERGING and started re-reading — read_user_config
# x10 (LIVE-01), x12 (SKILL-05), x6 (TRIDENT-16); search_klipper_docs x9/x6.
# Identical (name, arguments) calls return identical text, so rounds 2..n
# add tokens and wall-clock but zero information — and the bigger context
# makes each following turn slower, ending at the harness timeout with no
# answer. The guard serves a lean directive instead of re-executing a
# call it already ran THIS request.
#
# Scope is deliberately narrow (intent law): literal (name, canonical-JSON
# args) equality only — never similarity, never intent. Only idempotent
# PURE-READ tools are guarded; validation tools are excluded because a
# re-validate after an edit is a legitimate convergence check, and write
# tools already have their own identical-failure ladder in EditSession.
REPEAT_GUARD_TOOLS = frozenset({
    "read_user_config",
    "list_user_configs",
    "list_user_config_sections",
    "search_user_configs",
    "read_klipper_doc",
    "search_klipper_docs",
    "list_klipper_docs",
    "get_config_reference_section",
    "list_config_reference_sections",
    "read_example_config",
    "search_example_configs",
    "get_section_schema",
})

REPEAT_READ_FEEDBACK = (
    "ALREADY RETRIEVED — this exact call ran earlier in this request and "
    "returned the identical result, which is still in this conversation. "
    "It was not executed again. Repeating identical reads will never add "
    "information: use the result you already have (apply the edit, or "
    "answer the user), or change strategy with a DIFFERENT query."
)


def _repeat_read_key(tool_call: dict) -> str:
    """Literal dedup key: tool name + canonical JSON of its arguments.

    Returns '' for anything outside REPEAT_GUARD_TOOLS so callers can skip
    cheaply. sort_keys makes argument ordering irrelevant; everything else
    is exact.
    """
    name = tool_call.get("name", "")
    if name not in REPEAT_GUARD_TOOLS:
        return ""
    try:
        args = json.dumps(tool_call.get("arguments") or {},
                          sort_keys=True, default=str)
    except (TypeError, ValueError):
        args = repr(tool_call.get("arguments"))
    return f"{name}|{args}"


def _strip_bracket_tool_calls(text: str) -> str:
    """Strip bracket-wrapped tool calls whose name is a REAL tool.

    Name-gated mirror of BRACKET_CALL_RE: only known tool names are removed,
    so config section headers ([probe], [include printer.cfg]) and prose with
    parens survive the cleanup chain.
    """
    known_tool_names = {t["name"] for t in _mcp_server._list_tools()}
    known_tool_names.add(LIST_HARDWARE_SPEC["name"])
    return BRACKET_CALL_RE.sub(
        lambda m: "" if m.group(1).strip() in known_tool_names else m.group(0),
        text,
    )


# llama.cpp/Gemma text-protocol templates wrap tool calls in decoration
# tokens where the visible name is NOT the tool name:
#   call:tool{"name": "...", "arguments": {...}}   <- real name in JSON body
#   call:tool_use_search_klipper_docs{query: ...}  <- real name in the token
#   tool\n{"name": "...", "arguments": {...}}      <- bare 'tool' token
# The generic parser sees name='tool' / 'tool_use_<NAME>' and the calls get
# discarded by the hallucinated-tool guard, leaving an empty response. Recover
# the real name before that guard runs.
_TOOL_DECORATION_RE = re.compile(r"tool_(?:use|call)_(.+)")


def _recover_tool_call(token: str, args_text: str) -> tuple[str, dict] | None:
    """Recover (name, arguments) from a decorated tool-call token.

    Returns None when the token is a plain tool name — the caller then falls
    back to the generic extraction.
    """
    # 1) The args body is JSON with explicit name + arguments. The generic
    #    CALL_SYNTAX_RE strips the outer braces, so try the fragment both
    #    bare and re-wrapped.
    for candidate in (args_text, "{" + args_text + "}"):
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(parsed, dict):
            name = parsed.get("name")
            arguments = parsed.get("arguments")
            if isinstance(name, str) and name and isinstance(arguments, dict):
                return name, arguments
            break
    # 2) The token embeds the name: tool_use_<NAME> / tool_call_<NAME>.
    m = _TOOL_DECORATION_RE.match(token)
    if m:
        return m.group(1), _parse_kwargs(args_text)
    return None


def _execute_tool_call(tool_call: dict) -> str:
    """Execute a single MCP tool call and return the text result.

    SYNC — some handlers (list_connected_devices, get_klippy_status) do
    blocking host I/O for seconds. From the async chat loop call
    _execute_tool_call_async instead; direct calls are for sync contexts
    only (tests).
    """
    name = tool_call.get("name", "")
    arguments = tool_call.get("arguments", {})

    # Build a JSON-RPC request for the tool
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": arguments,
        },
    }

    response = _mcp_server.handle_jsonrpc(request)
    if response is None:
        return f"Error: Tool '{name}' returned no result."

    error = response.get("error")
    if error:
        return f"Error calling tool '{name}': {error.get('message', 'Unknown error')}"

    result = response.get("result", {})
    content = result.get("content", [])
    text_parts = [
        item["text"] for item in content if item.get("type") == "text"
    ]
    return "\n\n".join(text_parts) if text_parts else "Tool returned no content."


async def _execute_tool_call_async(tool_call: dict) -> str:
    """Off-thread wrapper for the chat loop (review finding #14).

    list_connected_devices runs CAN/USB scans and get_klippy_status probes
    host endpoints; both block for seconds. Running them inline froze the
    event loop — every other request (health checks, saves, other chats)
    stalled behind one tool call. asyncio.to_thread keeps the loop free.
    """
    return await asyncio.to_thread(_execute_tool_call, tool_call)


def _set_working_overlay(edit_session: "EditSession | None") -> None:
    """Mirror the request's live working state into the MCP read tools.

    The session is the truth during a chat request: the frontend's
    unsaved drafts seeded it, and every approved edit commits into it.
    The MCP user-config tools read DISK, which lags until the user saves
    — the mixed-signal class of bug Sir hit live 2026-09-27 (search
    'level_bed' after staging 'level_bed1' → the OLD section kept
    "existing"). Refreshed before EVERY MCP tool call so overlays track
    mid-request commits; the contextvar is per-request-task, so nothing
    leaks across requests, and the non-chat MCP surface is untouched.
    """
    from mcp_server import set_chat_working_files
    try:
        set_chat_working_files(
            dict(edit_session.state.files) if edit_session is not None else None)
    except Exception:  # pragma: no cover - defensive; reads fall back to disk
        logger.debug("working overlay unavailable", exc_info=True)


async def _run_approval_gate(
    session: EditSession,
    tool_call: dict,
    stop_event: asyncio.Event | None,
    request_id: str | None,
    log,
) -> tuple[str, dict | None]:
    """Approval-gated write (**DORMANT** — retired from the edit path).

    NO CALLER since 2026-10-02 (post-hoc edit review): validated edits
    stage immediately and are reviewed after the reply, so nothing in the
    edit path suspends. This is kept, not deleted, because it is the
    correct machinery for the FIRST IRREVERSIBLE tool — a disk write, a
    firmware restart, a command sent to the printer — where a keep/undo
    surface cannot take the decision back. Its contract is unchanged and
    its wording is pinned by tests/test_ai_approval_gate.py, so landing
    that tool does not re-derive any of it.

    Returns (lean content, details-or-None) with the same contract as
    EditSession.execute().

    Invalid calls kick back immediately — the gate NEVER produces a card
    for a call with new validation errors (plan law). A validated call
    suspends IN-REQUEST: the frontend polls GET /ai/chat/approval for the
    card, POST /ai/chat/approval resolves the Future (approve re-validates
    against the latest frontend state before committing), and a 90s
    non-response auto-declines with an honest reason. The model loop never
    sees a fabricated user intent.

    REVIVAL — when the first irreversible tool lands, three steps:

    1. Restore the caller at BOTH dispatch sites (the main tool loop and
       the empty-reprompt path). main's shape, which is the one to
       recover, was::

           if req.autoApproveEdits:
               result_text, details = edit_session.execute(tool_call)
           else:
               result_text, details = await _run_approval_gate(...)

       Scope the branch to the IRREVERSIBLE tool only — reversible
       staging stays post-hoc reviewed, so do not route every write back
       through here.

    2. ChatRequest.autoApproveEdits is still declared on the request
       model: that is the hook step 1 branches on. It is inert until
       step 1 lands, and it is kept for exactly this.

    3. The harness re-adds ONE line in
       scripts/ai_chat_accuracy_test.py::chat_request()::

           if effective_edit:
               payload["autoApproveEdits"] = True

       It was removed 2026-10-03 (commit 3b2cb23) because with no gate in
       the path there was nothing left to bypass. A bank question for the
       gated tool is what brings it back.
    """
    name = tool_call.get("name", "")
    content, result, _preview_state = session.prepare(tool_call)
    if result is None:
        return content, None  # kickback; no card, no wait

    op = EditSession.tool_call_to_op(name, tool_call.get("arguments", {}) or {})
    approval = create_approval(name, op or {}, result, session, request_id)
    log.info(
        "Approval card opened | approvalId=%s name=%s file=%s timeout=%ds",
        approval.approval_id, name, result.get("file", ""),
        int(APPROVAL_TIMEOUT_SECONDS),
    )
    try:
        decision = await approval.wait_or_stop(APPROVAL_TIMEOUT_SECONDS, stop_event)
    finally:
        remove_approval(approval.approval_id)
    log.info(
        "Approval resolved | approvalId=%s decision=%s waited=%.1fs",
        approval.approval_id, decision.get("decision"),
        approval.loop.time() - approval.created_at,
    )
    if decision.get("decision") != "approved":
        # Decline / timeout / user-stop is USER-GATED: the prose nudge
        # must not pressure the model to retry a decision the user just
        # made (live smoke evidence: post-decline nudge looped into
        # repeated cards for the same target). Only an approve leaves
        # 'success'.
        session.last_write_outcome = "user_gated"
    return format_approval_result(name, decision)


# Client-facing tool-call detail records are capped so a huge tool output
# (e.g. a whole config file read) never bloats the chat response JSON.
TOOL_CALL_ARGS_MAX_CHARS = 2000
TOOL_CALL_OUTPUT_MAX_CHARS = 4000


def _build_executed_tool_call(tool_call: dict, result_text: str) -> dict:
    """Build a bounded {name, arguments, output} record for the client."""
    name = tool_call.get("name", "unknown")
    arguments = tool_call.get("arguments", {})
    try:
        arguments_json = json.dumps(arguments, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        arguments_json = json.dumps({"raw": str(arguments)}, ensure_ascii=False)

    if len(arguments_json) > TOOL_CALL_ARGS_MAX_CHARS:
        arguments_json = arguments_json[:TOOL_CALL_ARGS_MAX_CHARS] + "...[truncated]"

    output_text = str(result_text or "")
    output_truncated = len(output_text) > TOOL_CALL_OUTPUT_MAX_CHARS
    if output_truncated:
        output_text = output_text[:TOOL_CALL_OUTPUT_MAX_CHARS] + "...[truncated]"

    return {
        "name": name,
        "arguments": arguments_json,
        "output": output_text,
        "outputTruncated": output_truncated,
    }


# ── Pre-edit verdict guard (2026-11-17) ───────────────────────────────
# MACRO-17 measured the same miss through four prompt levers: the model
# simulates the as-written text, receives the tool's ERROR findings,
# stages a fix, re-simulates CLEAN — and the final answer reports ONLY
# the post-fix world. The as-written verdict exists in the request's own
# tool trace but never reaches the answer. The guard is trace-mechanical
# (intent law clean — it parses TOOL outputs and the write trace, never
# the model's prose for claims): pre-write simulate_macro with ERROR
# findings + a later staged write to the SAME [gcode_macro ...] + a
# final answer quoting NONE of the failing values the tool reported.
_SIM_HEADER_MACRO_RE = re.compile(r"^# simulate_macro gcode_macro (\S+)", re.M)
_SIM_ERROR_LINE_RE = re.compile(r"^\s*-\s*ERROR:\s*(.+?)\s*$", re.M)
_FAILING_VALUE_TOKEN_RE = re.compile(r"[A-Z][A-Z_0-9]*=([0-9]+(?:\.[0-9]+)?)")
# A failing value only counts as REPORTED when the same sentence carries a
# refusal verb. m17guard r7/r9 proved bare token presence is too weak:
# "now uses RED=1.0 ... instead of `1.8`" is a changelog mention — the
# as-written failure is still never stated.
_VERDICT_REFUSAL_RE = re.compile(
    r"(?i)outside|out of range|reject|refus|fail|error|unable|abort|"
    r"exceed|invalid|does not run|won'?t run|will not run")


def _verdict_reported(final_content: str, tokens: set) -> bool:
    """True when some failing value appears inside a refusal-worded sentence."""
    normalized = " ".join((final_content or "").split())
    spans = [(m.start(), m.end())
             for m in re.finditer(r"[^.!?\n]+[.!?]?", normalized)]
    for token in tokens:
        for m in re.finditer(re.escape(token), normalized):
            span = next(((a, b) for a, b in spans if a <= m.start() < b),
                        (m.start(), m.end()))
            if _VERDICT_REFUSAL_RE.search(normalized[span[0]:span[1]]):
                return True
    return False


def _pre_write_verdict_miss(
    executed_tool_calls: list, final_content: str
) -> str | None:
    """Nudge text when the answer silently replaces the as-written verdict.

    Pure over the request's executed-tool-call trace. Returns None (fail
    safe — no re-prompt) unless: (1) a simulate_macro BEFORE the first
    write emitted ERROR findings; (2) a write at/after that point touches
    the same [gcode_macro <name>]; (3) the answer never reports the
    refusal — no failing value appears in any refusal-worded sentence
    (_verdict_reported).
    """
    first_write_idx = next(
        (i for i, c in enumerate(executed_tool_calls or [])
         if c.get("name") in EDIT_TOOL_NAMES),
        None,
    )
    if first_write_idx is None or not (final_content or "").strip():
        return None
    normalized = " ".join((final_content or "").split())
    fails: list[tuple[str, str, set]] = []
    for call in executed_tool_calls[:first_write_idx]:
        if call.get("name") != "simulate_macro":
            continue
        output = str(call.get("output") or "")
        header = _SIM_HEADER_MACRO_RE.search(output)
        errors = _SIM_ERROR_LINE_RE.findall(output)
        if not header or not errors:
            continue
        tokens = set()
        for line in errors:
            tokens.update(_FAILING_VALUE_TOKEN_RE.findall(line))
        if tokens:
            fails.append((header.group(1), errors[0], tokens))
    if not fails:
        return None
    touched = None
    for call in executed_tool_calls[first_write_idx:]:
        if call.get("name") not in EDIT_TOOL_NAMES:
            continue
        args_text = str(call.get("arguments") or "")
        for macro, first_error, tokens in fails:
            if f"gcode_macro {macro}" in args_text:
                touched = (macro, first_error, tokens)
                break
        if touched:
            break
    if touched is None:
        return None
    _macro, first_error, tokens = touched
    if _verdict_reported(normalized, tokens):
        return None
    return (
        "Your report describes the FIXED macro, but the question was "
        "whether the text as written works. Your own pre-edit "
        f"simulation found: {first_error} "
        "Do not call any more tools and do not change anything else. "
        "Re-answer the original question in prose — the first sentence "
        "must be the as-written verdict quoting that simulation finding, "
        "before any summary of the fix."
    )


def _build_tool_result_message(tool_call: dict, result_text: str) -> str:
    """Build a user-role message containing the tool result for re-prompting."""
    name = tool_call.get("name", "unknown")
    args = tool_call.get("arguments", {})
    args_summary = ", ".join(f"{k}={v}" for k, v in args.items())
    return (
        f"[Tool result: {name}({args_summary})]\n\n"
        f"{result_text}\n\n"
        "[End tool result. Use this information to answer the user's latest (last) request above. "
        "Earlier messages are history and context. Do not repeat the tool call.]"
    )


MAX_MCP_TOOL_TURNS = 10
# With the write tools on, multi-edit requests chain read->edit->retry
# round-trips; 10 exhausted too early (plan Phase 1). Raised 20 -> 50
# (2026-10-16 large-edit rework): a 62-section request batched via ops[]
# needs ~15-25 CALLS; 20 turned the cap itself into the early-exit the
# user saw. The runaway guard is now the thrash budget + the absolute
# per-request op ceiling below, not the turn cap.
MAX_MCP_TOOL_TURNS_EDIT = 50
# Work-earned cap credit (2026-10-26): this flat cap stays FULLY
# chargeable to everything (reads, searches, failed writes), but each
# config_edit/config_write call that applied at least one op raises the
# cap for the rest of the request (cap_grant_per_applied_write(),
# default +5/call, KWC_CAP_GRANT_PER_APPLIED_WRITE; 0 = flat A/B arm).
# The 160-section dogfood proved the flat number charges correct work:
# two runs died at exactly 50 mid-batch (live log 2026-10-26). Guarding
# against a runaway stays the thrash budget + _identical_failures +
# MAX_TOOL_OPS_PER_REQUEST below, none of which the credit relaxes.
# Per-message tool-call slice bound (the `tool_calls[:N]` execution
# window). Non-edit requests stay at 10; an edit-capable request gets 20
# per message so one batched multi-edit turn is never silently truncated.
MAX_TOOL_CALLS_PER_MESSAGE = MAX_MCP_TOOL_TURNS
MAX_TOOL_CALLS_PER_MESSAGE_EDIT = 20
# Invisible runaway ceiling: absolute executed tool-call cap per request.
# Never announced to the model (budget pressure stays invisible until the
# thrash budget itself is spent); hitting it is a harness bug worth a
# log line, not a budget the model is expected to plan around.
MAX_TOOL_OPS_PER_REQUEST = 500
# When a model ends its turn with only a tool call and no visible text
# (tool-loop exhaustion, an unparseable call format, or a final tool-only
# response), re-prompt it without tools to force a direct text answer.
EMPTY_REPROMPT_LIMIT = 2
# Reasoning-enabled local builds (llama.cpp --reasoning-budget) spend part of
# the completion budget on hidden tokens that never become visible content.
# A low max_tokens can exhaust the whole budget invisibly and come back
# empty with finish_reason=length. When re-prompting, give local providers
# at least this much room so the hidden prefix + the real answer both fit.
EMPTY_REPROMPT_MAX_TOKENS = 4096


def _collect_tool_names(messages: list[dict]) -> list[str]:
    """Extract unique tool names from tool result messages in the conversation."""
    names: list[str] = []
    seen: set[str] = set()
    for msg in messages:
        content = str(msg.get("content", ""))
        m = re.search(r"\[Tool result: (\w+)\(", content)
        if m:
            name = m.group(1)
            if name not in seen:
                seen.add(name)
                names.append(name)
    return names


def _native_tool_object(tool: dict) -> dict:
    return {
        "type": "function",
        "function": {
            "name": tool["name"],
            "description": tool.get("description", "").replace("\n", " "),
            "parameters": tool.get("inputSchema", {"type": "object", "properties": {}}),
        },
    }


def _build_native_tools(edit_capable: bool = False, *,
                        skill_active: bool = False) -> list[dict]:
    """Build native function-calling tool definitions from the MCP server.

    Returns OpenAI-style tool objects:
        {"type": "function", "function": {"name", "description", "parameters"}}

    With edit_capable, the model-triggered skill gate is in force:
    load_skill is advertised and the request-scoped write tools
    (config_edit/config_write, defined in services.ai_edit_tools, not
    registered on the MCP server) join the advertisement only once the
    skill is active — kept in lock-step with the text protocol surface
    (test_edit_tool_native_text_parity).
    """
    native: list[dict] = []
    for tool in _mcp_server._list_tools():
        native.append(_native_tool_object(tool))
    # Chat-layer read tool (working-state backed, see dispatch):
    # advertised on both protocols for parity.
    native.append(_native_tool_object(LIST_HARDWARE_SPEC))
    if edit_capable:
        native.append(_native_tool_object(LOAD_SKILL_SPEC))
        if skill_active:
            for tool in EDIT_TOOL_SPECS:
                native.append(_native_tool_object(tool))
    return native


def _resolve_native_tools(provider: str, api_url: str, tool_protocol: str,
                          edit_capable: bool = False, *,
                          skill_active: bool = False) -> list[dict] | None:
    """Decide whether to pass native function-calling tools to the provider.

    tool_protocol values (frontend setting / harness via ChatRequest):
      - "auto" (default) NATIVE FIRST for every provider, local llama.cpp
        included. Modern llama.cpp (b456+ --jinja) handles tool templates
        cleanly (verified 2026-09: finish_reason=tool_calls, empty content,
        valid JSON args on gemma-4-12b), and the native machine channel is
        what stops models from reading protocol text back at the user —
        results travel as role=tool turns instead of user-role
        "[Tool result: ...]" lookalikes. Servers that ignore the tools
        array still work: the loop keeps regex text extraction as a
        fallback (native_calls or _extract_tool_calls).
      - "text"   force the text ```tool protocol (escape hatch for a
                 server that advertises tools but emits template garbage).
      - "native" explicit native (identical to auto today; kept as the
                 selector value the UI can pin).
    """
    if tool_protocol == "text":
        return None
    return _build_native_tools(edit_capable=edit_capable,
                               skill_active=skill_active)


def _extract_native_tool_calls(provider: str, data: dict) -> list[dict] | None:
    """Extract structured tool calls from a provider response.

    Handles native function-calling responses:
      - OpenAI-compatible: choices[0].message.tool_calls
      - Anthropic: content blocks with type == "tool_use"

    Returns a list of {"name", "arguments", "id"} or None when the response
    contains no native tool calls (plain text or text ```tool blocks).
    """
    try:
        if provider == "anthropic":
            blocks = data.get("content")
            if not isinstance(blocks, list):
                return None
            calls: list[dict] = []
            for block in blocks:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    calls.append({
                        "name": block.get("name", ""),
                        "arguments": block.get("input", {}) or {},
                        "id": block.get("id", ""),
                    })
            return calls or None

        message = data.get("choices", [{}])[0].get("message", {})
        raw_calls = message.get("tool_calls")
        if not raw_calls:
            return None
        calls = []
        for raw in raw_calls:
            if not isinstance(raw, dict) or raw.get("type") != "function":
                continue
            function = raw.get("function", {})
            name = function.get("name", "")
            arguments = function.get("arguments", "{}")
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    arguments = {}
            if name:
                calls.append({
                    "name": name,
                    "arguments": arguments,
                    "id": raw.get("id", ""),
                    # Gemini 3.5+ reasoning models attach a thought_signature here;
                    # it MUST be echoed back on the follow-up or Google 400s.
                    "extra_content": raw.get("extra_content"),
                })
        return calls or None
    except Exception:
        return None


def _build_native_tool_followup(
    provider: str,
    assistant_content: str,
    tool_calls: list[dict],
    results: list[str],
) -> list[dict]:
    """Build the messages that continue a native function-calling exchange.

    OpenAI-compatible providers require the assistant message with its
    tool_calls echoed back, followed by one 'tool' message per call.
    Anthropic requires the assistant content blocks (including tool_use)
    echoed back, followed by a single user message with tool_result blocks.

    Returns the list of messages to append to the conversation.
    """
    if provider == "anthropic":
        content_blocks: list[dict] = []
        if assistant_content:
            content_blocks.append({"type": "text", "text": assistant_content})
        for call in tool_calls:
            content_blocks.append({
                "type": "tool_use",
                "id": call.get("id") or f"toolu_{call['name']}",
                "name": call["name"],
                "input": call["arguments"],
            })
        tool_results = [
            {
                "type": "tool_result",
                "tool_use_id": call.get("id") or f"toolu_{call['name']}",
                "content": result,
            }
            for call, result in zip(tool_calls, results)
        ]
        return [
            {"role": "assistant", "content": content_blocks},
            {"role": "user", "content": tool_results},
        ]

    assistant_message: dict = {
        "role": "assistant",
        "content": assistant_content or None,
        "tool_calls": [
            {
                "type": "function",
                "id": call.get("id") or f"call_{index}",
                "function": {
                    "name": call["name"],
                    "arguments": json.dumps(call["arguments"])
                    if isinstance(call["arguments"], dict)
                    else str(call["arguments"]),
                },
                # Gemini 3.5+ requires the thought_signature to be echoed back.
                **({"extra_content": call["extra_content"]} if call.get("extra_content") else {}),
            }
            for index, call in enumerate(tool_calls)
        ],
    }

    tool_messages = [
        {
            "role": "tool",
            "tool_call_id": call.get("id") or f"call_{index}",
            "content": result,
        }
        for index, (call, result) in enumerate(zip(tool_calls, results))
    ]

    return [assistant_message, *tool_messages]


# ── C2: provider wire-shape ladder (prefix cache vs strict templates) ─────
#
# WHY THREE SHAPES. The volatile per-turn blocks (work ledger, W3 runtime
# observation) must ride at the END of the payload: providers cache the exact
# longest-common-prefix of the rendered prompt, so anything that changes
# between turns inside the leading system message re-prefills the whole
# replayed transcript (measured 2026-11-20: ~11K tokens busted the moment the
# ledger's first row landed). But open-weight chat templates fight back: the
# Qwen3.x Jinja template raises
# 'System message must be at the beginning' the instant a system message
# appears after position 0 — verified live on qwen/Qwen3.8-flash-next
# (HTTP 500, pre-generation) while gemma and gpt-oss slots accept it. The
# same collision is reported upstream for Claude Code / Codex on Qwen
# (llama.cpp #27081, #27367; Qwen3.8-27B discussion #148) and LiteLLM added a
# static `supports_mid_conversation_system: false` capability flag for it.
#
# So the shape is a capability, and capabilities are learned — guessing wrong
# must not cost the user a turn. Precedence:
#   1. the shape learned for this (url, model) — persisted when it was earned
#      from a real rejection,
#   2. `_STRICT_SYSTEM_FIRST_MODEL_PATTERNS` for templates documented strict,
#   3. `tail_system` (best framing, best cache) as the optimistic default.
# A genuine template rejection then walks down one rung and retries in the
# SAME request — the user never sees the 500 — and the working shape is
# remembered so the rejection is paid once per endpoint, not once per turn.
#
# A template rejection is PRE-GENERATION (the failure happens while rendering
# the Jinja template, before any token is produced), so the retry cannot
# double-charge. Non-template failures (401/429/5xx/timeout) never reshape
# and never retry here — see `_looks_like_template_rejection`.

PROVIDER_SHAPES = ("tail_system", "tail_user", "merged")

# The tail-user rung recasts harness blocks as a user message (the Claude
# Code / Pydantic-AI pattern: volatile context in the system role sits at the
# front and busts the prefix). The label keeps the model from reading them as
# human prose.
VOLATILE_TAIL_LABEL = ("[Harness context — recorded by the app during this "
                       "conversation, not typed by the user]")

# Templates documented (upstream reports, or probed on this network) to
# require system-at-index-0. Only a starting hint: `_provider_shape_memory`
# overrides it the moment the wire proves otherwise.
_STRICT_SYSTEM_FIRST_MODEL_PATTERNS = ("qwen3",)

# Learned shapes, keyed by (url, model). Loaded lazily from disk so a restart
# does not re-pay the rejection.
_provider_shape_memory: dict[tuple[str, str], str] = {}
_shape_memory_loaded = False

# File name only: AI_DATA_DIR is defined further down this module, and the
# helpers below resolve it at CALL time (import order must not force a move).
_SHAPE_FILE_NAME = "provider_shapes.json"


def _shape_memory_key(url: str, model: str) -> tuple[str, str]:
    return (str(url or "").rstrip("/"), str(model or ""))


def _shape_file_path() -> Path:
    return AI_DATA_DIR / _SHAPE_FILE_NAME


def _ensure_shape_memory_loaded() -> None:
    global _shape_memory_loaded
    if _shape_memory_loaded:
        return
    _shape_memory_loaded = True
    try:
        saved = _load_ai_json(_shape_file_path())
    except Exception:
        logger.warning("provider shape memory load failed", exc_info=True)
        return
    for key, shape in saved.items():
        if not isinstance(key, str) or shape not in PROVIDER_SHAPES:
            continue
        url, _, model = key.partition("\x00")
        _provider_shape_memory[(url, model)] = str(shape)


def _learned_shape(url: str, model: str) -> str | None:
    _ensure_shape_memory_loaded()
    return _provider_shape_memory.get(_shape_memory_key(url, model))


def _remember_shape(url: str, model: str, shape: str,
                    persist: bool = False) -> None:
    """Record the shape that worked.

    `persist=True` is reserved for shapes learned from an ACTUAL rejection:
    that evidence is expensive (it cost a round trip) and not inferable from
    the hint table, so it survives a restart. A plain optimistic success is
    process-local — it says nothing a retry could not re-derive, and writing
    it would let unit-test traffic poison a production artifact (it did).
    """
    if shape not in PROVIDER_SHAPES:
        return
    _ensure_shape_memory_loaded()
    key = _shape_memory_key(url, model)
    if _provider_shape_memory.get(key) == shape and not persist:
        return
    _provider_shape_memory[key] = shape
    if not persist:
        return
    try:
        saved = _load_ai_json(_shape_file_path())
        saved["\x00".join(key)] = shape
        _save_ai_json(_shape_file_path(), saved)
    except Exception:
        # Learning is an optimization: losing the persistence write costs a
        # future rejection-retry, never a turn. Loud, not silent (B-L4 law).
        logger.warning("provider shape memory save failed", exc_info=True)


def _default_shape(model: str) -> str:
    """Rung for an endpoint with nothing learned yet: a template documented
    (or probed) strict starts at tail_user, everything else gets the
    optimistic tail_system."""
    name = str(model or "").lower()
    if any(pat in name for pat in _STRICT_SYSTEM_FIRST_MODEL_PATTERNS):
        return "tail_user"
    return "tail_system"


def _rungs_from(shape: str) -> list[str]:
    """The ladder starting at `shape` (an already-chosen rung is not retried
    against itself)."""
    try:
        start = PROVIDER_SHAPES.index(shape)
    except ValueError:
        start = 0
    return list(PROVIDER_SHAPES[start:])


def _volatile_tail(messages: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split (stable body, volatile tail blocks).

    A system message appearing AFTER the first non-system message is a
    trailing-seam block (`_prepare_messages` appends anchor / references /
    skill body / ledger / observation there); a leading run of system
    messages is the stable head and is never tail material.
    """
    first_non_system = next(
        (i for i, m in enumerate(messages) if m.get("role") != "system"), None)
    if first_non_system is None:
        return list(messages), []
    body = [m for i, m in enumerate(messages) if i < first_non_system
            or m.get("role") != "system"]
    tail = [m for i, m in enumerate(messages)
            if i >= first_non_system and m.get("role") == "system"]
    return body, tail


def _reshape_for_template_fallback(payload: dict, shape: str) -> dict:
    """Re-place the volatile tail of an already-built OpenAI-format payload.

    Identity-preserving: returns the SAME object when nothing moves, so a
    caller can tell 'no-op' from 'reshaped' without diffing.

    Placement law (why these are in-place, not "move to the end"): the route
    loop appends per-reprompt directives (ack-guard, edit nudge, steer) AFTER
    the prepared seam, and that directive is the thing the model must act on
    now — it stays the last message on the wire. Reordering the seam behind it
    buried the directive under ~1.5K chars of ledger (caught by
    tests/test_ai_progress_ack_guard.py).

    tail_system : identity — `_build_provider_payload` already built this shape.
    tail_user   : collapse the system run that sits after the transcript into
                  ONE labeled user message, IN PLACE.
    merged      : hoist every system block into messages[0] (the pre-C2 wire).
    """
    messages = payload.get("messages")
    if not isinstance(messages, list) or "system" in payload:
        # Anthropic-shaped (top-level system field) — no tail concept there.
        return payload
    _body, tail = _volatile_tail(messages)
    if not tail:
        return payload
    if shape == "tail_system":
        return payload
    if shape == "tail_user":
        first_tail_index = next(
            idx for idx, m in enumerate(messages)
            if idx and m.get("role") == "system")
        joined = "\n\n".join(str(m.get("content", "")) for m in tail)
        # One labeled user block at the seam's ORIGINAL position; anything the
        # loop appended after the seam keeps its place behind it.
        rebuilt = []
        inserted = False
        for idx, msg in enumerate(messages):
            is_tail = idx >= first_tail_index and msg.get("role") == "system"
            if is_tail:
                if not inserted:
                    rebuilt.append({"role": "user",
                                    "content": f"{VOLATILE_TAIL_LABEL}\n\n{joined}"})
                    inserted = True
            else:
                rebuilt.append(msg)
    elif shape == "merged":
        head_blocks = [m for m in messages if m.get("role") == "system"]
        parts = [str(m.get("content", "")) for m in head_blocks]
        merged_head = {"role": "system", "content": "\n\n".join(parts)}
        rebuilt = [merged_head] + [m for m in messages
                                   if m.get("role") != "system"]
    else:
        return payload
    if rebuilt == messages:
        return payload
    return {**payload, "messages": rebuilt}


# Deliberately narrow: a signature that says the MESSAGE SHAPE was rejected.
# Anything else (auth, quota, capacity, model bugs) must surface to the user
# untouched — reshaping around a 401 would hide a real failure behind retries.
_TEMPLATE_REJECTION_PATTERNS = (
    "system message must be at the beginning",
    "system role must be the first",
    "must be the first message",
    "unexpected role",
    "raise_exception",
    "jinja exception",
    "template error",
    "unsupported role",
    "invalid role",
)


def _looks_like_template_rejection(status: int, body: str) -> bool:
    if status not in (400, 500):
        return False
    text = str(body or "").lower()
    if not text:
        return False
    return any(pat in text for pat in _TEMPLATE_REJECTION_PATTERNS)



def _build_provider_payload(
    provider: str,
    messages: list[dict],
    model: str,
    max_tokens: int = 4096,
    temperature: float | None = None,
    tools: list[dict] | None = None,
    merge_system: bool = True,
) -> dict:
    """Build the request payload for the given provider.

    Handles Anthropic's separate system field and OpenAI-compatible
    formats with temperature settings. When tools is provided, native
    function-calling tool definitions are included.

    merge_system: when True (DEFAULT), collapse every system message into a
    single leading system message. OpenAI-compatible servers that use strict
    chat templates (e.g. ones that enforce "system message must be at the
    beginning") reject multiple system messages; a single merged message is
    valid everywhere. Pass False explicitly to preserve the trailing task
    anchor as its own message (positionally meaningful for permissive
    templates) — kept for A/B testing.
    """
    if provider == "anthropic":
        # Anthropic takes a single top-level system field. Merge every system
        # message (main prompt, config context, and the trailing task anchor)
        # instead of keeping only the last one.
        system_parts: list[str] = []
        filtered_messages: list[dict] = []
        for msg in messages:
            if msg["role"] == "system":
                system_parts.append(str(msg["content"]))
            else:
                filtered_messages.append(msg)
        payload: dict = {
            "model": model,
            "messages": filtered_messages,
            "max_tokens": max_tokens,
        }
        if temperature is not None:
            payload["temperature"] = temperature
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)

        if tools:
            # Anthropic expects a flat tool list (no "type" wrapper): each
            # entry carries name/description/input_schema directly.
            payload["tools"] = [
                {
                    "name": tool["function"]["name"],
                    "description": tool["function"].get("description", ""),
                    "input_schema": tool["function"].get("parameters", {"type": "object", "properties": {}}),
                }
                for tool in tools
            ]
    else:
        # OpenAI-compatible chat providers use the standard messages format.
        # Low temperature makes tool call decisions more deterministic;
        # 0.1 is the historical default, overridable per request.
        if merge_system:
            # Some strict chat templates (e.g. models that enforce "system
            # message must be at the beginning") reject any system message
            # that isn't first. Merge every system message (main prompt,
            # config context, and the trailing task anchor) into a single
            # leading system message — valid everywhere, and preserves the
            # anchor's content alongside the main prompt.
            system_parts = []
            filtered_messages = []
            for msg in messages:
                if msg["role"] == "system":
                    system_parts.append(str(msg["content"]))
                else:
                    filtered_messages.append(msg)
            if system_parts:
                filtered_messages.insert(0, {"role": "system", "content": "\n\n".join(system_parts)})
        else:
            # C2 rung 1 (`tail_system`): merge ONLY the leading system run and
            # leave the rest of the list exactly where the caller put it.
            # Multi-leading-system is its own strict-template failure class,
            # and the leading blocks are stable across turns, so folding them
            # costs nothing. Reordering is NOT part of shaping: the route loop
            # appends re-prompt directives after the prepared seam, and sliding
            # the seam behind them buries the instruction the model must act on
            # (pinned by tests/test_ai_progress_ack_guard.py).
            leading = 0
            while leading < len(messages) and messages[leading].get("role") == "system":
                leading += 1
            head = ([{"role": "system",
                      "content": "\n\n".join(str(m.get("content", ""))
                                             for m in messages[:leading])}]
                    if leading else [])
            filtered_messages = head + list(messages[leading:])
        payload = {
            "model": model,
            "messages": filtered_messages,
            "temperature": temperature if temperature is not None else 0.1,
            "max_tokens": max_tokens,
        }
        if tools:
            payload["tools"] = tools

    return payload


def _response_error_text(resp) -> str:
    """Best-effort provider error text, for the rejection-signature check."""
    data = None
    try:
        data = resp.json()
    except Exception:
        data = None
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or err)
        if isinstance(err, str):
            return err
        for field in ("message", "detail"):
            if data.get(field):
                return str(data[field])
    return str(getattr(resp, "text", "") or "")


def _shape_for_send(url: str, payload: dict) -> str:
    """Which wire shape this request goes out in: the shape learned for THIS
    (url, model), else the documented-strict hint, else optimistic
    tail_system. (A UI-level override is deliberately not wired up yet — one
    resolution path, added only if a real endpoint needs pinning.)
    """
    model = str(payload.get("model", "") or "")
    return _learned_shape(url, model) or _default_shape(model)


async def _query_provider(
    client: httpx.AsyncClient,
    url: str,
    headers: dict,
    payload: dict,
    provider: str,
    logger_context: str | None = None,
    stop_event: asyncio.Event | None = None,
) -> tuple[str, dict]:
    """Send a request to the AI provider and extract the response content.

    Returns:
        (content, data) where content is the extracted text and data is
        the full JSON response for further inspection.

    Raises:
        ChatStoppedError: If the user requested a stop via stop_event.
        ValueError: If the API returned an error in the response body.
        httpx.TimeoutException: On request timeout.
        httpx.HTTPError: On HTTP-level errors.
    """
    if stop_event is not None and stop_event.is_set():
        raise ChatStoppedError()

    context = logger_context or "main"
    logger.info(
        "Querying provider | url=%s msgs=%d chars=%d context=%s",
        url,
        len(payload.get("messages", [])),
        sum(len(str(m.get("content", ""))) for m in payload.get("messages", [])),
        context,
    )

    async def _post_once(body: dict):
        if stop_event is not None:
            # Race the provider request against the stop event so a user stop
            # cancels the in-flight request instead of waiting for it to
            # finish.
            query_task = asyncio.create_task(
                client.post(url, headers=headers, json=body))
            stop_task = asyncio.create_task(stop_event.wait())
            done, _pending = await asyncio.wait(
                {query_task, stop_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if stop_task in done:
                query_task.cancel()
                stop_task.cancel()
                raise ChatStoppedError()
            stop_task.cancel()
            return await query_task
        return await client.post(url, headers=headers, json=body)

    # ── C2 shape ladder: a template rejection downgrades the wire shape and
    # retries inside THIS request (never surfaced as a user-visible failure);
    # every other failure propagates on the first try.
    model_id = str(payload.get("model", "") or "")
    rungs = _rungs_from(_shape_for_send(url, payload))
    send_payload = _reshape_for_template_fallback(payload, rungs[0])
    resp = None
    downgraded = False
    for rung_index, shape in enumerate(rungs):
        resp = await _post_once(send_payload)
        if getattr(resp, "status_code", 200) < 400:
            if _learned_shape(url, model_id) != shape:
                _remember_shape(url, model_id, shape, persist=downgraded)
            break
        body_text = _response_error_text(resp)
        remaining = rungs[rung_index + 1:]
        if not (remaining and _looks_like_template_rejection(
                resp.status_code, body_text)):
            resp.raise_for_status()
            raise ValueError(body_text
                             or f"Provider returned HTTP {resp.status_code}")
        candidate = _reshape_for_template_fallback(payload, remaining[0])
        if candidate is send_payload:
            # No tail left to move: the rejection is not ours to repair.
            resp.raise_for_status()
            raise ValueError(body_text
                             or f"Provider returned HTTP {resp.status_code}")
        logger.warning(
            "Provider rejected the wire shape | shape=%s -> %s | %s | context=%s",
            shape, remaining[0], body_text[:200], context,
        )
        send_payload = candidate
        downgraded = True

    assert resp is not None  # _rungs_from never returns an empty ladder
    data = resp.json()

    error_message = _extract_api_error_message(data)
    if error_message:
        logger.error("Provider returned error | %s context=%s", error_message, context)
        raise ValueError(error_message)

    content = _extract_provider_content(provider, data) or ""

    # C3: one grep-able cache line per provider request (probe harness +
    # post-hoc forensics). Only when the provider reported the field.
    _usage_raw = data.get("usage") if isinstance(data, dict) else None
    _pdetails = (_usage_raw or {}).get("prompt_tokens_details")
    _cached = _pdetails.get("cached_tokens") if isinstance(_pdetails, dict) else None
    if isinstance(_cached, int):
        logger.info(
            "Provider cache | prompt=%s cached=%s context=%s",
            (_usage_raw or {}).get("prompt_tokens"), _cached, context,
        )

    logger.info(
        "Provider response | chars=%d context=%s preview=%s",
        len(content), context, repr(content[:120]),
    )

    if not content:
        # Empty text content is fine when the response carries native tool
        # calls (OpenAI tool_calls / Anthropic tool_use blocks).
        if _extract_native_tool_calls(provider, data):
            logger.info("Empty text, native tool calls present | context=%s", context)
            return "", data

        logger.warning(
            "Empty content | keys=%s finish_reason=%s context=%s",
            list(data.keys()) if isinstance(data, dict) else "N/A",
            data.get("choices", [{}])[0].get("finish_reason", "N/A") if isinstance(data, dict) else "N/A",
            context,
        )
        # Don't raise: a transient empty completion from a local server
        # (llama.cpp) is recoverable, and the caller's empty-response backstop
        # re-prompts without tools before surfacing a graceful fallback. The
        # warning above still records every empty for diagnostics.
        return "", data

    return content, data


def _extract_api_error_message(data: dict) -> str | None:
    error = data.get("error")
    if error is None:
        return None
    if isinstance(error, dict):
        message = error.get("message") or error.get("error")
        return str(message or error)
    return str(error)


def _extract_provider_content(provider: str, data: dict) -> str:
    if provider == "anthropic":
        return data.get("content", [{}])[0].get("text", "")
    return data.get("choices", [{}])[0].get("message", {}).get("content", "")


def _extract_usage_info(data: dict) -> dict | None:
    """Extract token usage + finish_reason from a provider response.

    Used to surface per-turn budget consumption in /ai/chat responses so the
    accuracy harness can tell a truncated answer (finish_reason=length) from
    a genuinely wrong one. Thinking models report reasoning tokens under
    usage.completion_tokens_details.reasoning_tokens — those count against the
    same max_tokens budget as visible content.
    """
    if not isinstance(data, dict):
        return None
    usage = data.get("usage")
    if not isinstance(usage, dict):
        return None
    choice = (data.get("choices") or [{}])[0]
    completion_tokens = usage.get("completion_tokens")
    if not isinstance(completion_tokens, int):
        return None
    prompt_tokens = usage.get("prompt_tokens")
    if not isinstance(prompt_tokens, int):
        # Providers that omit it: W7 stays silent rather than guessing.
        prompt_tokens = None
    details = usage.get("completion_tokens_details")
    reasoning_tokens = None
    if isinstance(details, dict):
        rt = details.get("reasoning_tokens")
        if isinstance(rt, int):
            reasoning_tokens = rt
    # C3 prefix-cache telemetry: the cached share of the prompt. llama.cpp
    # and OpenAI report usage.prompt_tokens_details.cached_tokens;
    # Anthropic reports usage.cache_read_input_tokens. One field either
    # way — silent (None) when neither is present, never guessed (same law
    # as promptTokens above).
    cached_tokens = None
    pdetails = usage.get("prompt_tokens_details")
    if isinstance(pdetails, dict):
        ct = pdetails.get("cached_tokens")
        if isinstance(ct, int) and not isinstance(ct, bool):
            cached_tokens = ct
    if cached_tokens is None:
        crt = usage.get("cache_read_input_tokens")
        if isinstance(crt, int) and not isinstance(crt, bool):
            cached_tokens = crt
    return {
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "reasoningTokens": reasoning_tokens,
        "cachedTokens": cached_tokens,
        "finishReason": choice.get("finish_reason") or "",
    }


def _build_api_base_url(api_url: str) -> str:
    parsed = urlparse(api_url)
    if not parsed.scheme or not parsed.netloc:
        return api_url.rstrip("/")
    return urlunparse((parsed.scheme, parsed.netloc, "", "", "", "")).rstrip("/")


def _models_url_from_chat_url(api_url: str) -> str:
    """Derive the provider's model-list URL from its chat-completions URL.

    Every provider we proxy exposes model listing at the same base as chat,
    with the trailing chat path swapped for /models:

      https://api.openai.com/v1/chat/completions
          -> https://api.openai.com/v1/models
      https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
          -> https://generativelanguage.googleapis.com/v1beta/openai/models
      https://models.github.ai/inference/chat/completions
          -> https://models.github.ai/inference/models
      https://api.anthropic.com/v1/messages
          -> https://api.anthropic.com/v1/models
      http://localhost:11434/v1/chat/completions
          -> http://localhost:11434/v1/models
    """
    parsed = urlparse(api_url)
    if not parsed.scheme or not parsed.netloc:
        return ""
    path = parsed.path
    for suffix in ("/chat/completions", "/completions", "/messages"):
        if path.endswith(suffix):
            path = path[: -len(suffix)]
            break
    models_path = f"{path.rstrip('/')}/models"
    return urlunparse((parsed.scheme, parsed.netloc, models_path, "", "", ""))


def _provider_auth_headers(provider: str, api_url: str, api_key: str) -> dict:
    """Build auth headers for the configured provider.

    Anthropic uses x-api-key; local OpenAI-compatible servers make auth
    optional (include a Bearer token only when a key was provided);
    everything else uses a Bearer token.
    """
    if provider == "anthropic":
        return {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
    if _is_local_provider(provider, api_url):
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


@router.post("/ai/models")
async def list_models(req: ModelsRequest):
    """Proxy the provider's model-list endpoint (server-side).

    The browser can't reliably call cloud /v1/models endpoints directly
    (CORS) and must not put the API key in a query string. This route
    derives the model URL from the chat URL and fetches it with the same
    auth the chat proxy uses, returning just the model ids.
    """
    provider = req.apiProvider.value if hasattr(req.apiProvider, "value") else req.apiProvider
    models_url = _models_url_from_chat_url(req.apiUrl)
    if not models_url:
        return {"models": []}

    headers = _provider_auth_headers(provider, req.apiUrl, req.apiKey)
    timeout = httpx.Timeout(connect=15.0, read=30.0, write=30.0, pool=30.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.get(models_url, headers=headers)
            res.raise_for_status()
            data = res.json()
    except httpx.TimeoutException:
        logger.warning("Model list timeout | url=%s", models_url)
        return {"models": [], "error": "Timed out listing models"}
    except httpx.HTTPError as e:
        logger.warning("Model list failed | url=%s error=%s", models_url, e)
        return {"models": [], "error": f"Failed to list models: {e}"}

    ids: list[str] = []
    if isinstance(data, dict):
        entries = data.get("data")
        if isinstance(entries, list):
            for m in entries:
                if isinstance(m, dict) and isinstance(m.get("id"), str):
                    ids.append(m["id"])
    logger.info("Model list | provider=%s url=%s count=%d", provider, models_url, len(ids))
    return {"models": ids}


def _positive_int(value: object) -> int | None:
    """True int > 0 or None — bools and floats are not context windows."""
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return None


def _window_from_preset_args(entry: dict) -> int | None:
    """llama.cpp multi-model router: the preset args carry the server budget.

    An UNLOADED router entry has no props/loaded_context_window, but its
    ``status.args`` still hold the authoritative ``--ctx-size`` the server
    will boot the model with — that is the real budget, unlike the model
    card's advertised window (research 2026-11-12).
    """
    status = entry.get("status")
    if not isinstance(status, dict):
        return None
    args = status.get("args")
    if not isinstance(args, list):
        return None
    for i, arg in enumerate(args):
        if not isinstance(arg, str):
            continue
        if arg == "--ctx-size" and i + 1 < len(args):
            window = _positive_int(args[i + 1] if isinstance(args[i + 1], int) else _parse_int_str(args[i + 1]))
            if window:
                return window
        elif arg.startswith("--ctx-size="):
            window = _positive_int(_parse_int_str(arg.split("=", 1)[1]))
            if window:
                return window
    return None


def _parse_int_str(value: str) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _resolve_context_window(entry: dict, model: str) -> tuple[int | None, str | None]:
    """Resolve one /v1/models entry's REAL context window for `model`.

    Resolution order (llama.cpp n_ctx first — it is the budget that actually
    truncates; cloud cards only when there is no local truth to disagree
    with): ``props.n_ctx`` → ``loaded_context_window`` → preset ``--ctx-size``
    args → ``max_input_tokens``. Model match is exact on ``id`` or via the
    router's ``aliases``. Returns (None, None) rather than a guess.
    """
    if not isinstance(entry, dict):
        return (None, None)
    entry_id = entry.get("id")
    aliases = entry.get("aliases")
    matched = entry_id == model or (
        isinstance(aliases, list) and model in aliases
    )
    if not matched:
        return (None, None)
    props = entry.get("props")
    if isinstance(props, dict):
        window = _positive_int(props.get("n_ctx"))
        if window:
            return (window, "props.n_ctx")
    window = _positive_int(entry.get("loaded_context_window"))
    if window:
        return (window, "loaded_context_window")
    window = _window_from_preset_args(entry)
    if window:
        return (window, "preset_args")
    window = _positive_int(entry.get("max_input_tokens"))
    if window:
        return (window, "max_input_tokens")
    return (None, None)


@router.post("/ai/context-window")
async def context_window(req: ContextWindowRequest):
    """W7: the REAL context window for one model, server-side.

    The browser can't reach the provider (CORS + key), and the router's
    n_ctx — not the model card — is the budget that truncates. Best-effort:
    unknown model, unreachable provider, or an entry without any window
    field all answer ``contextWindow: null`` and the client stays silent.
    """
    provider = req.apiProvider.value if hasattr(req.apiProvider, "value") else req.apiProvider
    models_url = _models_url_from_chat_url(req.apiUrl)
    if not models_url:
        return {"contextWindow": None, "source": None}

    headers = _provider_auth_headers(provider, req.apiUrl, req.apiKey)
    timeout = httpx.Timeout(connect=15.0, read=30.0, write=30.0, pool=30.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.get(models_url, headers=headers)
            res.raise_for_status()
            data = res.json()
    except httpx.TimeoutException:
        logger.warning("Context window timeout | url=%s", models_url)
        return {"contextWindow": None, "source": None, "error": "Timed out probing the context window"}
    except httpx.HTTPError as e:
        logger.warning("Context window probe failed | url=%s error=%s", models_url, e)
        return {"contextWindow": None, "source": None, "error": f"Failed to probe the context window: {e}"}
    except ValueError:
        # PR #43 B-03: a 200 whose body is not JSON (a mis-pointed apiUrl
        # hitting a proxy/landing page) must degrade like every other
        # unknown — this route's own docstring promises graceful null,
        # and res.json() raises json.JSONDecodeError, which is NOT an
        # httpx.HTTPError, so it used to escape as an HTTP 500.
        logger.warning("Context window probe got non-JSON body | url=%s", models_url)
        return {"contextWindow": None, "source": None, "error": "Provider returned a non-JSON models listing"}

    entries = data.get("data") if isinstance(data, dict) else None
    if isinstance(entries, list):
        for entry in entries:
            window, source = _resolve_context_window(entry, req.model)
            if window:
                logger.info(
                    "Context window | provider=%s model=%s window=%d source=%s",
                    provider, req.model, window, source,
                )
                return {"contextWindow": window, "source": source}
    return {"contextWindow": None, "source": None}


# Mirror-seed caps (Pi 3B+ memory): per-file and total content limits so a
# misconfigured scan root can never load gigabytes into an edit session.
_MIRROR_MAX_FILE_BYTES = 512 * 1024
_MIRROR_MAX_TOTAL_BYTES = 4 * 1024 * 1024


def _mirror_user_config_files() -> dict[str, dict]:
    """Read the backend's user-config mirror as a contextFiles-shaped dict.

    Same source and precedence as the read_user_config/list_user_configs
    MCP tools (system config path first, then the imported local dir;
    first occurrence of a relative path wins; SAVE_CONFIG backups
    skipped). Used to ARM the edit session when a client requests
    editTools but sends no contextFiles (TRIDENT-16: an un-armed session
    has no write tools, so the model correctly falls back to prose and
    the whole tool path silently disappears). The mirror is the disk
    truth; approval still re-validates against the client's latest
    contextFiles, so a stale mirror can never clobber unsaved edits.
    """
    from mcp_server import LOCAL_CONFIGS_DIR, _system_config_path
    from services.native_services import is_backup_config_file

    files: dict[str, str] = {}
    total = 0
    scan_paths: list[Path] = []
    system_path = _system_config_path()
    if system_path.is_dir():
        scan_paths.append(system_path)
    if LOCAL_CONFIGS_DIR.is_dir():
        scan_paths.append(LOCAL_CONFIGS_DIR)
    for scan_dir in scan_paths:
        try:
            for cfg_file in sorted(scan_dir.rglob("*.cfg")):
                if is_backup_config_file(cfg_file.name):
                    continue
                try:
                    rel = cfg_file.relative_to(scan_dir).as_posix()
                except ValueError:
                    continue
                if rel in files:
                    continue
                try:
                    size = cfg_file.stat().st_size
                    if size > _MIRROR_MAX_FILE_BYTES or total + size > _MIRROR_MAX_TOTAL_BYTES:
                        continue
                    content = cfg_file.read_bytes().decode("utf-8", errors="replace")
                except OSError:
                    # Final-pass review 2026-09-29: best-effort stays
                    # best-effort (never raise from the arm path), but a
                    # silently skipped file meant a partially-armed edit
                    # session ('File X is not in the project') with
                    # nothing in the log to explain it.
                    logger.warning("Mirror skip | unreadable cfg %s", cfg_file,
                                   exc_info=True)
                    continue
                files[rel] = {"content": content}
                total += size
        except OSError:
            logger.warning("Mirror skip | scan dir %s unreadable", scan_dir,
                           exc_info=True)
            continue
    return files




async def _client_disconnected(request: Request) -> bool:
    """True when the HTTP client has gone away mid-request.

    The tool loop is expensive (a slow provider can spend minutes per
    turn) and nothing else cancels it: without this check an abandoned
    request keeps looping up to ``turn_cap`` (50 on the edit arm),
    holding the single-slot local router for hours after the harness or
    the browser gave up (observed: SIMTOOL-02 r5/r5b, 2026-11-14).
    Detection must never be the thing that kills a request — any error
    from the transport layer means 'keep going'.
    """
    try:
        return bool(await request.is_disconnected())
    except Exception:  # noqa: BLE001 — detection is advisory only
        return False


@router.post("/ai/chat")
async def chat_proxy(req: ChatRequest, request: Request):
    """Proxy chat messages to the user's configured API provider."""
    # ── Tool-mediated config editing session ──
    # Request-scoped: seeded from the user-config mirror as a FLOOR with
    # this request's contextFiles layered on top per-file (drafts win),
    # stacked edits returned as pendingEdits. No per-conversation draft
    # store by design. Without any files there is nothing to edit — tools
    # stay unadvertised. Product behavior since the Phase-6 flag removal
    # (2026-09-24): only an explicit editTools=False (harness read-only
    # arm) disables the session.
    #
    # Floor, not fallback (live report 2026-10-10): since the frontend
    # retired the context-file picker (2026-10-03), contextFiles carries
    # ONLY the unsaved drafts. Seeding from it exclusively meant that the
    # moment ANY file went dirty — a manual edit, or an AI-created file the
    # user approved (approved ≠ saved) — the session shrank to just the
    # draft files, and every config_edit on printer.cfg kicked back
    # "File 'printer.cfg' is not in the project. Known files:
    # mainsail.cfg." while read_user_config read the same file off disk two
    # turns earlier (ai_chat.log 22:06 trace, chat-1791695178806). Same
    # floor shape as list_hardware below; the mirror never overrides a
    # draft, so unsaved edits still win and approval re-validation still
    # checks against the client's latest text.
    edit_enabled = req.editTools is not False
    edit_session: EditSession | None = None
    if edit_enabled:
        seed: dict[str, dict] = {}
        try:
            seed.update(_mirror_user_config_files())
        except Exception:
            # TRIDENT-16: a raising/empty mirror must not 500 the chat nor
            # silently drop the drafts — arm from contextFiles alone.
            logger.warning("Mirror seed failed | arming from contextFiles only",
                           exc_info=True)
        for name, meta in (req.contextFiles or {}).items():
            seed[name] = meta
        if seed:
            try:
                edit_session = EditSession(seed)
                if not edit_session.has_files():
                    edit_session = None
            except Exception:
                logger.exception("Edit session seed failed | edit tools disabled for request")
                edit_session = None
    edit_capable = edit_session is not None

    # ── Model-triggered edit skill gate ──
    # Write tools start HIDDEN whenever a session exists; they unlock when
    # the model calls load_skill itself (mechanical evidence in message
    # history — never a verb heuristic). Same-turn unlock: every provider
    # payload below re-resolves tools from _skill_state, which flips as
    # soon as the load_skill result lands. Product behavior since the
    # Phase-6 flag removal (2026-09-24); the harness can force the
    # unlocked arm per request via editSkill=True.
    _skill_state = {'active': (
        EDIT_SKILL_NAME in req.loadedSkills or _load_skill_active(req.messages)
    )}
    # W0 sticky activation: loadedSkills is derived by the client from
    # this conversation's stored tool trace — the lean replay strips native
    # tool_calls, so the scan above alone re-closes the gate on every
    # follow-up turn. The flag only changes the STARTING state of a request;
    # the mid-loop load_skill handler and _skill_gate_closed stay untouched.
    # Harness A/B: --force-skill-active forces activation evidence WITHOUT
    # requiring a live load_skill call (grades tool-call traces directly).
    if edit_capable and getattr(req, 'editSkill', None) is True:
        _skill_state['active'] = True
    # W4-R2: which knowledge skills are loaded for this conversation?
    # Client flag OR mechanical trail evidence (text protocol writes its
    # tool-result marker into content). The seam re-injects the STICKY
    # ones only (registry law). Knowledge loads NEVER touch _skill_state —
    # the write gate belongs to config-editing alone.
    _loaded_knowledge_skills = [
        name for name in _SKILL_REGISTRY
        if not _SKILL_REGISTRY[name]["gates_write"]
        and (name in req.loadedSkills
             or _skill_load_in_trail(req.messages, name))
    ]

    def _skill_gate_closed() -> bool:
        """True while the session's write tools stay locked behind
        load_skill (only meaningful when a session exists)."""
        return not _skill_state['active']

    messages = _prepare_messages(req.messages,
                                 edit_capable=edit_capable,
                                 skill_active=_skill_state['active'],
                                 context_files=req.contextFiles,
                                 context_references=req.context_references,
                                 # Invariant A (atomic armament): the body
                                 # re-injects exactly when this request
                                 # starts armed with the write surface —
                                 # active skill state AND a session.
                                 inject_edit_skill_body=(
                                     edit_capable and _skill_state['active']),
                                 # W4-R2: sticky knowledge bodies re-ride the
                                 # trailing seam while their skill is loaded.
                                 loaded_skills=_loaded_knowledge_skills,
                                 # W6: re-deliver the client's action record
                                 # verbatim (never interpreted here).
                                 work_ledger=req.workLedger,
                                 work_ledger_current_turn=req.workLedgerCurrentTurn,
                                 native_mode=_resolve_native_tools(
                                     req.apiProvider, req.apiUrl, req.toolProtocol,
                                     edit_capable=edit_capable,
                                     skill_active=_skill_state['active']) is not None)

    # ── Log request summary ──
    msg_count = len(messages)
    system_msgs = [m for m in messages if m.get("role") == "system"]
    non_system_msgs = [m for m in messages if m.get("role") != "system"]
    total_chars = sum(len(str(m.get("content", ""))) for m in messages)
    system_chars = sum(len(str(m.get("content", ""))) for m in system_msgs)
    query_chars = sum(len(str(m.get("content", ""))) for m in non_system_msgs)
    logger.info(
        "Chat request | provider=%s model=%s msgs=%d (sys=%d user=%d) chars=%d (system=%d query=%d) requestId=%s",
        req.apiProvider.value if hasattr(req.apiProvider, 'value') else req.apiProvider,
        req.model, msg_count, len(system_msgs), len(non_system_msgs),
        total_chars, system_chars, query_chars,
        req.requestId or "none",
    )

    # Local providers don't require an API key
    if not _is_local_provider(req.apiProvider, req.apiUrl) and not req.apiKey:
        return {"error": "AI settings not configured. Please configure your API key in settings."}

    # ── W8 pre-flight overflow refusal ──
    # `messages` here is the FULLY-assembled prompt (system prompt, printer
    # memory, transcript, references, skill body) — the only place the true
    # size is known. Refuse an obviously-over request before the provider
    # round-trip: llama.cpp may hang rather than error (no response timeout
    # anywhere in this path by design), and even a clean 400 is a wasted
    # slot on a single-parallelism local router. The window comes from the
    # client's W7 probe; unknown = silent pass-through, provider decides.
    # PR #43 review F9: the native tools payload occupies the SAME window
    # (resolved first, handed to the pre-flight) — counting only the
    # messages understated an edit-armed request by ~8k tokens.
    # Tool protocol: native function calling is the DEFAULT for every
    # provider (see _resolve_native_tools). toolProtocol="text" forces the
    # ```tool fallback; the loop still regex-extracts text calls when a
    # native server ignores the tools array, so degradation is graceful.
    native_tools = _resolve_native_tools(req.apiProvider, req.apiUrl, req.toolProtocol,
                                         edit_capable=edit_capable,
                                         skill_active=_skill_state['active'])
    overflow = preflight_overflow(messages, req.knownContextWindow,
                                  tools=native_tools)
    if overflow is not None:
        logger.warning(
            "Pre-flight overflow refusal | est=%d window=%d requestId=%s",
            overflow["estimatedPromptTokens"], overflow["contextWindow"],
            req.requestId or "none",
        )
        return overflow

    # Build headers based on provider (shared with the /ai/models proxy).
    headers = _provider_auth_headers(
        req.apiProvider.value if hasattr(req.apiProvider, "value") else req.apiProvider,
        req.apiUrl,
        req.apiKey,
    )

    # native_tools was resolved before the pre-flight above (F9) and is
    # reused by the request build and the tool loop.

    # ── Stop-event registration ──
    stop_event = None
    if req.requestId:
        stop_event = asyncio.Event()
        _chat_stop_events[req.requestId] = stop_event
        # The change set is reachable by request id from the first moment:
        # keep/undo happens DURING the loop as often as after it.
        register_edit_session(req.requestId, edit_session)
        # Progress registry (Phase 6.5.1/6.5.3): same lifecycle as the stop
        # event. startedAt drives elapsedMs; turns accumulate the per-turn
        # narration for harness grading (narrationTurns in the final
        # response); lastText dedupes identical consecutive emits.
        _chat_progress[req.requestId] = {
            "turn": 0,
            "narration": "",
            "toolNames": [],
            "startedAt": time.monotonic(),
            "lastText": None,
            "turns": [],
        }
        logger.info(
            "Stop event registered | requestId=%s registry_size=%d",
            req.requestId, len(_chat_stop_events),
        )

    timeout = httpx.Timeout(connect=15.0, read=None, write=120.0, pool=120.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            payload = _build_provider_payload(
                req.apiProvider, messages, req.model,
                max_tokens=req.maxTokens,
                temperature=req.temperature,
                tools=native_tools,
                merge_system=req.mergeSystemMessages,
            )

            current_content, current_data = await _query_provider(
                client, req.apiUrl, headers, payload, req.apiProvider,
                logger_context="initial",
                stop_event=stop_event,
            )
            usage_events: list[dict] = []
            initial_usage = _extract_usage_info(current_data)
            if initial_usage:
                initial_usage["context"] = "initial"
                usage_events.append(initial_usage)

            tool_turns = 0
            # Credit tracker for the work-earned cap extension (below):
            # write calls already paid into turn_cap.
            credited_write_calls = 0
            current_messages = list(messages)
            executed_tool_names: list[str] = []
            executed_tool_calls: list[dict] = []
            # Literal (name, args) keys of every guarded READ executed this
            # request — see REPEAT_GUARD_TOOLS. Reset per request by
            # construction (local to chat_proxy).
            read_ledger: set[str] = set()
            # Re-prompts issued to correct a malformed ```tool fence (see the
            # malformed tool-call guard in the loop below).
            malformed_reprompts = 0
            # Pre-edit verdict guard re-prompts (cap 1 — ack-guard style):
            # simulate-then-silently-fix amnesia, see _pre_write_verdict_miss.
            verdict_reprompts = 0
            # Mid-loop steers actually injected (2026-10-02) — the count
            # keys the provider log context and the response payload.
            steers_applied = 0

            # Edit-prose nudge budget (the nudge itself lives in the tool
            # loop's no-tool-calls branch — it must cover prose answers at
            # ANY turn: r6b found qwen3.5-9b calling read_user_config
            # legitimately, THEN answering with a ```cfg draft, which the
            # old pre-loop-only nudge missed).
            edit_nudges = 0

            # Ack-guard budget (Phase 6.5.2): a continue-intent promise
            # ("I'll now apply that…") with no tool call on an edit request
            # gets ONE injected execution directive. Cap 1 (Hermes caps at
            # 2): local-model ack loops make every extra re-prompt real
            # llama.cpp latency. Bookkeeping shaped like empty_reprompts;
            # surfaced as usage.ackReprompts.
            ack_reprompts = 0

            def _emit_progress(tool_names: list[str], narration: str) -> None:
                """Publish mid-loop progress for the poller (Phase 6.5.1).

                Call site law: AFTER tool-call extraction succeeds, BEFORE
                execution — only canonical loop state is published, and the
                narration is the turn's visible assistant text with the
                tool-call markup stripped (native: `content` beside
                tool_calls; text protocol: prose beside the call syntax).
                Hermes invariants: per-turn dedupe (identical consecutive
                text never re-emits), and progress NEVER touches
                final_content — a display bubble must not consume or
                replace the answer (#65919 class)."""
                if not req.requestId:
                    return
                entry = _chat_progress.get(req.requestId)
                if entry is None:
                    return
                entry["turn"] = tool_turns + 1
                entry["toolNames"] = list(tool_names)
                entry["updatedAt"] = time.monotonic()
                if narration and narration != entry.get("lastText"):
                    entry["lastText"] = narration
                    entry["narration"] = narration
                    entry["turns"].append({
                        "turn": tool_turns + 1,
                        "narration": narration,
                        "toolNames": list(tool_names),
                    })

            turn_cap = (MAX_MCP_TOOL_TURNS_EDIT if edit_capable
                        else MAX_MCP_TOOL_TURNS)
            while True:
                # Work-earned cap credit (2026-10-26): every write CALL
                # that applied at least one op raises the edit arm's cap
                # by cap_grant_per_applied_write(). The flat cap stays
                # fully chargeable to reads/searches/failed writes, so a
                # model that never lands an edit still dies at 50; one
                # that is getting work done extends its own budget. The
                # 500-op runaway ceiling and the thrash budget below are
                # unchanged and cap the extension. CREDIT IS EARNED
                # BEFORE the cap is re-checked: the dogfood run committed
                # a batch on its 50th call — an exhausted write must
                # still buy its extension (a while-condition credit
                # would exit first and drop it).
                if (edit_capable and edit_session is not None
                        and edit_session.applied_write_calls
                        > credited_write_calls):
                    new_credit = (edit_session.applied_write_calls
                                  - credited_write_calls)
                    credited_write_calls = edit_session.applied_write_calls
                    turn_cap += cap_grant_per_applied_write() * new_credit
                    logger.info(
                        "Cap credit granted | applied write calls=%d "
                        "turn_cap=%d requestId=%s",
                        credited_write_calls, turn_cap,
                        req.requestId or 'none')
                if tool_turns >= turn_cap:
                    break
                if stop_event is not None and stop_event.is_set():
                    raise ChatStoppedError()
                # Orphan guard: if the client is gone, further turns are
                # pure waste — stop before another (possibly multi-minute)
                # provider call. See _client_disconnected.
                if await _client_disconnected(request):
                    logger.warning(
                        "Client disconnected mid tool-loop | stopping | "
                        "turns=%d executed_calls=%d requestId=%s",
                        tool_turns, len(executed_tool_calls),
                        req.requestId or 'none')
                    break
                # Invisible runaway ceiling (2026-10-16): an absolute
                # executed-call cap per request. NOT announced to the
                # model and NOT part of the thrash directive — reaching
                # 500 executed calls means the harness itself has a bug,
                # so log loudly and stop with what we have.
                if len(executed_tool_calls) >= MAX_TOOL_OPS_PER_REQUEST:
                    logger.error(
                        "Runaway ceiling hit | %d tool calls executed in "
                        "one request (requestId=%s) — stopping the loop; "
                        "this is a harness bug, not a budget",
                        len(executed_tool_calls), req.requestId or 'none',
                    )
                    break

                # ── Mid-loop steer injection (turn boundary) ──
                # A steer is user speech: it lands as the NEXT USER TURN,
                # never as a tool result and never as a system nudge. The
                # loop is already turn-by-turn, so the boundary is free —
                # nothing is cancelled mid-provider-call. The response the
                # model had already produced belongs to the previous
                # instruction, so it is dropped and the model answers the
                # steer instead.
                _steers = _drain_steers(req.requestId)
                if _steers:
                    for _steer in _steers:
                        current_messages.append(
                            {"role": "user", "content": _steer})
                    if edit_session is not None:
                        # Deterministic ledger resets (see apply_steer):
                        # a steer is a NEW instruction about a target the
                        # model may already have written.
                        edit_session.apply_steer()
                    # The human bought another round: both budgets restart,
                    # or steering would be useless exactly when it is
                    # needed — after the model burned its writes driving
                    # the wrong way.
                    tool_turns = 0
                    # apply_steer() zeroed the session's credit counter;
                    # rebase the cap with it so the tracker and the cap
                    # never drift (the model re-earnes credit with the
                    # steer's new work — "the human bought another
                    # round", not "the human banked the old extension").
                    turn_cap = (MAX_MCP_TOOL_TURNS_EDIT if edit_capable
                                else MAX_MCP_TOOL_TURNS)
                    credited_write_calls = 0
                    steers_applied += len(_steers)
                    _progress_entry = _chat_progress.get(req.requestId)
                    if _progress_entry is not None:
                        _progress_entry.setdefault("steers", []).append(
                            {"turn": steers_applied, "text": _steers[-1]})
                    logger.info(
                        "Steer injected | requestId=%s count=%d turn=%d "
                        "preview=%s",
                        req.requestId, len(_steers), steers_applied,
                        _steers[-1][:120].replace("\n", " "),
                    )
                    _steer_payload = _build_provider_payload(
                        req.apiProvider, current_messages, req.model,
                        max_tokens=req.maxTokens,
                        temperature=req.temperature,
                        tools=native_tools,
                        merge_system=req.mergeSystemMessages,
                    )
                    current_content, current_data = await _query_provider(
                        client, req.apiUrl, headers, _steer_payload,
                        req.apiProvider,
                        logger_context=f"steer-{steers_applied}",
                        stop_event=stop_event,
                    )
                    _steer_usage = _extract_usage_info(current_data)
                    if _steer_usage:
                        _steer_usage["context"] = f"steer-{steers_applied}"
                        usage_events.append(_steer_usage)
                    continue

                # Native function calls come from the structured response body
                # (OpenAI tool_calls / Anthropic tool_use blocks); otherwise
                # fall back to regex extraction from the response text.
                native_calls = _extract_native_tool_calls(req.apiProvider, current_data)
                tool_calls = native_calls or _extract_tool_calls(current_content)
                if not tool_calls:
                    # ── Malformed tool-call guard ──
                    # A ```tool fence that failed to parse (or an unterminated
                    # fence) is unambiguous tool intent — without this, the
                    # loop sees "no tool calls, non-empty text", stops, and
                    # the raw broken markup leaks into the chat bubble. Issue
                    # ONE format-correction re-prompt (never quoting the
                    # broken call — REPAIR-01) instead of terminating.
                    if (
                        malformed_reprompts < MALFORMED_TOOL_REPROMPT_LIMIT
                        and _malformed_tool_call_detected(current_content, tool_calls)
                    ):
                        malformed_reprompts += 1
                        tool_turns += 1
                        # THRASH charge: a format-correction round-trip is
                        # spent work, whatever it produces (2026-10-16).
                        if edit_session is not None:
                            edit_session.charge_waste()
                        logger.warning(
                            "Malformed tool call | re-prompting with format "
                            "correction (%d/%d) preview=%s",
                            malformed_reprompts, MALFORMED_TOOL_REPROMPT_LIMIT,
                            current_content[:120].replace("\n", " "),
                        )
                        current_messages.append({
                            "role": "user",
                            "content": MALFORMED_TOOL_FORMAT_FEEDBACK,
                        })
                        malformed_payload = _build_provider_payload(
                            req.apiProvider, current_messages, req.model,
                            max_tokens=req.maxTokens,
                            temperature=req.temperature,
                            tools=native_tools,
                            merge_system=req.mergeSystemMessages,
                        )
                        current_content, current_data = await _query_provider(
                            client, req.apiUrl, headers, malformed_payload, req.apiProvider,
                            logger_context=f"malformed-reprompt-{malformed_reprompts}",
                            stop_event=stop_event,
                        )
                        malformed_usage = _extract_usage_info(current_data)
                        if malformed_usage:
                            malformed_usage["context"] = f"malformed-reprompt-{malformed_reprompts}"
                            usage_events.append(malformed_usage)
                        continue
                    # ── Edit-prose nudge ──
                    # Edit request + write tools armed + prose answer (no
                    # tool call): prose edits are INERT — old draft-text
                    # semantics must not silently resume. Correction
                    # re-prompt (max 3 — the `edit_nudges < 3` gate below;
                    # log lines count up to edit-nudge-3), same escalation
                    # style as the malformed guard. Pure Q&A never matches
                    # this gate.
                    if (edit_session is not None
                            and _is_edit_request(req.messages)
                            # Nudge ONLY on mechanical evidence of an inert
                            # draft: (a) the write trace ENDED on a
                            # CORRECTABLE kickback (r4 give-up; r5
                            # multi-part give-up hiding behind a staged
                            # first half), or (b) the final answer CONTAINS
                            # a fenced cfg block — the inert-draft shape
                            # (r6: create succeeded, include re-drafted as
                            # prose cfg after the tool-side include
                            # failed). A staged change never proves the
                            # whole intent is covered; a cfg block in prose
                            # always proves inert drafting.
                            # NOT nudged on bare outcome=None: Q20 r3/B
                            # (2026-09-16) proved the verb+target heuristic
                            # misfires on pure Q&A ("which command SAVES
                            # ... into the config file") — the model
                            # ANSWERED correctly and the nudge gaslit it
                            # into "tell me what change you want". Prose
                            # with no draft and no write attempt is treated
                            # as an answer/refusal (r8 refusal-wins
                            # philosophy); user_gated refusals likewise
                            # protected.
                            and (
                                edit_session.last_write_outcome
                                == 'correctable'
                                or (bool(extract_config_code_blocks(
                                        current_content))
                                    # An honest user-gated outcome (decline,
                                    # timeout, stop, duplicate target) often
                                    # still illustrates with a ```cfg block;
                                    # nudging THAT pressure-cooks the model
                                    # into re-attempting an explicit user
                                    # decision. Refusal wins. (The commented-
                                    # param refusals this clause originally
                                    # guarded were removed 2026-09-20.)
                                    # 'budget' (thrash budget spent) is the
                                    # same shield: the loop just told the
                                    # model to rework/report, so a cfg block
                                    # in that final answer is the report,
                                    # not an inert draft to nudge back.
                                    and edit_session.last_write_outcome
                                    not in ('user_gated', 'budget')
                                    # Echo guard (native-mode traces
                                    # 2026-09-17): after an APPROVED write
                                    # models re-quote the staged section in
                                    # a ```cfg block to show it. Structural
                                    # test — a block whose config lines all
                                    # exist in the working state is a
                                    # display echo; only content absent
                                    # from the project is an inert draft.
                                    # (outcome=='correctable' above still
                                    # nudges unconditionally.)
                                    and edit_session.has_inert_draft(
                                        extract_config_code_blocks(
                                            current_content)))
                            )
                            and edit_nudges < 3):
                        edit_nudges += 1
                        logger.info(
                            "Edit prose response nudged | attempt=%d turn=%d content_chars=%d",
                            edit_nudges, tool_turns, len(current_content),
                        )
                        if current_content.strip():
                            clean_prior = MCP_TOOL_BLOCK_RE.sub("", current_content).strip()
                            if clean_prior:
                                current_messages.append(
                                    {"role": "assistant", "content": clean_prior})
                        current_messages.append({
                            "role": "user",
                            # Protocol-aware nudge: the fence format law in
                            # EDIT_NUDGE_TEXT is text-protocol only. Under
                            # native function calling it actively breaks
                            # template-trained models (live native traces
                            # 2026-09-17: gemma-4-12b replied "I cannot use
                            # that specific fence format... my instructions
                            # require me to use the internal tool calling
                            # system"). Native arm keeps the argument
                            # shapes, drops the fence law.
                            "content": (_LOAD_SKILL_NUDGE_TEXT
                                        if _skill_gate_closed()
                                        else EDIT_NUDGE_TEXT_NATIVE
                                        if native_tools is not None
                                        else EDIT_NUDGE_TEXT),
                        })
                        nudge_payload = _build_provider_payload(
                            req.apiProvider, current_messages, req.model,
                            max_tokens=req.maxTokens,
                            temperature=req.temperature,
                            tools=native_tools,
                            merge_system=req.mergeSystemMessages,
                        )
                        current_content, current_data = await _query_provider(
                            client, req.apiUrl, headers, nudge_payload,
                            req.apiProvider,
                            logger_context=f"edit-nudge-{edit_nudges}",
                            stop_event=stop_event,
                        )
                        nudge_usage = _extract_usage_info(current_data)
                        if nudge_usage:
                            nudge_usage["context"] = f"edit-nudge-{edit_nudges}"
                            usage_events.append(nudge_usage)
                        continue
                    # ── Pre-edit verdict guard (2026-11-17) ──
                    # simulate -> silently fix -> answer the POST-FIX world:
                    # the trace shows the pre-write simulation REFUSED the
                    # as-written text, a later write staged a fix to the
                    # same macro, and the answer quotes none of the failing
                    # values the tool reported. Re-prompt once (ack-guard
                    # cap style) to answer the question that was asked.
                    # Trace-mechanical: tool outputs + write trace only,
                    # never prose-claim parsing (intent law). Placed AFTER
                    # the edit-prose nudge — that guard owns inert drafts;
                    # this one owns verdict amnesia in an otherwise clean
                    # staged-success answer.
                    if (verdict_reprompts < 1
                            and executed_tool_calls
                            and current_content.strip()):
                        verdict_miss = _pre_write_verdict_miss(
                            executed_tool_calls, current_content)
                        if verdict_miss is not None:
                            verdict_reprompts += 1
                            logger.info(
                                "Verdict guard | pre-write sim refusal + "
                                "silently-fixed answer | nudging once | "
                                "turn=%d preview=%s",
                                tool_turns,
                                current_content[:120].replace("\n", " "),
                            )
                            clean_prior = MCP_TOOL_BLOCK_RE.sub(
                                "", current_content).strip()
                            if clean_prior:
                                current_messages.append(
                                    {"role": "assistant", "content": clean_prior})
                            current_messages.append(
                                {"role": "user", "content": verdict_miss})
                            verdict_payload = _build_provider_payload(
                                req.apiProvider, current_messages, req.model,
                                max_tokens=req.maxTokens,
                                temperature=req.temperature,
                                tools=native_tools,
                                merge_system=req.mergeSystemMessages,
                            )
                            current_content, current_data = await _query_provider(
                                client, req.apiUrl, headers, verdict_payload,
                                req.apiProvider,
                                logger_context=f"verdict-reprompt-{verdict_reprompts}",
                                stop_event=stop_event,
                            )
                            verdict_usage = _extract_usage_info(current_data)
                            if verdict_usage:
                                verdict_usage["context"] = (
                                    f"verdict-reprompt-{verdict_reprompts}")
                                usage_events.append(verdict_usage)
                            continue
                    # ── Ack guard (Phase 6.5.2) ──
                    # The reply ENDS on a promise to act ("I'll now apply
                    # that to your config") with NO tool call, on an edit
                    # request where NO write tool has fired yet: the promise
                    # is a lie by omission — the turn produced nothing.
                    # Inject ONE execution directive and re-query. Placed
                    # AFTER the edit-prose nudge so the stronger mechanical
                    # evidence (inert draft / correctable kickback, up to 3
                    # corrections) owns those cases; the ack guard catches
                    # the pure promise. Zero write attempts is the gate:
                    # once ANY write fired, remaining prose is a partial-
                    # success report, and the confab guard already handles
                    # the staged-nothing case with trace truth. Cap 1 — if
                    # the model acks twice, let the user see it (Hermes
                    # caps at 2; local latency says 1). Protocol-agnostic:
                    # the tail check runs on visible text, so it fires
                    # identically under native and text protocols.
                    if (ack_reprompts < 1
                            and edit_capable
                            and _is_edit_request(req.messages)
                            and not any(n in EDIT_TOOL_NAMES
                                         for n in executed_tool_names)
                            and current_content.strip()
                            and _ends_with_continue_intent(current_content)):
                        ack_reprompts += 1
                        logger.info(
                            "Ack guard | continue-intent promise with no "
                            "write tool | nudging once | turn=%d preview=%s",
                            tool_turns,
                            current_content[:120].replace("\n", " "),
                        )
                        if current_content.strip():
                            clean_prior = MCP_TOOL_BLOCK_RE.sub("", current_content).strip()
                            if clean_prior:
                                current_messages.append(
                                    {"role": "assistant", "content": clean_prior})
                        current_messages.append({
                            "role": "user",
                            # Arm by CURRENT tool surface: with the skill
                            # gate still closed the write tools are not
                            # advertised, so the directive is the load step
                            # (same shape as _LOAD_SKILL_NUDGE_TEXT); with
                            # them unlocked it is the execute-directly order.
                            "content": (
                                (_LOAD_SKILL_NUDGE_TEXT
                                 if _skill_gate_closed()
                                 else "Execute the edit now with the edit "
                                      "tool — do not describe it.")
                                + _ACK_GUARD_TAIL),
                        })
                        ack_payload = _build_provider_payload(
                            req.apiProvider, current_messages, req.model,
                            max_tokens=req.maxTokens,
                            temperature=req.temperature,
                            tools=native_tools,
                            merge_system=req.mergeSystemMessages,
                        )
                        current_content, current_data = await _query_provider(
                            client, req.apiUrl, headers, ack_payload,
                            req.apiProvider,
                            logger_context=f"ack-reprompt-{ack_reprompts}",
                            stop_event=stop_event,
                        )
                        ack_usage = _extract_usage_info(current_data)
                        if ack_usage:
                            ack_usage["context"] = f"ack-reprompt-{ack_reprompts}"
                            usage_events.append(ack_usage)
                        continue
                    if tool_turns > 0:
                        logger.info("Tool call loop done | turns=%d final_chars=%d", tool_turns, len(current_content))
                    break

                # ── Hallucinated-tool guard ──
                # If the model wrapped names that are not real tools (e.g.
                # G-code commands like BED_MESH_CALIBRATE) in tool blocks and
                # produced answer text alongside, keep the text and stop
                # instead of feeding "Unknown tool" errors back — that derails
                # models into explaining the error instead of answering.
                known_tool_names = {t["name"] for t in _mcp_server._list_tools()}
                if edit_capable:
                    known_tool_names |= EDIT_TOOL_NAMES
                    known_tool_names.add(LOAD_SKILL_SPEC["name"])
                known_tool_names.add(LIST_HARDWARE_SPEC["name"])
                if tool_calls and current_content.strip() and all(
                    c.get("name") not in known_tool_names for c in tool_calls
                ):
                    logger.warning(
                        "Hallucinated tool call(s) skipped | names=%s content_chars=%d",
                        [c.get("name") for c in tool_calls], len(current_content),
                    )
                    break

                logger.info(
                    "Tool calls detected | turn=%d count=%d first=%s format=%s content_preview=%s",
                    tool_turns + 1, len(tool_calls),
                    tool_calls[0]["name"],
                    "native" if native_calls else "text",
                    repr(current_content[:80]),
                )

                # ── Progress emit point (Phase 6.5.1) ──
                # Canonical loop state (calls extracted, not yet executed)
                # published to the poller BEFORE the batch runs, so a long
                # edit→validate→re-edit chain is never silent. Narration =
                # the turn's visible text with the call markup stripped
                # (same cleanup chain the follow-up messages use).
                _narration = _strip_template_pythonic_calls(current_content).strip()
                _narration = MCP_TOOL_BLOCK_RE.sub("", _narration).strip()
                _narration = ALT_TOOL_CALL_CONTENT_RE.sub("", _narration).strip()
                _narration = CALL_SYNTAX_CLEANUP_RE.sub("", _narration).strip()
                _narration = FUNC_CALL_CLEANUP_RE.sub("", _narration).strip()
                _narration = _strip_bracket_tool_calls(_narration).strip()
                _narration = DSML_CLEANUP_RE.sub("", _narration).strip()
                _narration = XML_TOOL_CALLS_CLEANUP_RE.sub("", _narration).strip()
                _emit_progress(
                    [str(c.get("name", "")) for c in tool_calls],
                    _narration[:500],
                )

                # Execute every tool call in this round first, then build the
                # follow-up messages in the format the provider expects.
                results = []
                # Per-message execution window: an edit-capable request
                # gets a wider slice so ONE batched multi-edit message is
                # never silently truncated mid-batch (2026-10-16; the
                # non-edit path keeps 10).
                _msg_cap = (MAX_TOOL_CALLS_PER_MESSAGE_EDIT if edit_capable
                            else MAX_TOOL_CALLS_PER_MESSAGE)
                for tool_call in tool_calls[:_msg_cap]:
                    repeat_key = _repeat_read_key(tool_call)
                    if repeat_key and repeat_key in read_ledger:
                        # Literal repeat of a read already answered this
                        # request: no execution, no payload — the model
                        # gets the directive and nothing else (see
                        # REPEAT_GUARD_TOOLS).
                        result_text = REPEAT_READ_FEEDBACK
                        logger.info(
                            "Repeat read blocked | name=%s args=%.120s",
                            tool_call.get("name"),
                            json.dumps(tool_call.get("arguments") or {},
                                       sort_keys=True, default=str),
                        )
                        results.append(result_text)
                        continue
                    if edit_capable and tool_call.get('name') == 'load_skill':
                        # Dispatch by REQUESTED skill name through the
                        # registry — loading a knowledge skill must never
                        # unlock the edit tools (only the config-editing
                        # load flips the gate).
                        edit_details = None
                        requested = str(
                            (tool_call.get('arguments') or {}).get('name', ''))
                        if requested in ('', EDIT_SKILL_NAME):
                            # Idempotent re-load after activation: body is
                            # already in history; serve it again. First
                            # load: flip the gate and re-resolve tools.
                            if not _skill_state['active']:
                                _skill_state['active'] = True
                                native_tools = _resolve_native_tools(
                                    req.apiProvider, req.apiUrl,
                                    req.toolProtocol,
                                    edit_capable=edit_capable,
                                    skill_active=True)
                                logger.info(
                                    "Edit skill activated | write tools "
                                    "unlocked mid-request requestId=%s",
                                    req.requestId or 'none')
                            result_text = _edit_skill_body()
                        elif requested in _SKILL_REGISTRY:
                            result_text = _SKILL_REGISTRY[requested]["body"]()
                            logger.info(
                                "Skill loaded (knowledge) | name=%s "
                                "requestId=%s", requested,
                                req.requestId or 'none')
                        else:
                            result_text = _unknown_skill_text(requested)
                    elif edit_session is not None and tool_call.get("name") in EDIT_TOOL_NAMES:
                        if _skill_gate_closed():
                            # Write tool used WITHOUT loading the skill:
                            # kick back with the load step, not the edit.
                            result_text = (
                                f"'{tool_call.get('name')}' is not available yet. "
                                f"Call load_skill(name='{EDIT_SKILL_NAME}') "
                                "first — it returns the edit rules and "
                                "unlocks the edit tools.")
                            edit_details = None
                            logger.warning(
                                "Edit tool blocked | skill not loaded name=%s",
                                tool_call.get('name'))
                        else:
                            # Request-scoped write path (never the MCP server).
                            #
                            # POST-HOC REVIEW (2026-10-02): the write path no
                            # longer suspends. A validated op stages straight
                            # into the request's working state and change set;
                            # the model finishes its reply; approve/decline
                            # happens after it, on the change set (chat rows +
                            # footer, text-view pane). The approval machinery
                            # (ApprovalRequest, the /ai/chat/approval rail,
                            # ChatApprovalCard, the 90s clock) is DORMANT —
                            # kept intact for the first IRREVERSIBLE tool
                            # (disk write, firmware restart, printer command),
                            # which is what a blocking card is actually for.
                            result_text, edit_details = edit_session.execute(tool_call)
                            logger.info(
                                "Edit tool executed | name=%s attempts=%d ok=%s",
                                tool_call["name"], edit_session.edit_attempts,
                                edit_details is not None,
                            )
                            # Live change set: the row appears in the
                            # transcript and the edit lands in the editor
                            # as it happens, not after the reply.
                            _publish_staged_edits(req.requestId, edit_session)
                    elif (tool_call.get("name") == "list_hardware"):
                        # Chat-layer read tool (NOT the MCP server): the
                        # MCP server sees only disk, while the approval
                        # flow keeps the live project in the session's
                        # working state — a disk read could hand back
                        # stale section text and manufacture old_text
                        # mismatch kickbacks one edit later.
                        from services.hardware_lookup import (
                            list_hardware as _list_hardware)
                        # Working state first (approved unsaved edits win),
                        # with the user-config mirror as a FLOOR: class
                        # members live in files the frontend may not have
                        # loaded (TRIDENT-15 design: SB_LEDs in EBB.cfg),
                        # and the mirror is the same source
                        # search_user_configs reads.
                        hw_files = dict(edit_session.state.files) \
                            if edit_session is not None else {}
                        if not hw_files:
                            hw_files = {
                                name: str((meta or {}).get("content", ""))
                                for name, meta in
                                (req.contextFiles or {}).items()
                            }
                        try:
                            for mname, mmeta in (
                                    _mirror_user_config_files()).items():
                                hw_files.setdefault(
                                    mname,
                                    str((mmeta or {}).get("content", "")))
                        except Exception:
                            logger.debug(
                                "list_hardware mirror floor "
                                "unavailable", exc_info=True)
                        try:
                            result_text = _list_hardware(
                                hw_files,
                                str(tool_call.get("arguments", {})
                                    .get("type", "")))
                        except Exception:
                            logger.exception(
                                "list_hardware failed | type=%s",
                                tool_call.get("arguments", {}))
                            result_text = ("list_hardware failed "
                                           "unexpectedly — fall back "
                                           "to search_user_configs.")
                    else:
                        # MCP read/other tool: expose the session's live
                        # working state first (drafts + this request's
                        # approved edits win over disk; see
                        # _set_working_overlay).
                        _set_working_overlay(edit_session)
                        result_text = await _execute_tool_call_async(tool_call)
                    if repeat_key:
                        # Executed for the first time this request: any
                        # literal repeat now gets the lean directive.
                        read_ledger.add(repeat_key)
                        # THRASH charge (2026-10-16): one executed read
                        # call. Only reaches here for REPEAT_GUARD_TOOLS
                        # that actually ran — repeat-dead reads die above
                        # and never charge, matching "reads past grace"
                        # as the waste definition (reading different
                        # things is discovery; the grace covers it).
                        if edit_session is not None:
                            edit_session.charge_read()
                    logger.info(
                        "Tool executed | name=%s result_chars=%d",
                        tool_call["name"], len(result_text),
                    )
                    executed_tool_names.append(tool_call["name"])
                    executed_tool_calls.append(
                        _build_executed_tool_call(tool_call, result_text)
                    )
                    results.append(result_text)

                if native_calls is not None:
                    # Native format: echo the assistant message (with tool_calls)
                    # and append one 'tool' / tool_result message per call.
                    current_messages.extend(
                        _build_native_tool_followup(
                            req.apiProvider, current_content, tool_calls, results,
                        )
                    )
                    tool_turns += len(tool_calls)
                else:
                    # Text format: strip the tool call syntax from the assistant
                    # message so the re-query doesn't confuse models that use
                    # native special tokens (Gemma, Llama 3.1+, Qwen, etc.),
                    # then append one user tool-result message per call. Only
                    # append the assistant message if it has actual text — if
                    # the model ONLY emitted a tool call, skip it.
                    for tool_call, result_text in zip(tool_calls, results):
                        tool_message = _build_tool_result_message(tool_call, result_text)

                        clean_content = _strip_template_pythonic_calls(current_content).strip()
                        clean_content = MCP_TOOL_BLOCK_RE.sub("", clean_content).strip()
                        clean_content = ALT_TOOL_CALL_CONTENT_RE.sub("", clean_content).strip()
                        clean_content = CALL_SYNTAX_CLEANUP_RE.sub("", clean_content).strip()
                        clean_content = FUNC_CALL_CLEANUP_RE.sub("", clean_content).strip()
                        clean_content = _strip_bracket_tool_calls(clean_content).strip()
                        clean_content = DSML_CLEANUP_RE.sub("", clean_content).strip()
                        clean_content = XML_TOOL_CALLS_CLEANUP_RE.sub("", clean_content).strip()
                        if clean_content:
                            current_messages.append({"role": "assistant", "content": clean_content})
                        current_messages.append({"role": "user", "content": tool_message})
                    tool_turns += len(tool_calls)

                tool_payload = _build_provider_payload(
                    req.apiProvider, current_messages, req.model,
                    max_tokens=req.maxTokens,
                    temperature=req.temperature,
                    tools=native_tools,
                    merge_system=req.mergeSystemMessages,
                )
                current_content, current_data = await _query_provider(
                    client, req.apiUrl, headers, tool_payload, req.apiProvider,
                    logger_context=f"tool-turn-{tool_turns}",
                    stop_event=stop_event,
                )
                turn_usage = _extract_usage_info(current_data)
                if turn_usage:
                    turn_usage["context"] = f"tool-turn-{tool_turns}"
                    usage_events.append(turn_usage)

            # Clean up any remaining tool call blocks in the final content.
            # Check whether the content contained tool call blocks BEFORE cleanup
            # so we don't restore raw tool call text back into the visible output.
            had_tool_blocks = bool(
                TEMPLATE_CALL_HEAD_RE.search(current_content)
                or MCP_TOOL_BLOCK_RE.search(current_content)
                or ALT_TOOL_CALL_CONTENT_RE.search(current_content)
                or CALL_SYNTAX_CLEANUP_RE.search(current_content)
                or FUNC_CALL_CLEANUP_RE.search(current_content)
                or DSML_CLEANUP_RE.search(current_content)
                or XML_TOOL_CALLS_CLEANUP_RE.search(current_content)
                or UNTERMINATED_TOOL_FENCE_RE.search(current_content)
                or TOOL_RESIDUE_RE.search(current_content)
            )
            final_content = _strip_template_pythonic_calls(current_content).strip()
            final_content = MCP_TOOL_BLOCK_RE.sub("", final_content).strip()
            final_content = ALT_TOOL_CALL_CONTENT_RE.sub("", final_content).strip()
            final_content = CALL_SYNTAX_CLEANUP_RE.sub("", final_content).strip()
            final_content = FUNC_CALL_CLEANUP_RE.sub("", final_content).strip()
            final_content = _strip_bracket_tool_calls(final_content).strip()
            final_content = DSML_CLEANUP_RE.sub("", final_content).strip()
            # An unterminated ```tool fence (truncated broken call) would
            # otherwise leak raw markup into the bubble — it always extends
            # to end of content, so a tail-strip is safe.
            final_content = UNTERMINATED_TOOL_FENCE_RE.sub("", final_content).strip()
            # Tail-only native-call fragments (no opener for the regexes
            # above to anchor on) — same reason as the unterminated fence.
            final_content = _strip_tool_residue(final_content)
            # If the cleanup left nothing but the original was a tool call,
            # don't restore the raw tool call text — return empty instead.
            if not final_content and not had_tool_blocks:
                final_content = current_content

            # ── Empty-response backstop ──
            # Models sometimes end their turn with only a tool call and no
            # visible text. Re-prompt without tools so the model answers the
            # user's question directly instead of the UI showing
            # "No response.".
            empty_reprompts = 0
            reprompt_tool_turns = 0
            while not final_content and empty_reprompts < EMPTY_REPROMPT_LIMIT:
                if stop_event is not None and stop_event.is_set():
                    raise ChatStoppedError()
                # Same orphan guard as the tool loop: a disconnected
                # client must not fund re-prompts either (probe: 12 more
                # provider calls after the tool loop stopped).
                if await _client_disconnected(request):
                    logger.warning(
                        "Client disconnected during empty-reprompt | "
                        "stopping | reprompts=%d requestId=%s",
                        empty_reprompts, req.requestId or 'none')
                    break
                empty_reprompts += 1
                # THRASH charge: the empty round-trip was really spent.
                # Deliberately NOT refunded when the re-prompt turns out
                # productive (`empty_reprompts -= 1` below is display/
                # accounting for the provider-reprompt counter only).
                if edit_session is not None:
                    edit_session.charge_waste()
                logger.warning(
                    "Empty final content | re-prompting without tools (attempt %d/%d)",
                    empty_reprompts, EMPTY_REPROMPT_LIMIT,
                )
                current_messages.append({
                    "role": "system",
                    "content": (
                        "Your previous response contained no visible text. "
                        "Answer the user's latest question directly with text "
                        "now. Do not call any tools."
                    ),
                })
                # Local reasoning builds burn hidden tokens before visible
                # text, so give the re-prompt at least EMPTY_REPROMPT_MAX_TOKENS
                # of budget — the original limit may have been exhausted
                # invisibly (empty content + finish_reason=length).
                retry_max_tokens = req.maxTokens
                if _is_local_provider(req.apiProvider, req.apiUrl):
                    retry_max_tokens = max(req.maxTokens, EMPTY_REPROMPT_MAX_TOKENS)
                logger.info(
                    "Empty re-prompt budget | req=%d retry=%d provider=%s",
                    req.maxTokens, retry_max_tokens, req.apiProvider,
                )
                retry_payload = _build_provider_payload(
                    req.apiProvider, current_messages, req.model,
                    max_tokens=retry_max_tokens,
                    temperature=req.temperature,
                    tools=None,
                    merge_system=req.mergeSystemMessages,
                )
                current_content, current_data = await _query_provider(
                    client, req.apiUrl, headers, retry_payload, req.apiProvider,
                    logger_context=f"empty-reprompt-{empty_reprompts}",
                    stop_event=stop_event,
                )
                retry_usage = _extract_usage_info(current_data)
                if retry_usage:
                    retry_usage["context"] = f"empty-reprompt-{empty_reprompts}"
                    usage_events.append(retry_usage)

                # Some models (DeepSeek "flash", Qwen, ...) ignore the
                # no-tools instruction and emit tool calls as plain text —
                # bare <tool_calls> XML, DSML, or ```tool blocks. Execute them
                # so the turn isn't wasted on raw markup or the fallback
                # message; the tool results usually let the model answer.
                reprompt_calls = (
                    _extract_native_tool_calls(req.apiProvider, current_data)
                    or _extract_tool_calls(current_content)
                )
                if reprompt_calls and reprompt_tool_turns < MAX_MCP_TOOL_TURNS:
                    reprompt_tool_turns += len(reprompt_calls)
                    tool_turns += len(reprompt_calls)
                    empty_reprompts -= 1  # productive turn, not a failed attempt
                    logger.info(
                        "Empty re-prompt returned tool calls | executing %d (reprompt_turns=%d)",
                        len(reprompt_calls), reprompt_tool_turns,
                    )
                    clean_assistant = MCP_TOOL_BLOCK_RE.sub("", current_content).strip()
                    clean_assistant = ALT_TOOL_CALL_CONTENT_RE.sub("", clean_assistant).strip()
                    clean_assistant = CALL_SYNTAX_CLEANUP_RE.sub("", clean_assistant).strip()
                    clean_assistant = FUNC_CALL_CLEANUP_RE.sub("", clean_assistant).strip()
                    clean_assistant = _strip_bracket_tool_calls(clean_assistant).strip()
                    clean_assistant = DSML_CLEANUP_RE.sub("", clean_assistant).strip()
                    clean_assistant = XML_TOOL_CALLS_CLEANUP_RE.sub("", clean_assistant).strip()
                    if clean_assistant:
                        current_messages.append({"role": "assistant", "content": clean_assistant})
                    # Review fix 2026-09-26 (CRITICAL): this path used to
                    # run write calls through edit_session.execute()
                    # directly, bypassing the load_skill gate — a
                    # text-protocol config_edit on the empty re-prompt
                    # staged straight into the editor without the skill.
                    # Route through the SAME dispatch as the main tool
                    # loop: skill-gate check first, then the (now
                    # un-gated) staging write.
                    reprompt_results = []
                    for c in reprompt_calls[:MAX_MCP_TOOL_TURNS]:
                        if edit_capable and c.get("name") == "load_skill":
                            # Round-2 review: mirror the main loop's
                            # load_skill arm — without it a load_skill on
                            # this path hit the MCP dispatcher and got
                            # "Unknown tool", contradicting the kickback
                            # the gate itself injects. Fails closed
                            # either way; now it just works.
                            requested = str(
                                (c.get("arguments") or {}).get("name", ""))
                            if requested in ("", EDIT_SKILL_NAME):
                                _skill_state["active"] = True
                                logger.info(
                                    "Edit skill activated on re-prompt path"
                                    " | write tools unlocked requestId=%s",
                                    req.requestId or 'none')
                                reprompt_results.append(_edit_skill_body())
                            elif requested in _SKILL_REGISTRY:
                                reprompt_results.append(
                                    _SKILL_REGISTRY[requested]["body"]())
                            else:
                                reprompt_results.append(
                                    _unknown_skill_text(requested))
                        elif edit_session is not None and c.get("name") in EDIT_TOOL_NAMES:
                            if _skill_gate_closed():
                                reprompt_results.append(
                                    f"'{c.get('name')}' is not available yet. "
                                    f"Call load_skill(name='{EDIT_SKILL_NAME}') "
                                    "first — it returns the edit rules and "
                                    "unlocks the edit tools.")
                                logger.warning(
                                    "Edit tool blocked on re-prompt path | "
                                    "skill not loaded name=%s", c.get('name'))
                            else:
                                # Same un-gated write path as the main loop
                                # (see the post-hoc review note there): one
                                # staging surface, no suspension, no card.
                                reprompt_results.append(edit_session.execute(c)[0])
                                _publish_staged_edits(req.requestId, edit_session)
                        else:
                            _set_working_overlay(edit_session)
                            reprompt_results.append(await _execute_tool_call_async(c))
                    for reprompt_call, result_text in zip(
                        reprompt_calls[:MAX_MCP_TOOL_TURNS],
                        reprompt_results,
                    ):
                        executed_tool_names.append(reprompt_call["name"])
                        executed_tool_calls.append(
                            _build_executed_tool_call(reprompt_call, result_text)
                        )
                        current_messages.append({
                            "role": "user",
                            "content": _build_tool_result_message(reprompt_call, result_text),
                        })
                    continue

                final_content = MCP_TOOL_BLOCK_RE.sub("", current_content).strip()
                final_content = ALT_TOOL_CALL_CONTENT_RE.sub("", final_content).strip()
                final_content = CALL_SYNTAX_CLEANUP_RE.sub("", final_content).strip()
                final_content = FUNC_CALL_CLEANUP_RE.sub("", final_content).strip()
                final_content = _strip_bracket_tool_calls(final_content).strip()
                final_content = DSML_CLEANUP_RE.sub("", final_content).strip()
                final_content = XML_TOOL_CALLS_CLEANUP_RE.sub("", final_content).strip()
                final_content = _strip_tool_residue(final_content)

            # Collect tool names used during the MCP tool loop. Native tool
            # calls don't leave `[Tool result: ...]` messages, so fall back
            # to the names captured while executing them.
            mcp_tool_names = _collect_tool_names(current_messages)
            if not mcp_tool_names and executed_tool_names:
                mcp_tool_names = list(dict.fromkeys(executed_tool_names))


            # ── Confabulated-completion guard (TRIDENT-15) ──
            # The write path was ATTEMPTED (>=1 config_edit/config_write
            # call) and the request ENDED with NOTHING staged: every op
            # was a correctable kickback, a user decline, or a 90s
            # approval timeout. Replies in this state habitually claim
            # the change "has been staged/applied" (r2: "the tool call
            # has already been executed and the changes are staged").
            # We do NOT parse the prose to judge the claim (intent law):
            # the trace is ground truth, so a note stating it is appended
            # whenever trace and expectation disagree. Fail-safe — a
            # wrong note is a useless observation; silence is the status
            # quo. Never fires when anything IS staged (coarse on
            # partial success, which the cards show honestly).
            if (edit_session is not None
                    and edit_session.edit_attempts
                    and (not edit_session.pending_edits
                         or edit_session.unresolved_write_failures())):
                logger.warning(
                    "Confab guard | write attempts=%d outcome=%s staged=%d"
                    " failures=%d unresolved=%d | appending trace-truth note",
                    edit_session.edit_attempts,
                    edit_session.last_write_outcome,
                    len(edit_session.pending_edits),
                    edit_session.write_failures,
                    edit_session.unresolved_write_failures(),
                )
                # The trace distinguishes a USER decision from technical
                # failures — the note must not conflate them (a blanket
                # "failed validation, was declined, or timed out" made
                # models report a plain decline as "the system declined
                # it").
                if edit_session.last_write_outcome == "user_gated":
                    note = (
                        "\n\n---\n*Note: the user chose not to apply the "
                        "proposed change(s); nothing is staged for "
                        "saving.*"
                    )
                elif edit_session.pending_edits:
                    # Step 4 (2026-10-17): partial success over FAILED
                    # calls. If the model still closes "all done", the
                    # trace stamps the reply — the cards show what
                    # staged, the note states what did not. Counts
                    # UNRESOLVED failures only (B4, round-1 review
                    # 2026-10-25): a failed op the model re-landed by
                    # retrying is staged and must not appear in the note.
                    _fails = edit_session.unresolved_write_failures()
                    note = (
                        "\n\n---\n*Note: "
                        + f"{_fails} edit call"
                        + ("" if _fails == 1 else "s")
                        + " failed during this request and "
                        + ("it is" if _fails == 1 else "they are")
                        + " NOT staged — the reply may claim more than "
                          "the change set contains.*"
                    )
                else:
                    note = (
                        "\n\n---\n*Note: no changes from this reply are"
                        " staged for saving — every edit attempt failed"
                        " validation, was declined, or timed out.*"
                    )
                final_content = final_content.rstrip() + note

            logger.info(
                "Returning response | final_chars=%d tool_turns=%d tools=%s empty=%s",
                len(final_content), tool_turns,
                mcp_tool_names or [],
                "yes" if not final_content else "no",
            )
            if not final_content:
                logger.warning(
                    "Empty final content after %d tool turns (%d re-prompts) "
                    "| staged=%d — using fallback",
                    tool_turns, empty_reprompts,
                    len(getattr(edit_session, "pending_edits", None) or []),
                )
                # Never surface a blank bubble: the UI would show "No response."
                # The re-prompt loop already burned EMPTY_REPROMPT_LIMIT queries,
                # so return an explicit fallback the user can act on instead.
                # When the tool turns DID stage work, name it — a "try
                # rephrasing" line next to a live review card reads as a
                # failure that never happened (bank106-r1, 11 qids).
                final_content = _empty_content_fallback(edit_session)

            return {
                "content": final_content,
                "mcpToolTurns": tool_turns,
                "mcpToolNames": mcp_tool_names,
                "toolCalls": executed_tool_calls,
                "repromptCount": empty_reprompts,
                # Per-turn narration captured at the progress emit point
                # ({turn, narration, toolNames}); harness grading for the
                # narration-vs-tool consistency check (Phase 6.5.5). Empty
                # list when no requestId (no registry).
                "narrationTurns": (
                    list((_chat_progress.get(req.requestId) or {}).get("turns", []))
                    if req.requestId else []
                ),
                # Tool-mediated editing (Phase 1): staged changes from
                # config_edit/config_write calls (file/op/summary/newText/
                # advisories), null when the feature is off or nothing was
                # staged. The frontend feeds these to the current draft
                # flow (approval cards arrive in Phase 2).
                "pendingEdits": (
                    edit_session.pending_edits_payload()
                    if edit_session is not None and edit_session.pending_edits
                    else None
                ),
                # Post-hoc edit review (2026-10-02): the request's change
                # set — one record per edit, chronological, plus the
                # summary grouped by file and section. The chat renders the
                # records as rows; the footer and POST /ai/chat/changes/
                # resolve work off the same set. null when nothing staged.
                "changeSet": (
                    edit_session.change_set_payload()
                    if edit_session is not None and edit_session.edit_records
                    else None
                ),
                # Per-call write-attempt accounting (Gate 1 oscillation
                # analysis); null when the session never ran.
                "editAttempts": (
                    edit_session.edit_attempts if edit_session is not None else None
                ),
                # Mid-loop steers the user sent while this request ran
                # ({turn, text}), so the transcript can mark the message it
                # already shows as landed rather than re-deriving it.
                "steers": (
                    list((_chat_progress.get(req.requestId) or {}).get("steers", []))
                    if req.requestId else []
                ),
                "usage": {
                    "completionTokens": sum(
                        (e.get("completionTokens") or 0) for e in usage_events
                    ),
                    "reasoningTokens": sum(
                        (e.get("reasoningTokens") or 0) for e in usage_events
                    ),
                    # Ack-guard bookkeeping (Phase 6.5.2): 1 when a
                    # continue-intent promise was rescued by the injected
                    # directive. The harness grades rescued cases FAIL
                    # (expect_no_ack_stall) — a cleaned-up lie is still
                    # the weakness.
                    "ackReprompts": ack_reprompts,
                    # W7 context-pressure: the LAST provider request of the
                    # loop is the fullest prompt, so its size is the pressure
                    # signal the client compares against the router window.
                    "lastPromptTokens": next(
                        (
                            e.get("promptTokens")
                            for e in reversed(usage_events)
                            if isinstance(e.get("promptTokens"), int)
                        ),
                        None,
                    ),
                    # C3: cached share of that same last request — the
                    # prefix the NEXT turn continues from. 0 with a warm
                    # conversation means something upstream of the tail
                    # started moving (see cache probe harness).
                    "lastCachedTokens": next(
                        (
                            e.get("cachedTokens")
                            for e in reversed(usage_events)
                            if isinstance(e.get("cachedTokens"), int)
                        ),
                        None,
                    ),
                    "events": usage_events,
                    "truncated": any(
                        (e.get("finishReason") or "") == "length" for e in usage_events
                    ),
                },
            }
        except ChatStoppedError:
            logger.info("Chat stopped by user | requestId=%s", req.requestId)
            return {"stopped": True}
        except ValueError as e:
            logger.error("API error | %s", str(e))
            # W8: a provider that answers 200-with-error for a context-length
            # failure (the _extract_api_error_message ValueError path, incl.
            # MID-LOOP after tool results grew the prompt) gets the same
            # structured, actionable error as the pre-flight.
            if is_context_overflow_error(str(e)):
                return {"error": CONTEXT_OVERFLOW_MESSAGE, "errorCode": CONTEXT_OVERFLOW_ERROR_CODE}
            return {"error": f"API error: {str(e)}"}
        except httpx.TimeoutException:
            logger.error("Request timed out")
            return {"error": "API request timed out before the model finished responding."}
        except httpx.HTTPStatusError as e:
            # W8: context-length 400s must read as an actionable banner,
            # not "API request failed: request failed" — the informative
            # text is in the response BODY, which HTTPStatusError's str()
            # does not carry. Read it before classifying.
            body = ""
            try:
                body = e.response.text if e.response is not None else ""
            except Exception:  # noqa: BLE001 — classification is advisory only
                body = ""
            logger.error("HTTP status error | %s body=%.200s", str(e), body)
            if is_context_overflow_error(body) or is_context_overflow_error(str(e)):
                return {"error": CONTEXT_OVERFLOW_MESSAGE, "errorCode": CONTEXT_OVERFLOW_ERROR_CODE}
            return {"error": f"API request failed: {str(e)}"}
        except httpx.HTTPError as e:
            logger.error("HTTP error | %s", str(e))
            if is_context_overflow_error(str(e)):
                return {"error": CONTEXT_OVERFLOW_MESSAGE, "errorCode": CONTEXT_OVERFLOW_ERROR_CODE}
            return {"error": f"API request failed: {str(e)}"}
        finally:
            if req.requestId:
                # Keep the change set reachable for the post-hoc review
                # (keep/undo is a replay of the kept ops, which needs this
                # session's ops and pre-request baseline).
                register_edit_session(req.requestId, edit_session)
                _chat_stop_events.pop(req.requestId, None)
                _chat_progress.pop(req.requestId, None)
                _chat_steers.pop(req.requestId, None)


# ── AI state + chat history file storage ─────────────────────────────
# Chat settings, the current in-progress conversation, and saved chat
# history live in gitignored JSON files under backend/data/ai/ so they
# survive browser cache clears and are not pushed to GitHub.

AI_DATA_DIR = BACKEND_DIR / "data" / "ai"
AI_STATE_FILE = AI_DATA_DIR / "state.json"
AI_HISTORY_FILE = AI_DATA_DIR / "history.json"


def _load_ai_json(file_path: Path) -> dict:
    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_ai_json(file_path: Path, payload: dict) -> None:
    AI_DATA_DIR.mkdir(parents=True, exist_ok=True)
    file_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


@router.get("/ai/state")
async def get_ai_state() -> dict:
    """Load the saved AI settings and in-progress conversation."""
    return _load_ai_json(AI_STATE_FILE)


@router.post("/ai/state")
async def save_ai_state(payload: dict) -> dict:
    """Persist AI settings and the in-progress conversation to disk."""
    _save_ai_json(AI_STATE_FILE, payload)
    return {"status": "saved"}


@router.get("/ai/history")
async def get_ai_history() -> dict:
    """Load the saved chat history (list of conversations)."""
    return _load_ai_json(AI_HISTORY_FILE)


@router.post("/ai/history")
async def save_ai_history(payload: dict) -> dict:
    """Persist the saved chat history to disk."""
    _save_ai_json(AI_HISTORY_FILE, payload)
    return {"status": "saved"}
