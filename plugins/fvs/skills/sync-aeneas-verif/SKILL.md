---
name: sync-aeneas-verif
description: Sync Aeneas/Charon upstream docs and reconcile the extraction blocker catalog via two specialised doc-sync agents
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
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
- This skill is invoked by mentioning `$fvs:sync-aeneas-verif`.
- Treat all user text after `$fvs:sync-aeneas-verif` as `{{FVS_ARGS}}`.
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

<purpose>
Keep FVS aligned with upstream Charon/Aeneas evolution along two axes, fanning out to the
`fvs-doc-syncer` worker in two modes:

- **tactics-lean-syntax** — today's tactic/Lean-syntax sync: the `_sync-meta.json` mapping plus
  the `tactic_renames` table, propose-each, reconcile-not-append.
- **extraction-docs** — the Charon/Aeneas EXTRACTION documentation plus a reconcile pass over the
  shipped blocker catalog: re-check each seed blocker against live upstream and flag
  retire / update-signature / still-open. Never blind-append, never silently overwrite the seed.

The command mines the config-driven LOCAL Charon + Aeneas clones (no hardcoded absolute paths),
resolving each clone path via config -> auto-detect -> prompt -> error, and reports clone staleness
gracefully (a stale clone is still mineable; staleness is reported, never a hard failure). On-demand
GitHub fetch is the fallback when in-repo docs are thin -- read-only fetch only; this command never
calls `gh` to OPEN or create an upstream artifact.

The user reviews and approves each proposed change individually. This is the clean-break successor
to the single-agent doc sync: it generalises the section-level-diff + propose-each machinery to two
specialised modes.
</purpose>

<execution_context>
@${CLAUDE_PLUGIN_ROOT}/fv-skills/workflows/sync-aeneas-verif.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/blocker-catalog.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/model-profiles.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/ui-brand.md
</execution_context>

<context>
Upstream sources (both AeneasVerif):
- Charon docs: `docs/{what_charon_translates,transformations,limitations}.md` + `README.md` +
  `CONTRIBUTING.md` + `.github/ISSUE_TEMPLATE/{bug_report,unsupported-language-feature}.md`.
- Aeneas docs: `documentation/*.md` + `documentation/skills/*.instructions.md` (the source-of-truth
  files, NOT the symlinks) + `README.md` + `tests/README.md`.
- Tactic/Lean-syntax mapping: `fv-skills/upstream/aeneas/_sync-meta.json`
  (the `mapping` array + the `tactic_renames` table).

Reconcile target: `fv-skills/references/blocker-catalog.md` -- the extraction-docs mode re-checks
seed blockers against live upstream and PROPOSES status changes in place. The seed stays
schema-conformant (evidence + pin_context present, no `tier`, `outcome_kinds` a list) and is never
silently overwritten.
</context>

<process>

## Step 0: Preflight the installed sync metadata

Resolve `_sync-meta.json` from the installed FVS tree before reading config, prompting for clone
paths, fetching upstream content, or dispatching a worker. The installer rewrites this
runtime-neutral source path for Claude, Codex, OpenCode, and Gemini:

```bash
SYNC_META="${CLAUDE_PLUGIN_ROOT}/fv-skills/upstream/aeneas/_sync-meta.json"

if [ ! -s "$SYNC_META" ]; then
  echo "FVS >> AENEAS SYNC METADATA MISSING"
  echo "The installed fv-skills/upstream/aeneas/_sync-meta.json mapping is absent."
  echo "Run /fvs:update, or run: npx fv-skills-baif@latest"
  echo "Choose your current runtime in the normal installer flow; there is no separate Aeneas option."
  exit 1
fi

node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!m.upstream_source || !Array.isArray(m.mapping) || !m.mapping.length ||
      !m.tactic_renames || typeof m.tactic_renames !== "object") process.exit(2);
' "$SYNC_META" || {
  echo "FVS >> Aeneas sync metadata is invalid. Run /fvs:update or npx fv-skills-baif@latest."
  exit 1
}
```

