# Zed AI → KWC Text View: Research & Considerations

Research into Zed (zed-industries/zed) — features, operation, and what KWC's
text view should reuse, change, or skip. Written 2026-10-05 on branch
`improvement/post-hoc-edit-review`, after rounds 1–3 of text-view work.

Sources: zed.dev/docs/ai (agent panel, tools, agent settings, edit
prediction), zed.dev/ai, ACP architecture notes, third-party teardowns of the
edit-prediction crates. Cross-checked against our branch: `TextEditor.tsx`,
`ChatDock.tsx`, `PendingDiffPane.tsx`, `utils/pendingDiff.ts`,
`utils/editorHighlight.ts`, `services/changeSetReview.ts`, stores
(aiStore, changeSetStore, pendingEditStore, chatReferenceStore).

---

## 1. How Zed's AI operates

Three deliberately separated surfaces:

- **Agent Panel** — multi-thread chat sidebar with a tool-calling agent
  (read / grep / edit / terminal / diagnostics / fetch). Tool calls render
  inline in the thread with lifecycle states (pending → confirm → done).
  Threads persist in SQLite. Communicates over ACP (JSON-RPC: session
  management, tool-call lifecycle, permission granularity).
- **Inline Assistant** — `ctrl-enter` on a selection: single-shot bounded
  prompt, rewrites in place, no tool loop. Works well on small local models.
- **Edit Prediction (Zeta)** — ghost-text next-edit model with its own
  provider trait, context pipeline (cursor neighborhood, recent edits,
  `.rules`), debounce settings, and metrics. Keystroke-level latency budget;
  Zeta2 is open-weight.

Underneath: a rope-backed buffer and a **DisplayMap** — all display
transformations (wrap, fold, diff annotations) compose as layers over the
real buffer, so review/wrap/fold never corrupt each other. Local models
(Ollama, LM Studio, llama.cpp, any OpenAI-compatible endpoint) are
first-class providers; the documented failure mode for local setups is
silent context truncation ("the trap that breaks everyone").

## 2. How Zed shows AI changes and handles keep/undo

Three nested surfaces, one review engine:

1. **Edit card in the thread** — per-file card with `+N −M` counts and a
   unified diff computed **result-time from actual applied before/after
   content with ±3 context lines** — never the model's raw arg snippet.
   `agent.expand_edit_card` toggles full vs capped height.
2. **Live in the buffer** — changes are applied to the real buffer as they
   stream (buffer text *is* the pending text; pending-ness is metadata on
   diff anchors). Additions tint green; removals render as inline struck
   blocks. Review decorations temporarily override the git diff
   (`agent.single_file_review`). "Follow the agent" crosshair jumps the
   editor to each touched file.
3. **Review Changes multi-buffer** (`ctrl-shift-r`) — one tab aggregating
   every hunk across every file, same keep/reject controls, accordion
   summary bar ("N files, M lines edited") persisting above the composer
   until resolved.

Keep/undo semantics:

- Edits apply immediately; accept/reject operate on diff anchors over
  applied text. Granularity: per-hunk → per-file → all.
- **The buffer is never taken out of edit mode.** You can type inside an
  unaccepted hunk; the diff recomputes against the pre-edit baseline,
  showing the combined human+AI change. Hand-editing does NOT auto-accept
  (contrast Copilot, which implicitly keeps on first keystroke). Rejecting
  a hand-edited hunk reverts the region to baseline, human edits included.
- **Restore Checkpoint** is a separate coarser layer: workspace state
  stamped before each edit-causing message; one button on the user message
  rewinds everything, including mid-interrupt and human typing since.
  Two undo layers (hunk = review, turn = checkpoint) with distinct visual
  locations (hunk controls vs user-message button), deliberately
  unmuddled.

## 3. Layout / interaction / UI design notes

- Zed layout: four dock slots, multibuffer tabs, drag-resize + size
  memory, status bar with ambient state (file type, cursor pos, diag
  counts). Outline is a transient picker, not a permanent tree.
- Interaction spine: command palette (every action named + fuzzy),
  `cmd-p` file finder, project-wide search, **select-next-occurrence /
  multi-cursor** (`cmd-d`), fold current section, keyboard-first with
  visible hints. `@`-mentions for context (file/symbol/diagnostics/past
  threads), `ctrl->` selection→thread, paste-code→file mention.
