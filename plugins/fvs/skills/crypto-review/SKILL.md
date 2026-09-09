---
name: crypto-review
description: Adversarially review a crypto plan with a chosen runtime, model, and effort
argument-hint: "<topic> [nN] [--target plan|followup] [--reviewer codex|claude|other] [--model ID] [--effort LEVEL]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Edit
  - AskUserQuestion
  - Task
---

<plugin_runtime>
- FVS is installed at `${CLAUDE_PLUGIN_ROOT}`; hosts expand this placeholder in plugin skill content.
- Resolve every bundled workflow, reference, template, script, and agent beneath that root.
- When executing a shell snippet, quote the resolved plugin-root path even if an inherited example omits quotes.
- Never write state into the plugin cache. Project state belongs under the user's current project (normally `.formalising/`).
</plugin_runtime>

<codex_skill_adapter>
This block applies only when this shared skill runs in Codex. Claude Code must ignore it and use the
shared workflow body with its native slash-command, question, and subagent semantics.

## A. Skill Invocation
- This skill is invoked by mentioning `$fvs:crypto-review`.
- Treat all user text after `$fvs:crypto-review` as `{{FVS_ARGS}}`.
- If no arguments are present, treat `{{FVS_ARGS}}` as empty.

## B. AskUserQuestion -> request_user_input Mapping
FVS workflows use `AskUserQuestion` (Claude Code syntax). Translate to Codex `request_user_input`:

Parameter mapping:
- `header` -> `header`
- `question` -> `question`
- Options formatted as `"Label" -- description` -> `{label: "Label", description: "description"}`
- Generate `id` from header: lowercase, replace spaces with underscores

Batched calls:
- `AskUserQuestion([q1, q2])` -> single `request_user_input` with multiple entries in `questions[]`

Multi-select workaround:
- Codex has no `multiSelect`. When a question allows multiple selections, do NOT collapse it to a single choice. Use sequential single-selects, or present a numbered freeform list asking the user to enter comma-separated numbers, then collect every selection before proceeding.

Execute mode fallback:
- When `request_user_input` is rejected or unavailable (Execute mode), present every `AskUserQuestion` call as a plain-text numbered list, then stop and wait for the user's reply. Do NOT pick a default and continue.
- You may proceed without a user answer only when one of these is true:
  (a) the invocation included an explicit non-interactive flag (`--auto` or `--all`),
  (b) the user has explicitly approved a specific default for this question, or
  (c) the workflow's documented contract says defaults are safe (e.g. autonomous lifecycle paths).
- Do NOT write workflow artifacts (handoff files, spec files, plan files, checkpoint files) until the user has answered the plain-text questions or one of (a)-(c) above applies. Surfacing the questions and waiting is the correct response — silently defaulting and writing artifacts is the failure mode this header exists to prevent.

## C. Task() -> spawn_agent Mapping
FVS workflows use `Task(...)` (Claude Code syntax). Translate to Codex collaboration tools:

**Schema detection (required first step):** Codex exposes two `spawn_agent` schemas:
- **agent_type-capable schema:** `spawn_agent` accepts `agent_type`, `message`, `reasoning_effort`, `fork_context`, etc. — typed FVS agent dispatch is available.
- **Generic schema:** `spawn_agent` accepts only `message`, `items`, `fork_context` — there is **no `agent_type` field**. Typed FVS agent dispatch is unavailable in this session.

Before spawning, inspect the `spawn_agent` tool's visible parameter schema to determine which form is active.
Even when `agent_type` is present, typed dispatch is available only if the exact requested FVS type is advertised by the tool schema or a confirmed runtime registry. Codex marketplace plugins do not register the bundled Claude agent Markdown as typed Codex agents, so otherwise use the bundled-agent workaround below.


