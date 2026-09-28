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

**Schema detection (required first step):** Inspect the visible `spawn_agent` schema. It may have `agent_type` or be generic (no `agent_type`); inspect `model` and `reasoning_effort` fields independently rather than assuming either exists. An available `agent_type` field does not establish that a particular FVS role is registered.

Before spawning, inspect the `spawn_agent` tool's visible parameter schema to determine which form is active.
**Requested specialist gate (at dispatch only):** When a workflow requests a named FVS specialist, check BOTH the visible `spawn_agent` schema and whether the exact requested `agent_type` is advertised there or in a confirmed runtime registry. An `agent_type` field alone is not evidence that this role is registered; bundled `agents/*.md` are instructions, not registered Codex specialists. If the exact role is registered and `agent_type` is available, use typed mapping below WITHOUT a missing-role warning. Otherwise, even if `agent_type` is present, warn the user in plain language: Requested FVS specialist <agent-name> is not registered in this Codex session; the bundled Markdown cannot supply typed identity. Do not warn merely for opening help, installing, or mentioning a skill without requesting specialist dispatch. Apply the settings gate below before considering the generic-agent workaround. Never run an installer on the user's behalf.


Selection-capability gate (before manifest confirmation, child dispatch, or artifact writes):
- Check required specialist identity and sandbox against the exact registered role and effective child settings. A generic role preamble cannot meet a mandatory typed identity or sandbox requirement; stop and explain the unavailable guarantee before dispatch or artifact writes.
- If `model` is exposed for this child, pass the requested model. Otherwise compare it with the exact active/inherited Codex model; a different or unconfirmed model is unresolved. Rebuild the manifest around confirmed settings and ask explicitly, choose a capable external runner, or fail before dispatch in noninteractive mode.
- If `reasoning_effort` is exposed for this child, pass the requested effort. Otherwise compare it with the confirmed effective installed/runtime default; a different or unconfirmed effort is unresolved and follows the same rebuild/ask-or-fail rule.
- Model and effort are separate values: pass an exact catalog model id and an effort that model lists. A registered role that pins `model` or `reasoning_effort` (its role description says the setting is locked, or its TOML sets it) overrides the per-call value, so the pinned value is the effective one; if it differs from the confirmed selection it is unresolved.
- Never confirm a requested specialist setting and then omit it with a warning. The marketplace plugin does not install Codex agent TOML; use typed mapping only for an independently registered exact role.

Typed mapping (only when the exact requested FVS role is registered AND agent_type is exposed):
- `Task(subagent_type="X", prompt="Y")` -> `spawn_agent(agent_type="X", message="Y")`
- `Task(model="...")` -> pass `model` if available for this child; otherwise omit only after the selection-capability gate proves it equals the active/inherited model.
- `Task(reasoning_effort="...")` -> pass `reasoning_effort` if available for this child and the role does not pin it; otherwise omit only after the gate proves the effective (pinned or default) effort equals the confirmed effort.
- `fork_context: false` by default -- FVS agents load their own context via `<files_to_read>` blocks.

Generic-agent workaround (missing exact registered role OR no agent_type field):
If the requested FVS type (`fvs-researcher`, `fvs-executor`, etc.) is not registered, typed dispatch is NOT possible even with an `agent_type` field. If the field is absent, typed dispatch is also unavailable. Fallback:
1. Read `${CLAUDE_PLUGIN_ROOT}/agents/<agent-name>.md` and extract its instructions. If the token is still literal, resolve the path from this SKILL.md as described above.
2. Only when the settings gate permits generic execution, spawn a generic/default child with those instructions as a role preamble before the task prompt. Do not pass an unregistered `agent_type`.
3. Label output "generic-agent workaround". This is NOT equivalent to a registered specialist: the preamble does not assure typed identity, sandbox, model, or reasoning effort.
4. If required guarantees cannot be honored, stop before dispatch or artifact writes; explain which guarantee is missing. Typed FVS roles currently require the direct Codex installation, a separate complete FVS install: point the user to "Codex specialist roles" in the FVS README and never suggest keeping both channels. Even after switching, confirm exact registration and settings in the runtime.

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
  echo "Run /fvs:update to refresh this installation."
  echo "There is no separate Aeneas install option."
  exit 1
fi

node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!m.upstream_source || !Array.isArray(m.mapping) || !m.mapping.length ||
      !Array.isArray(m.extraction_inputs) || !m.extraction_inputs.length ||
      m.extraction_inputs.some(x => !x.repository || !x.upstream_path || !x.snapshot_target) ||
      !m.tactic_renames || typeof m.tactic_renames !== "object") process.exit(2);