- Context economics: token meter in composer, auto + manual `/compact`
  (summarize old turns, expandable "Context Compacted" entry), "New From
  Summary", per-feature model slots (`thread_summary_model` on a smaller
  model). Queue-while-generating with editable/removable queued
  messages, "Send Now", and steer-at-turn-boundary (only where turn
  boundaries are detectable).
- Visual language: quiet chrome, one accent color used ONLY for state,
  diagnostics as gutter dots + wavy underlines, current-line highlight,
  hover-revealed tree actions, git-palette diffs with no separate AI
  vocabulary, near-zero motion.

## 4. Consideration list for KWC

### Strong considers

1. **Per-message restore checkpoints.** Workspace snapshot before each AI
   edit turn; "Restore checkpoint" on the causing chat message. Our review
   undo is replay-based and implicit after the set clears; checkpoints add
   the turn-level rewind Zed has. Snapshot is cheap; disk save stays
   gated. Reverts human edits since the turn too — needs one honest
   sentence in the confirm. Button lives on the chat message, never in
   the review pane (keep the two undo layers visually separate).
2. **Editable pending edits in the one buffer.** Collapse takeover vs
   editor the way Zed does: pending-ness becomes decoration on the live
   editable surface. Enablers already shipped: the frame law
   (beforeText vs live `textForFile`) and the textarea+overlay
   architecture with inline-span tints. Decisions: touched-hunk undo =
   revert-to-frame WITH disclosure (never implicit keep); decision
   buttons stay in the review strip (per-hunk floating buttons re-open
   the 2026-09-30 deferred-gutter drift class); full read-only diff stays
   available as an explicit view.
