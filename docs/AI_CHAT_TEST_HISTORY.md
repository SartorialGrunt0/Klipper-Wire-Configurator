# AI Chat — Test History

Dated experiment forensics from the AI Chat accuracy harness work, moved
verbatim out of `AI_CHAT.md` during its 2026-10-24 rewrite. This file is the
archive: the *outcomes* of these experiments live in `AI_CHAT.md`; the
per-run detail lives here. Reports referenced as `reports/ai-chat-accuracy/…`
are gitignored local run artifacts.

---

## Bank106 baselines (2026-09, older bank — mostly superseded)

Full 106-question bank on `improvement/ai-chat-edit-refactor` @ `9c6bdf4`, native
tool protocol, `--max-tokens 8192 --temperature 0.7`, edit tools on, one model per
run (runs under `reports/ai-chat-accuracy/bank106-r1-*`). These numbers still
carry the four round-1 harness false negatives and the four round-2 ones:

| Model | Host | PASS | Rate | Errored |
| --- | --- | --- | --- | --- |
| gemma-4-12b | CachyPC | 97/106 | 92% | 0 |
| qwen3.6-35B-A3B | Thor | 97/106 | 92% | 0 |
| gemma-4-26B-A4B | Thor | 97/106 | 92% | 1 |
| gemma-4-e4b | CachyPC | 91/106 | 86% | 0 |
| qwen3.5-4b | CachyPC | 90/106 | 85% | 0 |
| qwen3.8-27B | Thor | 89/106 | 84% | 12 |
| qwen3.5-9b | CachyPC | 86/106 | 81% | 0 |

Errored = per-request failure (provider 5xx or the 600 s timeout), not a model
miss. Errored qids were re-run where possible; `qwen3.8-27B` kept 12 timeouts
(its 600 s loops), so its row is understated — 3 of its misses are `COMMENT` and
1 is `RENAME`, families where the shortfall is infra, not quality. `gemma-4-26B-A4B`
has one genuine repeat-timeout (`AMBI-02`).

### Updated (post-fix)

Eight harness false negatives were corrected across two rounds (2026-09-28 →
09-29, see below), plus one premise-conflict question reworded (`SETUP-02`). The
bank edits touched **nine qids and nothing else**, so re-running those nine on a
model settles its whole score: every other qid's verdict is unaffected by
construction. Runs: `bank106-r2-spotfix-*`.

| Model | Host | Baseline | Updated | Evidence |
| --- | --- | --- | --- | --- |
| gemma-4-12b | CachyPC | 97/106 | **102/106** | **full bank re-run** — measured |
| gemma-4-26B-A4B | Thor | 97/106 | **102/106** | 9-qid spot (+5) |
| qwen3.6-35B-A3B | Thor | 97/106 | **100/106** | 9-qid spot (+3) |
| qwen3.5-4b | CachyPC | 90/106 | **95/106** | 9-qid spot (+5; `Q19` recovered from a provider 500) |
| gemma-4-e4b | CachyPC | 91/106 | **93/106** | 9-qid spot (+3, −1: `SETUP-02`) |
| qwen3.8-27B | Thor | 89/106 | **93/106** | 9-qid spot (+4; 3 were infra ERRORs, 9 timeouts still unmeasured) |
| qwen3.5-9b | CachyPC | 86/106 | **88/106** | 9-qid spot (+3, −1: `MACRO-01`) |

`gemma-4-12b` was re-run on the **full** bank to check the method: 102/106, 0
errored, exactly the spot projection. Its seven flips up are `MACRO-01`,
`TRIDENT-10`, `AMBI-07`, `SETUP-05`, `COMMENT-03` (the fixes) plus `COMMENT-02`
and `SKILL-N01` (variance — neither was edited either round); the two down
(`MACRO-03`, `AMBI-02`) are variance on untouched qids. Its four remaining
non-passes are `MACRO-03` (fixed the macro correctly but staged it into a NEW
`fix_me.cfg` + include — the criterion's `any_of` covers staging into
printer.cfg or a display block, not a third file), `AMBI-02` (the registry
kickback refused the new file and the model went on to stage 12 section
**deletions** in printer.cfg — partial, and destructive in effect if approved),
`SKILL-N04` (the open nudge question) and `ACK-N01` (conditional pass, no tool
needed).