Do not offer or reference an "Aeneas install option": FVS installs the snapshot and mapping as part
of every normal runtime install. If the preflight fails, STOP before all later steps.

## Step 1: Read config and resolve subagent model

Read the project config and resolve the model for the `fvs-doc-syncer` dispatch using the
model-profiles dispatch sequence (config `model_overrides` first, then the profile table, then
`inherit` for unknown agents):

```bash
CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null)
# profile = config.model_profile || "balanced"
# SYNCER_MODEL = model_overrides["fvs-doc-syncer"] ?? PROFILE_TABLE["fvs-doc-syncer"][profile]
```

On Codex (which does not support dynamic model selection) the `model=` parameter is silently
ignored; the dispatches work unchanged.

## Step 2: Resolve the local clones (config -> auto-detect -> prompt -> error)

Resolve `charon_clone_path` and `aeneas_clone_path` with the locked FVS precedence. Never hardcode
an absolute clone path. Quote every path expansion, reject a path with shell metacharacters, and
never `eval` a path.

```bash
# 1. config value -- parse project.charon_clone_path / project.aeneas_clone_path from $CONFIG.
#    Use jq if available; `// empty` + 2>/dev/null degrade to an empty string when the key is
#    null/absent or jq is missing, so resolution falls through to auto-detect. Both may be empty.
CHARON_CLONE=$(printf '%s' "$CONFIG" | jq -r '.project.charon_clone_path // empty' 2>/dev/null)
AENEAS_CLONE=$(printf '%s' "$CONFIG" | jq -r '.project.aeneas_clone_path // empty' 2>/dev/null)
# 2. auto-detect: probe common sibling layouts (e.g. a BAIF_GH/{charon,aeneas} shape)
# 3. prompt the user for the path if still unresolved
# 4. error only if a clone cannot be resolved at all -- and even then, degrade:
#    report the missing source and continue the OTHER mode rather than aborting the run
```

Before any `git -C "<clone>"`, validate the resolved path is a directory:

```bash
[ -d "$CHARON_CLONE" ] || echo "FVS >> Charon clone path is not a directory: $CHARON_CLONE"
[ -d "$AENEAS_CLONE" ] || echo "FVS >> Aeneas clone path is not a directory: $AENEAS_CLONE"
```

## Step 3: Report clone staleness (graceful, never a hard fail)

For each resolved clone, compare its `git rev-parse HEAD` against the pin the project expects:
Charon against the rev in Aeneas's `charon-pin`; Aeneas against the lakefile-pinned rev. Report
`up-to-date` / `behind N` / `ahead N` / `diverged` -- a stale clone is still mineable.

```bash
CHARON_HEAD=$(git -C "$CHARON_CLONE" rev-parse HEAD 2>/dev/null)
AENEAS_PIN=$(grep -v '^#' "$AENEAS_CLONE/charon-pin" 2>/dev/null | tr -d '[:space:]')
# behind/ahead via git -C "$CHARON_CLONE" rev-list --count; "pin not in history" => diverged
```

```
FVS >> Clone Staleness

| Clone  | HEAD            | Expected pin     | Status     |
|--------|-----------------|------------------|------------|
| charon | {head:0:12}     | {pin:0:12}       | behind 3   |
| aeneas | {head:0:12}     | {lakefile rev}   | up-to-date |