3. **Message queue + Send Now + stop.** Text typed during generation
   queues (editable, removable); double-enter = abort + send; stop
   button. Generation state must live in aiStore (single owner across
   dock fold/expand — same single-instance law as ChatDock's portal).
   Reduces the window where two approval cards contend (cf. the
   2026-09-22 multi-proposal bug) but does not itself fix it.
4. **Token meter + compaction.** Surface provider `prompt_tokens`
   (pass-through from the OpenAI-compatible response) next to the
   composer; `/compact` summarizes old turns with a utility model,
   displayed history stays full via a compacted-through marker in
   chatHistoryStore. Bites harder for us than Zed: bank runs at 8k
   max-tokens on 4k–32k local contexts — silent truncation is a known
   accuracy-bank failure class. Compaction quality is A/B-able against
   the 106-Q bank (`bank_compare.py`).

### Medium considers

5. **Multi-cursor / select-next-occurrence** — the killer text-view
   feature for config work (rename a macro across call sites, bump 8 pin
   values). Alt+click add-caret, `ctrl+d` select-next, Escape drops to
   one caret. Bounded but real work over a plain textarea.
6. **Project-wide search across config files** with click-to-jump
   (landing machinery `pendingLineJump` exists; widen scope beyond
   active file). Note: find/replace already has an "All files" scope
   for replace — the search-results jump path is the addition.
7. **Persistent "N changes / M files awaiting review" chip on the chat
   footer** while any unreviewed set exists (Zed's accordion bar).
8. **Inline assist on selection** — single-shot rewrite, no tool loop.
   Bounded requests work on 12B-class models where agent loops degrade.

### Cheap UI polish

- **Status line** under the editor: file · dirty · line:col · active
  `[section]` · error/warning counts. All values already computed
  (`sectionAtLine`, `isDirty`, `lineSeverities`); pure consumer.
- **Gutter severity dots** alongside the issue strip (strip = *what*,
  gutter = *where*); overlay/gutter-class only, no new layout.
- **Current-line highlight** — faint caret-row background as an inline
  span in the overlay; cheapest "pro editor" feel.
- **One accent, state-only** — retouch round-3 colors so `--color-accent`
  means only live/attached/configured (pill, tree selection, dock
  bubble, review highlights).
- **Hover-reveal tree actions + keyboard parity** (`ctrl+f` find, `F2`
  next issue); keep row width stable on reveal.
- **ChatDock drag-resize** — touches the Phase-8 fixed-width decision
  (360/420px). Hold until 360px dogfoods as too narrow; item #2 raises
  the pressure toward wanting it.

### Explicit non-goals

- **ACP/MCP hosting, external agents** — protocol investment with one
  backend and one surface.
- **Edit prediction / Zeta** — needs a dedicated sub-100ms model path;
  impossible on Pi-class hosts, off-target for config editing.
- **Multi-thread + git-worktree isolation** — one working config, one
  thread, checkpoints instead.
- **Command palette** — ~15 actions don't earn one; toolbar covers
  discoverability at this size.
- **Rope/virtualized buffer** — right-sized today; the Pi Zero 2 W
  (424MB, volatile journald) argues against it.
- **Hunk-level granularity** — our `[section]` unit is semantically
  better for INI configs; half-kept blocks are worse. Revisit only if a
  multi-hunk-section annoyance shows in dogfooding.

## 5. Impact on shipped code (strong considers + polish)

### Checkpoints (#1)
- Backend: snapshot store keyed by chat message id (promote the existing
  per-file `beforeText` frame to durable per-message) + restore endpoint
  replaying "files back to frame" — changeSetReview's replay machinery
  pointed at a whole turn.
- Frontend: button on the causing user message in ChatMessageList
  (ApprovalCard already links messages→change-sets); restore = confirm →
  replay → `setConfigFile` + revalidate.
- `RevertDialog` stays the human-side save gate; checkpoints sit upstream
  on the working buffer. Makes undoing a *kept* decision reachable after
  the set clears.

### Editable pending (#2)
- Split `PendingDiffPane` into the review strip (kept verbatim: prev/next,
  "change i of n · file · [section]", one decision pair) + body.
- `paneModeFor` unchanged in shape; `'diff'` renders the strip above the
  NORMAL editable editor with pending tints injected as another overlay
  class, instead of the read-only `DiffLines` body. The whole-document
  pane law survives verbatim (the editor IS the whole document).
- `buildUnreviewedDiffModel` untouched — its frame-vs-live contract
  already produces the combined human+AI diff after hand edits.
- `buildHighlightedHtml` gains pending line ranges → tint class. Drift
  law: tints stay inline spans in the continuous `<pre>` (e482e63
  lesson); removals cannot get phantom rows (would shift the textarea
  rhythm) — v1 marks them at the gutter/stop level, full red/green
  fidelity stays in the explicit read-only view (chip → `'shown'`).
- Touched-hunk Undo: client compares live vs frame.after within the
  stop's range; if diverged, confirm "you edited these lines; undo takes
  them too," then existing replay.
- Takeover suppression rule (`selectionOverlapsChange` → chip) unchanged
  in v1 — relaxing it is a separate call now that takeover no longer
  blocks typing.

### Queue + stop (#3)
- Move generation ownership into aiStore (`inFlight`, `queued[]`,
  `abort()`); ChatInputBar renders queue with edit/remove/Send Now.
- Backend: nothing for queue-as-wait; consider abort pass-through so a
  disconnected request doesn't burn the local model's turn.

### Token meter + compaction (#4)
- Backend: pass provider usage through the chat response; compaction
  endpoint (summarize old turns with a utility model).
- Frontend: counter in ChatInputBar, expandable "Context Compacted"
  message kind, `/compact`, compacted-through marker in
  chatHistoryStore (display full, send from summary).

### Polish items
- Status line: new footer in TextEditor; derive line:col from the same
  `caretLineColumn` path completion uses (single source of truth).
- Gutter dots + current-line: overlay/gutter classes only; precedence
  designed once: current-line < pending < warning < error (one tint class
  per line, strongest wins).
- Accent audit: no behavior change; rides any round.
- Hover-reveal: ConfigTree `opacity` transition, width stable.

## 6. Sequencing

checkpoints → editable pending (#2, flagship) → queue/steer →
token meter/compact; multi-cursor and polish items are independent side
rounds. The cross-cutting constraint: #1, #2, and the gutter/current-line
polish all touch the overlay tint stack and changeSetReview decision
semantics — design tint precedence once, in the #2 round.

## 7. Status (2026-10-05)

- #2 (editable pending buffer) + current-line highlight: **planned,
  see .hermes/plans/** — first round implementing this list.
- All other items: considered, not scheduled.