' "$SYNC_META" || {
  echo "FVS >> Aeneas sync metadata is invalid. Run /fvs:update to refresh this installation."
  exit 1
}
```

Do not offer or reference an "Aeneas install option": FVS installs the snapshot and mapping as part
of every normal runtime install. If the preflight fails, STOP before all later steps.

## Step 1: Read config and resolve subagent model

Read the complete config and apply `model-profiles.md`. Declare stage key `doc_sync` for every
`fvs-doc-syncer` mode and resolve one exact runtime/provider model+effort selection.

Before the first dispatch, show and confirm the command-level selection manifest. Offer one-run
adjustment, exact-stage Save override, notes that rebuild and reconfirm the manifest, and Cancel.
Missing preferred models or unsupported efforts prompt interactively; noninteractive unresolved
choices fail before dispatch with exact remediation. Pass only native fields the selected runtime
actually supports.

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

## Step 3: Freeze upstream revisions before fetching content

Resolve current upstream refs once, before any content fetch or worker dispatch. Record these exact
values in the run manifest:

- `FROZEN_AENEAS_SHA`: `AeneasVerif/aeneas` `main` at run start.
- `FROZEN_AENEAS_DATE`: the commit date of `FROZEN_AENEAS_SHA`.
- `FROZEN_CHARON_PIN`: the uncommented commit in `charon-pin` fetched from
  `FROZEN_AENEAS_SHA`, not from a moving local checkout.
- `FROZEN_CHARON_MAIN_SHA`: `AeneasVerif/charon` `main` at run start, used only to check whether an
  active pinned-toolchain blocker is fixed upstream.
- `FROZEN_CHARON_MAIN_DATE`: the commit date of `FROZEN_CHARON_MAIN_SHA`.

Use read-only `git ls-remote`, `gh api`, or `curl` requests. Validate every revision as 40 lowercase
hex characters and every date as an ISO-8601 timestamp. If any value cannot be resolved, STOP before
workers or writes; never substitute a clone `HEAD`, guess a ref, or mix revisions from separate
resolution attempts. All later Aeneas fetches use `FROZEN_AENEAS_SHA`; pinned Charon evidence uses
`FROZEN_CHARON_PIN`; upstream-fixed comparison evidence uses `FROZEN_CHARON_MAIN_SHA`.

Do not write `_sync-meta.json` yet. The frozen values are proposed metadata until approved snapshot
content has been written and verified.

## Step 4: Report clone staleness against the frozen revisions

For each resolved clone, compare `git rev-parse HEAD` against its actual expected revision: Aeneas
against `FROZEN_AENEAS_SHA`, Charon against `FROZEN_CHARON_PIN`. Report `up-to-date` / `behind N` /
`ahead N` / `diverged`. Staleness is diagnostic only: use a clone only when it contains the frozen
commit; otherwise fetch the exact frozen revision read-only.

```bash
AENEAS_HEAD=$(git -C "$AENEAS_CLONE" rev-parse HEAD 2>/dev/null)
CHARON_HEAD=$(git -C "$CHARON_CLONE" rev-parse HEAD 2>/dev/null)
# Compare AENEAS_HEAD with FROZEN_AENEAS_SHA and CHARON_HEAD with FROZEN_CHARON_PIN.
# Use rev-list --count when both commits exist locally; otherwise report "diverged / fetch needed".
```

```
FVS >> Clone Staleness

| Clone  | HEAD            | Expected revision | Status     |
|--------|-----------------|-------------------|------------|
| charon | {head:0:12}     | {pin:0:12}        | behind 3   |
| aeneas | {head:0:12}     | {frozen:0:12}     | up-to-date |
```

## Step 5: Fan out to fvs-doc-syncer in mode (a) tactics-lean-syntax

Dispatch the worker for today's tactic/Lean-syntax scope, inlining the `_sync-meta.json` mapping and
the `tactic_renames` table (the parent inlines all reference content; the worker uses no
@-references):

```
Task(subagent_type="fvs-doc-syncer", model="$SYNCER_MODEL",
     reasoning_effort="$SYNCER_EFFORT", // when supported; otherwise apply the capability gate
     description="Sync tactics + Lean-syntax docs (mode a)",
     prompt="<sync_mode>tactics-lean-syntax</sync_mode>
             ...inlined mapping + tactic_renames + extraction_inputs + frozen revision manifest +
                resolved Aeneas clone path for exact-revision local mining...")
```

The worker fetches mapped upstream files at `FROZEN_AENEAS_SHA` (local clone first only when that
commit exists, otherwise read-only `gh api` / `curl`), computes a SECTION-LEVEL diff, maps changed
sections via `merge_strategy` (`enrich` / `replace_section` / `defer`), checks the
`tactic_renames` table, and PROPOSES each change for the user to approve / skip / edit. Snapshot and
derived-reference writes remain separate from the final metadata write.

## Step 6: Fan out to fvs-doc-syncer in mode (b) extraction-docs

Dispatch the worker for the extraction-docs scope + the blocker-catalog reconcile, inlining the
extraction doc targets and the current `blocker-catalog.md` seed:

```
Task(subagent_type="fvs-doc-syncer", model="$SYNCER_MODEL",
     reasoning_effort="$SYNCER_EFFORT", // when supported; otherwise apply the capability gate
     description="Sync extraction docs + reconcile blocker catalog (mode b)",
     prompt="<sync_mode>extraction-docs</sync_mode>
             ...the exact extraction_inputs rows and snapshot_target values from _sync-meta.json;
                the frozen revision manifest; resolved clone paths for exact-revision local mining;
                the current blocker-catalog seed for the reconcile pass...")
```

The worker fetches each exact `extraction_inputs` row at its declared frozen revision and writes
only its declared `snapshot_target`. It section-level-diffs snapshots, then RECONCILES the blocker
catalog: re-check each seed blocker against `FROZEN_CHARON_PIN`, and separately check
`FROZEN_CHARON_MAIN_SHA` for an `upstream-fixed` annotation. "Fixed in upstream main" is NOT "fixed
for us": the entry stays active until the pin carries the fix and is never auto-`retire`. Never
duplicate a signature. The user approves / skips / edits each proposed change.

After all approved snapshot and derived-reference writes, verify every synchronized target and its
hash, then write `_sync-meta.json` last with the frozen SHA/date/pin evidence. A failed verification
leaves metadata unchanged and reports the rejected candidate.

## Step 7: Report

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
Before dispatch on Codex, apply the model-profile capability gate: confirm only the actual
active/inherited model and applicable effort, or fail before dispatch. Never silently ignore a
confirmed field.
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
