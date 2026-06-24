---
name: fvs:sync-aeneas-verif
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
@~/.claude/fv-skills/workflows/sync-aeneas-verif.md
@~/.claude/fv-skills/references/blocker-catalog.md
@~/.claude/fv-skills/references/model-profiles.md
@~/.claude/fv-skills/references/ui-brand.md
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

## Step 1: Read config and resolve subagent model

Read the project config and resolve the model for the `fvs-doc-syncer` dispatch using the
model-profiles dispatch sequence (config `model_overrides` first, then the profile table, then
`inherit` for unknown agents):

```bash
CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null)
# profile = config.model_profile || "quality"
# SYNCER_MODEL = model_overrides["fvs-doc-syncer"] ?? PROFILE_TABLE["fvs-doc-syncer"][profile]
```

On Codex (which does not support dynamic model selection) the `model=` parameter is silently
ignored; the dispatches work unchanged.

## Step 2: Resolve the local clones (config -> auto-detect -> prompt -> error)

Resolve `charon_clone_path` and `aeneas_clone_path` with the locked FVS precedence. Never hardcode
an absolute clone path. Quote every path expansion, reject a path with shell metacharacters, and
never `eval` a path.

```bash
# 1. config value
CHARON_CLONE=$(echo "$CONFIG" | grep_json project.charon_clone_path)   # may be null
AENEAS_CLONE=$(echo "$CONFIG" | grep_json project.aeneas_clone_path)   # may be null
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
- [ ] Clone staleness reported gracefully (never a hard failure of mining).
- [ ] `fvs-doc-syncer` dispatched in BOTH `tactics-lean-syntax` and `extraction-docs` modes.
- [ ] tactics-lean-syntax: `_sync-meta.json` mapping + tactic-rename machinery, propose-each.
- [ ] extraction-docs: Charon/Aeneas extraction docs synced; blocker catalog RECONCILED in place
      (no blind append, no auto-retire before the pin carries the fix).
- [ ] User approved / skipped / edited each proposed change individually.
- [ ] No `gh` auto-open/create anywhere; read-only fetch is the only GH path, and only as a fallback.
</success_criteria>