Per-defect flips across all seven models: `COMMENT-03` +5, `SETUP-05` +5,
`TRIDENT-10` +4, `MACRO-01` +3, `Q19` +3, `Q04` +2, `TOOL-05` +2, `AMBI-07` +1,
`SETUP-02` +1 (against one regression each on `SETUP-02` and `MACRO-01`).
`±1` on a single run is noise on this bank — only consistent, directional
movement is evidence.

## Family detail (bank106 baseline run, pre-fix)

| Model | Q | MACRO | TRIDENT | HARNESS | MINIDIFF | AMBI | SETUP | LIVE | EDIT | RENAME | COMMENT | SKILL | SKILL-N | TOOL | ACK | ACK-N |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemma-4-12b | 19/19 | 9/10 | 15/16 | 2/2 | 4/4 | 7/8 | 4/5 | 7/7 | 6/6 | 3/3 | 4/6 | 5/5 | 2/4 | 8/8 | 2/2 | 0/1 |
| qwen3.6-35B-A3B | 18/19 | 10/10 | 15/16 | 2/2 | 4/4 | 8/8 | 3/5 | 6/7 | 6/6 | 3/3 | 5/6 | 4/5 | 3/4 | 8/8 | 1/2 | 1/1 |
| gemma-4-26B-A4B | 18/19 | 9/10 | 15/16 | 2/2 | 4/4 | 6/8 | 4/5 | 7/7 | 6/6 | 3/3 | 5/6 | 4/5 | 4/4 | 8/8 | 2/2 | 0/1 |
| gemma-4-e4b | 18/19 | 8/10 | 13/16 | 2/2 | 3/4 | 6/8 | 4/5 | 7/7 | 5/6 | 3/3 | 4/6 | 4/5 | 3/4 | 8/8 | 2/2 | 1/1 |
| qwen3.5-4b | 18/19 | 9/10 | 13/16 | 2/2 | 3/4 | 6/8 | 4/5 | 7/7 | 5/6 | 3/3 | 5/6 | 4/5 | 3/4 | 6/8 | 2/2 | 0/1 |
| qwen3.8-27B | 16/19 | 7/10 | 16/16 | 2/2 | 4/4 | 3/8 | 3/5 | 7/7 | 6/6 | 2/3 | 3/6 | 5/5 | 4/4 | 8/8 | 2/2 | 1/1 |
| qwen3.5-9b | 16/19 | 8/10 | 15/16 | 2/2 | 3/4 | 7/8 | 3/5 | 7/7 | 5/6 | 2/3 | 3/6 | 4/5 | 3/4 | 6/8 | 2/2 | 0/1 |

Movement against the previous 94-Q baseline, on the **94 overlapping qids** (all
four documented models re-measured on the same host, so this is apples-to-apples):

| Model | New | Old | Δ |
| --- | --- | --- | --- |
| gemma-4-12b | 88/94 | 92/94 | **−4** |
| qwen3.5-4b | 80/94 | 78/94 | +2 |
| gemma-4-e4b | 81/94 | 77/94 | +4 |
| qwen3.5-9b | 79/94 | 73/94 | **+6** |

gemma-4-12b is the only genuine regression; its losses concentrate in `SKILL-N01`
(skill false-positives 1/4 → 2/4) plus two of the harness false negatives above.
`TRIDENT-15` — previously the all-model failure — now passes on 5 of 7.

Failure modes seen across the models (from their traces):

- **Staged but not what was asked** (the dominant mode) — the model picks a
  blunter operation than the case needs (`replace_section` or `set_param`
  where an anchored `patch_section` is required) and the staged text misses
  the required line. This is what fails `EDIT-02` / `MINIDIFF-01` / `SKILL-02`
  (the `level_bed` adaptive-anchor trio) on 4 of 7 models. Verified genuine
  against Klipper's own source: `bed_mesh.py` gates adaptive mode on
  `gcmd.get_int('ADAPTIVE', 0)`, so `adaptive=true` is invalid and
  `adaptive_margin` alone does **not** enable it. Only gemma-4-12b writes the
  documented `ADAPTIVE=1`.