Staleness is reported, not blocking -- mining proceeds against the clone as-is.
```

## Step 4: Fan out to fvs-doc-syncer in mode (a) tactics-lean-syntax

Dispatch the worker for today's tactic/Lean-syntax scope, inlining the `_sync-meta.json` mapping and
the `tactic_renames` table (the parent inlines all reference content; the worker uses no
@-references):

```
Task(subagent_type="fvs-doc-syncer", model="$SYNCER_MODEL",
     description="Sync tactics + Lean-syntax docs (mode a)",
     prompt="<sync_mode>tactics-lean-syntax</sync_mode>
             ...inlined _sync-meta.json mapping + tactic_renames + snapshot SHA + the
                resolved Aeneas clone path for local mining...")
```

The worker fetches mapped upstream files (local clone first, read-only `gh api` / `curl` fallback
when thin), computes a SECTION-LEVEL diff, maps changed sections via `merge_strategy`
(`enrich` / `replace_section` / `defer`), checks the `tactic_renames` table, and PROPOSES each
change for the user to approve / skip / edit. It updates the snapshot and `_sync-meta.json` at the
end.

## Step 5: Fan out to fvs-doc-syncer in mode (b) extraction-docs

Dispatch the worker for the extraction-docs scope + the blocker-catalog reconcile, inlining the
extraction doc targets and the current `blocker-catalog.md` seed:

```
Task(subagent_type="fvs-doc-syncer", model="$SYNCER_MODEL",
     description="Sync extraction docs + reconcile blocker catalog (mode b)",
     prompt="<sync_mode>extraction-docs</sync_mode>
             ...Charon docs/{what_charon_translates,transformations,limitations}.md + README.md +
                CONTRIBUTING.md + .github/ISSUE_TEMPLATE/*; Aeneas documentation/*.md +
                documentation/skills/*.instructions.md (source-of-truth, NOT symlinks) + README.md +
                tests/README.md; the resolved clone paths for local mining; the current
                blocker-catalog seed for the reconcile pass...")
```

The worker fetches the extraction docs (local clone first; on-demand read-only GH fetch only when
in-repo docs are thin, under evidence discipline), section-level-diffs them, then RECONCILES the
blocker catalog: re-check each seed blocker against live upstream and PROPOSE flagging it
retire / update-signature / still-open. "Fixed in upstream main" is NOT "fixed for us" -- an entry
stays `needs-manual-check` until the resolved pin is diffed against the fix; never auto-`retire`.
Never duplicate an entry whose `signature` already exists; update it in place. The user approves /
skips / edits each proposed change.

## Step 6: Report

Merge the two workers' return summaries:

```
FVS >> Sync Complete

| Mode                | Applied | Skipped | Notes                              |
|---------------------|---------|---------|------------------------------------|
| tactics-lean-syntax | {N}     | {M}     | {K} tactic renames propagated      |
| extraction-docs     | {N}     | {M}     | {R} catalog entries reconciled     |

Snapshot updated: {old_commit} -> {new_commit}

Run `npm test` to verify no frontmatter or structural issues.
```

</process>

<codex_skill_adapter>
On Codex, every interactive HALT in this command -- the clone-path prompt (Step 2) and each
propose-each approval the workers surface -- degrades to a plain-text question and WAITS for the
user. It is fail-closed: it never auto-picks a default, never auto-applies a change, and never
fetches or opens an upstream artifact without the read-only fetch being explicitly part of the sync.
The `Task(...)` dispatches survive intact (the `model=` parameter is silently ignored on Codex, per
model-profiles runtime handling).
</codex_skill_adapter>

<success_criteria>
- [ ] Clone paths resolved via config -> auto-detect -> prompt -> error; no hardcoded absolute path.
- [ ] Installed `_sync-meta.json` preflight passed; missing/invalid metadata stopped with real
      update/reinstall instructions (no nonexistent "Aeneas option").
- [ ] Clone staleness reported gracefully (never a hard failure of mining).
- [ ] `fvs-doc-syncer` dispatched in BOTH `tactics-lean-syntax` and `extraction-docs` modes.
- [ ] tactics-lean-syntax: `_sync-meta.json` mapping + tactic-rename machinery, propose-each.
- [ ] extraction-docs: Charon/Aeneas extraction docs synced; blocker catalog RECONCILED in place
      (no blind append, no auto-retire before the pin carries the fix).
- [ ] User approved / skipped / edited each proposed change individually.
- [ ] No `gh` auto-open/create anywhere; read-only fetch is the only GH path, and only as a fallback.
</success_criteria>