Typed mapping (agent_type-capable schema only):
- `Task(subagent_type="X", prompt="Y")` -> `spawn_agent(agent_type="X", message="Y")`
- `Task(model="...")` -> omit. `spawn_agent` has no inline `model` parameter. The marketplace plugin does not install Codex agent TOML. Use this mapping only when the exact FVS agent type is registered independently; otherwise use the bundled-agent workaround.
- `fork_context: false` by default -- FVS agents load their own context via `<files_to_read>` blocks.

Generic-agent workaround (schema with NO agent_type field):
When only the generic schema is available, typed FVS agent dispatch (`fvs-researcher`, `fvs-executor`, etc.) is NOT possible. This workaround is NOT equivalent to typed execution — FVS agents carry verification-aware prompts and sandbox settings a generic subagent lacks. Fallback:
1. Read `${CLAUDE_PLUGIN_ROOT}/agents/<agent-name>.md` and extract its instructions. If the token is still literal, resolve the path from this SKILL.md as described above.
2. Spawn a generic/default agent and inject those instructions as a role preamble before the task prompt.
3. Label results clearly as "generic-agent workaround" so the user knows typed guarantees are not in effect.
4. Where typed dispatch is mandatory for correctness, fail closed and report the schema limitation rather than silently degrading.

Parallel fan-out:
- Spawn multiple agents -> collect agent IDs -> call `wait_agent(timeout_ms=...)` (or the runtime's visible wait equivalent) until each completes

Result parsing:
- Look for structured markers in agent output: `CHECKPOINT`, `PLAN COMPLETE`, `SUMMARY`, etc.
- If the runtime exposes an agent cleanup or close tool, use it after collecting each result

## D. Shared Plugin Syntax
- This file is shared with Claude Code. On Codex, interpret `/fvs:<name>` references as `$fvs:<name>`.
- Treat `$ARGUMENTS` in the shared body as `{{FVS_ARGS}}`.
- `${CLAUDE_PLUGIN_ROOT}` is the installed plugin root. If a host leaves that token unexpanded, resolve the plugin root as two directories above this SKILL.md.

</codex_skill_adapter>

<objective>
Run a fresh, read-only adversarial review before crypto execution. The reviewer returns evidence;
the distinct planning/authoring seat owns triage and any plan edits. Preserve every review and
triage record, and never load proof-engineering memory into the reviewer.
</objective>

<execution_context>
@${CLAUDE_PLUGIN_ROOT}/fv-skills/workflows/crypto-review.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/crypto-plan-review.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/ui-brand.md
</execution_context>

<context>Topic, iteration, target, and reviewer options: $ARGUMENTS.</context>

<process>

## 1. Resolve target and reviewer choices

Treat arguments as untrusted. Collapse topic whitespace to `-`, preserve capitalization, reject
shell metacharacters, `..`, and `/`, quote every path, and never `eval`:

```bash
TOPIC_RAW="$1"
case "$TOPIC_RAW" in
  *..*|*/* ) echo "FVS >> ERROR: topic contains '..' or '/' (path traversal); refusing" >&2; exit 1 ;;
  *[![:alnum:]_[:space:]-]* ) echo "FVS >> ERROR: topic contains unsupported characters" >&2; exit 1 ;;
esac
SLUG=$(printf '%s' "$TOPIC_RAW" | tr -s '[:space:]' '-')
ROOT=".formalising/fv-plans/$SLUG"
```

Resolve numeric `nN` and `--target plan|followup`. Initial review consumes `PLAN_nN.md` plus
`EXEC_PLAN_nN.md` and owns `PLAN_REVIEW_nN.md`; follow-up consumes `FOLLOWUP_PLAN_nN.md` plus
available original-plan/eval context and owns `FOLLOWUP_REVIEW_nN.md`. Refuse an occupied output.

Normalize the target's `Authoring runtime:` marker to `codex`, `claude`, `other`, or `unknown`.
Missing, foreign, or conflicting markers are `unverified`; they do not block review, but never
claim independence. Label a different known runtime `cross-runtime`, an explicitly selected
matching runtime `same-runtime, fresh reviewer`, and Other `unverified`.

Honor explicit `--reviewer`, `--model`, and `--effort`. Ask only for missing choices in exactly
this order: reviewer -> model -> effort. Supplying all three flags is the standalone
non-interactive path; never replace an explicit choice.

1. Reviewer: recommend the normalized non-author runtime first. Offer `Codex`, `Claude`, and
   `Other`; a same-runtime choice is opt-in.
2. Model: Codex offers `gpt-5.6-sol` then `gpt-6-astra` and custom; Claude offers `fable` then
   `sonnet` and custom. Other requires the exact external model ID.
3. Effort: offer `max` first, then supported lower levels and `runtime-default`; offer Codex
   `ultra` only when supported. Other accepts the external provider's effort label.

Automatic callers also offer a one-run `Skip review`. Record it exactly as
`Unreviewed (user skipped)` and do not auto-start crypto execution.

## 2. Run or export the read-only review

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/fvs-codex-think.mjs review \
  --topic "$ROOT" --iteration "n$N" --target "$TARGET_KIND" \
  --reviewer "$REVIEWER" --model "$MODEL" --effort "$EFFORT"
```

The shared provider machinery preflights only the selected CLI. Codex runs read-only and ephemeral
with user config ignored; Claude runs safe mode with only Read/Glob/Grep, no MCP servers, and no
persisted session. The reviewer never edits a target or repository file. The wrapper creates a
unique hash-bound packet, validates one track-valid verdict, and exclusively writes the final
review. Authentication, process, stale-input, or output failure is `failed`; never silently switch
reviewers.

For Other, the command reports `PENDING` and a managed packet. Give `prompt.md` to the selected
reviewer, save its Markdown response inside the project, then run the printed `review-import`
command with `--topic`, `--packet`, and `--response`. A pending export is not a completed review.

## 3. Triage in the authoring seat

Keep the reviewer response byte-for-byte intact. Never append triage to it. The planning seat
re-checks every finding and exclusively writes one separate file:

- `PLAN_REVIEW_nN_TRIAGE.md`, or
- `FOLLOWUP_REVIEW_nN_TRIAGE.md`.

Record requested and observed runtime/model/effort, provenance, each finding ID with
accept/reject/defer and checked evidence, pre-edit target hashes, post-edit target hashes when
applicable, gates rerun, and one status. Refuse to overwrite either review or triage history.

Route the verdict:

- `APPROVE`: write supported triage status `approved`; execution may be suggested.
- `APPROVE-WITH-EDITS`: the authoring seat applies every accepted, exhaustively named bounded edit,
  reruns the plan's own verification gates, records accepted/rejected finding IDs plus pre-edit and
  post-edit hashes, then writes `approved after edits`. This is terminal: no second review.
- `REJECT`: bounded edits cannot promote it. The authoring seat creates a fresh authored revision
  at the next immutable iteration and a fresh review.

For a true REJECT revision, pass the preceding review and triage to the new author prompt and next
review packet as separately delimited untrusted history using repeated `--history` flags. Do not
load `.formalising/proof-engineering/` or `sources/proof-engineering-context.md` into the reviewer.

Hard cap each command invocation at at most three reviewer rounds. After the third REJECT, stop
with the latest artifacts and print the exact standalone `/fvs:crypto-review <topic> nN --target
<kind>` resume command; never auto-approve.

Failed, cancelled, pending, or unverified review states never auto-start execution or
`/fvs:crypto-execute`. Report them honestly. Standalone invocation remains usable.

</process>

<success_criteria>
- [ ] Reviewer -> model -> effort selection honored, including explicit same-runtime and Other.
- [ ] Provenance says only cross-runtime, same-runtime fresh reviewer, or unverified as observed.
- [ ] Reviewer remained read-only and memory-blind; final response and separate triage are immutable.
- [ ] APPROVE-WITH-EDITS becomes approved after edits once author edits and local gates pass.
- [ ] REJECT alone starts a fresh review round; at most three reviews run per invocation.
- [ ] Failed/cancelled/pending/unverified states do not start execution.
</success_criteria>