- **Skill gate fires on an explicit "don't change my files"** — `SKILL-N04`
  ("Draft me a PARK_X macro… Don't add it to my config"). 5 of 7 models load
  the editing skill and 4 of 7 stage an edit anyway. Traced end-to-end: the
  model writes the draft, the backend fires its edit-prose nudge, and the
  nudge's leading exception — *"Unless the user explicitly said NOT to change
  their files…"* — is honoured by only 1 of 7 (qwen3.8-27B, the only pass).
- **Over-clarification** — qwen3.8-27B alone refuses to stage on `Q14`, `Q17`
  and `MACRO-02`, because each question's premise contradicts the real Trident
  fixture (a `[bed_mesh]` already exists; `PRINT_START` is heavily customised).
  Safe behaviour, scored as a miss — a question-design question, not a bug.
- **Runaway tool loops** — qwen3.8-27B burned 21 tool calls and 108k characters
  of context on `MACRO-03`, a question about a 7-line macro, and hit the
  10-minute request ceiling. 12 of its 106 questions timed out this way; every
  other model had ≤3 request errors.
- **Registry kickback not re-sent** — `AMBI-02` / `AMBI-03`: an unknown gcode
  command (`CLEAN_NOZZLE`, `SMART_PARK` from plugins) kicks the write back
  unstaged, and the design needs an *identical* resend to pass. Most models
  narrate the rejection and stop instead.
- **Nothing staged after burning the retry budget** — the model keeps re-sending
  variations the server rejects, then lands on the soft-landing summary. The
  write-attempt cap keeps this honest, but the loop is not converging for the
  smaller models.

**Harness false negatives — FIXED 2026-09-28, awaiting re-run.** Four were
found by auditing every repeat failure against the real artifacts, and are now
corrected in the harness:

- `AMBI-07` graded the reply *prose* for a numeric assignment, so a correct
  staged edit FAILed whenever the model wrote "added to `[extruder]`". The
  explanation half stays prose; the edit half is now `staged_regex`. This
  flipped 2 false negatives to PASS **and 1 false positive to FAIL** (a model
  that explained but staged nothing used to pass).
- `MACRO-01` demanded `G1…X0` and rejected `G0`, which the bundled Klipper docs
  define as the same command ("Move (G0 or G1)").
- `Q19`'s clarifying-question regex did not match "I'll need some basic hardware
  details… paste them here".
- `COMMENT-03` asked for `max_accel` — a *required* `[printer]` parameter — to be
  commented out, which the validator correctly refuses to stage; passing needed
  an unstated two-part swap (1 of 7 managed it). Retargeted to the optional
  `max_z_velocity`.
- The rename criteria matched the macro **name** case-sensitively
  (`[gcode_macro LEVEL_BED1]`), but Klipper upper-cases the alias
  (`gcode_macro.py`: `self.alias = name.upper()`) and the command token before
  dispatch, so `Level_Bed1` and `LEVEL_BED1` are the *same* command. Those
  checks now use `staged_header` — type token exact (it resolves to a module
  filename, so `[Gcode_Macro …]` genuinely fails to load), instance name
  case-insensitive.

Two latent scoring gaps were closed at the same time: `staged_param` was
case-sensitive while `staged_regex` is not (Klipper normalises gcode param names
and config option names, so those checks are now `staged_param_ci` — section
headers deliberately stay case-sensitive), and `not_staged` was file-scoped, so
a "don't change my files" request passed when the model edited a *different*
file (`not_staged_any` closes it).

Validation and evidence: `reports/ai-chat-accuracy/bank106-r1-criteria-audit.md`;
re-check any of it offline with `scripts/validate_criteria_offline.py`.

**Harness false negatives, round 2 — FIXED 2026-09-29, awaiting re-run.** A
second pass audited the remaining non-PASS slots across all seven runs and
found four more defects (all on failures that repeat on ≥2 models), plus two
product defects the bank cannot see:

- `Q04`'s list regex accepted only `-` bullets and bare filenames, so
  `* **Config_Reference.md**` and `**\`Config_Reference.md\`**` (bold wrapping
  code) — both naming five real docs — were scored FAIL.
- `SETUP-05`'s criterion was file-scoped to `printer.cfg`, but the fixture's
  `[respond]` lives in `mainsail.cfg:61` (empty). Driving the real `EditSession`
  (`scripts/probe_setup05_respond_routes.py`) shows `add_section` in
  `printer.cfg`, `set_param` and `replace_section` in `mainsail.cfg` all stage
  cleanly, so the arm now accepts either file.
- `TRIDENT-10` asked for a **display** block ("return the corrected macro in a
  fenced cfg code block with a '# file: printer.cfg' hint line") while the
  criteria graded the staged artifact. 5 of 7 models followed the instruction
  with a perfect fix and FAILed; the prompt now asks for the edit, like every
  other artifact-graded qid.
- `TOOL-05`'s header arm graded the reply prose, but the deliverable there is
  the *tool's* return value: two models called `generate_macro_template` with
  `include_bed_mesh: true` and the tool returned the full
  `[gcode_macro PRINT_START]` body, while their prose only described it. New
  `tool_output_regex` criterion kind grades `toolCalls[].output`.
- Two questions were re-worded for premise conflicts (`SETUP-02` asks for a
  *change* now; `SETUP-05` names the target state), the same family as
  `COMMENT-03`. `Q17` / `MACRO-02` / `Q14` have the same shape and are left
  as-is pending a decision.

Offline validation (`scripts/validate_criteria_offline.py`, now with 15
negative controls): **6 new verdict flips, all intended, 0 controls wrongly
passing** — the widening did not touch a single unaffected qid. `TRIDENT-10`
and `SETUP-02` cannot be replayed (their question text changed), so they need
the live re-run.

**Round-2 spot re-run — MEASURED.** The 9 qids touched by rounds 1–2 were
re-run on all seven models (same hosts and flags, `bank106-r2-spotfix-*`, after
restarting the backend at 10:02 so it served the fixed code):

| model | before | after | Δ |
| --- | --- | --- | --- |
| gemma-4-12b | 4/9 | **9/9** | +5 |
| qwen3.5-4b | 2/9 | **7/9** | +5 |
| gemma-4-26B-A4B | 3/9 | **8/9** | +5 |
| qwen3.6-35B-A3B | 5/9 | **8/9** | +3 |
| qwen3.8-27B | 4/9 | **8/9** | +4 (3 were infra ERRORs) |
| gemma-4-e4b | 5/9 | **7/9** | +2 |
| qwen3.5-9b | 4/9 | **6/9** | +2 |
| **total** | **27/63** | **53/63** | **+26** |

No errored qids in any leg. Per-defect: `COMMENT-03` +5, `SETUP-05` +5,
`TRIDENT-10` +4, `MACRO-01` +3, `Q19` +3 (1 criteria, 2 infra), `Q04` +2,
`TOOL-05` +2, `AMBI-07` +1, `SETUP-02` +1. **These 9 qids are now measured and
the rest of the table above still is not.**

Two regressions surfaced, and one of them is a criterion contradicting the
product's own rule: `SETUP-02` — the fixture defines `[idle_timeout]` in BOTH
`printer.cfg` and `Hotkey.cfg`, and **4 of 6 models edit the `Hotkey.cfg` copy**
(one citing load order). KWC's validator agrees with them:
`severity=info, code=project_duplicate, "Section [idle_timeout] is defined
multiple times in this file — the later definition wins"`
(`scripts/probe_duplicate_idle_timeout.py`). The criterion only accepts
`printer.cfg`, so models behaving the way the app itself describes are scored
FAIL. `MACRO-01` failed qwen3.5-4b on a *parameterised* park
(`params.PARK_X|default(0)`, the idiom KWC's own `PAUSE` template uses) while
demanding a literal `X0`.

Product fixes shipped with the same work, both model-agnostic:

- **Staged work no longer reports as a failure.** When a request ends with no
  visible text, the reply used to be *"I wasn't able to generate a response.
  Please try rephrasing your question."* — which hit **11 qids in one model's
  run, every one with a validated edit waiting for review**. The fallback now
  names the staged changes ("I staged 1 change to printer.cfg for your
  review…") and keeps the old wording only when nothing was staged.
- **Orphan tool-call markup no longer reaches the bubble.** Three replies
  carried the *tail* of a native call (`<parameter=…>…</parameter>`,
  `</function>`, `”)`) that every opener-anchored cleanup regex
  missed — one of them was the entire reply. `TOOL_RESIDUE_RE` strips those
  fragments and, when nothing else survives, routes the reply into the empty
  fallback above instead of showing raw markup.

Evidence for the second round (per-qid verdicts, the probe output, and the
replay diff): `reports/ai-chat-accuracy/bank106-r1-failure-states.md`.

## R1: realized-change reporting (2026-10-18, 111-qid bank, gemma-4-12b)

Success results now report the REALIZED change, not the intended one
(`feat(ai-edit) 1774bac`): ≤12 changed lines show a mini-diff under the
summary; larger ops collapse to `+A/−R` counts with removed lines verbatim;
deletes name lines without re-shipping the block; clean batch ops stay lean
(failed-then-retried ops show their diff). Both arms run with the
loop-exit kickback DISARMED (`--completion-check off`, the new harness
default for bank runs). **Archive note (2026-10-25): the
`--completion-check` flag and the kickback mechanism were both removed
on 2026-10-23 (`995dae2`/`895b05e`) — this command line is historical
evidence, not reproducible on the current build.**

Arms: baseline = `3ead333` worktree (pre-R1), R1 = tip `1774bac`;
`reports/ai-chat-accuracy/{r1base-bank111, r1-bank111}/`.

| Arm | PASS | fixed | regressed | avg turns | avg tok |
| --- | --- | --- | --- | --- | --- |
| baseline `3ead333` | 103/111 | — | — | 3.15 | 1004 |
| R1 tip | 105/111 | `BULK-02` `Q14` `Q16` `TRIDENT-15` | `AMBI-02` `MACRO-03` | 3.18 | 1066 |

Net +2 on the 110-qid overlap. The two regressions are the SAME two qids
this doc already flags as gemma's run-to-run variance (`MACRO-03` stages
into a third file; `AMBI-02` registry-kickback refusal shape) — single-run
±1 noise by the rule above, not R1-attributable. The four fixes are all
staged-content misses (a swept LED line, two staged-section gaps, BULK-02
coverage) consistent with the recognition-gap thesis: seeing the realized
diff let the model close gaps the intent summary hid. Context cost +6%
avg completion tokens, turns flat. Single-run evidence; BULK-04 still
fails in both arms (known pin-map construction issue, tracked separately).

## Guard A/B: echo kickback vs fresh-context judge (2026-10-19, gemma-4-12b)

Both arms on the SAME tip (`58c416f`), guard ARMED both arms, only the
mechanism differs: echo = the shipped kickback (worker re-answers its
own close against the ledger); judge = independent fresh-context audit
(request + ledger, no worker transcript, quote-validated `continue`,
verdict cap 2, fingerprint-unchanged skip). Harness-only selector
`completionGuard`; product default remains kickback (as of that run —
both arms were removed 2026-10-23, `a372b5b`/`995dae2`; the selector no
longer exists).
`reports/ai-chat-accuracy/{guard-echo-ab, guard-judge-ab}/`.

| Arm | PASS | fixed | regressed | avg turns | avg tok | wall |
| --- | --- | --- | --- | --- | --- | --- |
| echo | 103/111 | — | — | 3.38 | 1297 | 1469 s |
| judge | 105/111 | `BULK-01` `BULK-05` `MACRO-07` | `COMMENT-04` | 3.15 | 1225 | 1540 s |

Mechanics: the judge graded 34 closes (16 `done`, 18 `continue`); the
echo kicked 30. Every continue ended at grade #1 (the cap / fingerprint
skip fired — no ping-pong seen). `BULK-01` passed after a continue +
fingerprint-flag close. Turns flat-to-down (3.38→3.15): the judge
replaces the transcript-heavy worker reclose with a ~1 KB fresh call,
so measured tokens are down ~6% while wall time is up ~5% (one extra
round on 18 continues). The lone regression (`COMMENT-04`,
rename_existing uncomment) is the bank's known ±1 single-run shape.

Caveats before crediting: single run each, same-day host; judge verdicts
that fired on eventually-PASS questions prove co-occurrence, not
causation, per-fire. The direction is right (bulk families 2/5→4/5,
zero ping-pong, cost neutral) — this is the evidence to flip the product
default per plan 2.4's gate, but only after the next bank round or a
repeat confirms it. Judge model = worker model here (gemma grading
gemma); `KWC_JUDGE_MODEL` targeting a stronger auditor is untested.

## Judge payload A/B: labels vs dump (2026-10-19, gemma-4-12b)

`completionJudgePayload: dump` adds the deterministic facts the labels
arm lacked: PROJECT INVENTORY (live section headers per file) + CURRENT
TEXT OF EDITED FILES (post-edit state, caps). Same trigger, same rules.
`reports/ai-chat-accuracy/{guard-judge-ab, judge-dump-ab}/`.

| Arm | PASS | fixed | regressed | judge fires | continue | flagged |
| --- | --- | --- | --- | --- | --- | --- |
| labels (`guard-judge-ab`) | 105/111 | — | — | 34 | 18 | 17 |
| dump (`judge-dump-ab`) | **106/111** | `COMMENT-04` `MACRO-02` | `TRIDENT-03` | 33 | **9** | 8 |

Net +1 against labels; mechanism matters more than the count. **More
evidence made the judge more confident, not more trigger-happy**: `done`
16→24 while `continue` fell 18→9. The labels arm's over-strict class
(invisible reads graded as skipped work, e.g. Q16's "no docs search
staged") largely disappears when the auditor sees current file text.
The 9 remaining continues are now *factual* gaps (staged 0 edits vs a
delete ask — TRIDENT-03's quote names the instructed shape the ledger
contradicts).

`TRIDENT-03` (the regression) is instructive: dump judge said
`continue` (deletion asked, ledger shows 0 edits); the worker's reclose
still didn't stage the delete → delivered flagged → FAIL on
`staged_section_absent`. The labels arm got PASS by never judging.
That's honest under-delivery, flagged — the guard did its job; the
worker's reclose didn't.

Cost: dump judge payloads avg 8.4 KB (5.4–11 KB observed) vs ~1.2 KB
labels, on ~1/3 of questions — invisible against worker context.
`COMMENT-04` fixing itself is the thesis in one qid: `rename_existing`
is content, and content is exactly what the dump made gradeable.

Single runs; the net-1 stays noise-adjacent — but the verdict-mix shift
(done↑ continue↓ flagged 17→8, no ping-pong) is mechanism evidence in
the same direction as the guard A/B. Dump mode is the sharper, calmer
auditor. Next lever unchanged: `KWC_JUDGE_MODEL` on a stronger auditor.

## Judge outbound contract: assertive actions list (2026-10-19)

The continue nudge is now an instruction, not a quotation. Judge schema:
`actions: [{text, file, quote, evidence}]` — `text` is ONE imperative
(<20 words, names file/section/key), `quote` (verbatim from the USER
request) stays the anti-loop-extension law, `evidence` (verbatim from
the dump) is new and log-only. `parse_verdict` normalizes both shapes
(legacy `remaining` still accepted); a `text`-less action falls back to
its quote. `continue_directive_text` renders the worker-facing block
with NO judge voice and NO justification:

```
Verdict: needs work

Complete these actions now. Do not continue, re-answer, or declare
done without addressing each one:

Actions:
- add a purpose comment as the first line inside [pause_resume] [bulk.cfg]
```

Action-text dedupe (`_judge_injected`): a repeat verdict re-listing an
already-injected action cannot re-extend the loop with an identical
instruction. Live gemma emits explicit JSON nulls for unused fields —
parse uses `or ""` everywhere (a `needs_user` + `question: null` would
previously have delivered the literal string "None" to the user).

Smoke (`reports/ai-chat-accuracy/judge-actions-smoke/`, gemma worker +
gemma judge, dump mode): BULK-03 5/5 PASS — 3 graded `done` in ~7s on
the correct sweep close, 2 slipped via continue-intent tails. Live
`continue`s captured on Q16/MACRO-11/BULK-05: judge actions are
imperative and file-named ("add a purpose comment as the first line
inside [pause_resume] in bulk.cfg", evidence `[pause_resume]` copied
from the dump) — the contract works end-to-end. Both continues ended
fingerprint-unchanged (worker re-answered verbatim, delivered+flagged):
the nudge is assertive but a worker that ignores it still lands on the
flag path, unchanged law.

**Gap found (open, not fixed):** a close ending on a continue-intent
tail ("I will now check Knomi.cfg…") is exempted from the completion
check by `_ends_with_continue_intent` (the ack guard's case), but the
ack guard requires NO write tool fired — so a partial sweep that wrote
printer.cfg and promises the other files next falls through every
guard, judge included. 2 of 5 BULK-03 closes took exactly that exit
(they still passed the criteria; the promise was a lie the harness
never checked). Candidate: let the judge arm grade continue-intent
closes too — the fresh-context auditor doesn't need the echo's
exemption. Awaiting Sir's call.

## Full bank, actions-contract judge (2026-10-19, gemma-4-12b)

First full-bank run of the assertive actions contract (`b18f254`),
`reports/ai-chat-accuracy/judge-actions-full/`. Arm identical to
`judge-dump-ab` except the verdict/directive shape.

| Arm | PASS | fixed | regressed | fires | done/continue | flagged |
| --- | --- | --- | --- | --- | --- | --- |
| dump (`judge-dump-ab`) | 106/111 | — | — | 33 | 24/9 | 8 |
| actions (`judge-actions-full`) | 103/111 | `BULK-02` `COMMENT-06` `SKILL-N04` `TRIDENT-03` | 7 (below) | 34 | 22/12 | 10 |

−3 sits AT the ±3 single-run noise bound for this bank/model, and the
regressions do NOT attribute to the judge: **5 of 7 fired no judge at
all** (`SKILL-N01` `TRIDENT-15` `TRIDENT-16` `AMBI-07` `BULK-04`) —
pure worker variance closing through the known exemptions (TRIDENT-15
= documented model variance; TRIDENT-16/15 closes landed on ```cfg
fences = inert-draft-territory exemption; AMBI-07/BULK-04 closes ended
on clarify tails). `MACRO-02` = the documented decision-stall family
(offer-two-options-and-ask close). Only `AMBI-02` is judge-adjacent:
judge said continue (correctly — move asked, macros still in place),
the worker re-answered verbatim, fingerprint short-circuit delivered
flagged — honest under-delivery, same shape as the dump arm's
TRIDENT-03, which THIS run fixed. No ping-pong (every continue closed
at cap/fingerprint), cost +7% tok, one ERROR row = `ACK-N01`
PASS_NO_TOOL bookkeeping, same in both arms.

Mechanism read: the actions shape did NOT make the auditor twitchy in
the dangerous direction (continues 12-vs-9 lands inside noise; 10 of
12 continues rode on eventually-PASS questions), but it also did not
yet demonstrate worker OBEDIENCE — most continues still ended
fingerprint-unchanged (worker repeats verbatim). The assertive nudge's
value prop is currently the flag honesty, not reclose conversion;
per-fire causation stays unclaimed per the standing caveat.

Product bug found + fixed same day (AMBI-02 footer): the flag footer
rendered the shared request-QUOTE per action — five macros sharing one
quote printed the same sentence 5× to the USER. `flag_footer_text` now
renders deduped ACTION texts (imperative, what the worker failed to
do), falling back to quote for legacy items. Test:
`test_flag_footer_renders_actions_not_repeated_quotes`.

Repeat-sample note (standing law): one run each — before crediting or
blaming the contract vs the labels-quote dump arm, re-run or use the
continue-intent exemption fix (now backed by 5 regressed closes that
escaped through exactly that hole) as the next lever.
