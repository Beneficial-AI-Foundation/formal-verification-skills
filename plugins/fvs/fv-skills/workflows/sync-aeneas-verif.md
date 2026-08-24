<purpose>
Orchestrate a two-mode synchronization of upstream Charon/Aeneas content into FVS, fanning out to
the `fvs-doc-syncer` worker in two specialised modes:

- **tactics-lean-syntax** — the `_sync-meta.json` mapping + `tactic_renames` machinery (today's
  tactic/Lean-syntax scope): section-level diff, propose-each, reconcile-not-append.
- **extraction-docs** — the Charon/Aeneas EXTRACTION documentation plus a reconcile pass over the
  shipped blocker catalog: re-check each seed blocker against live upstream and flag
  retire / update-signature / still-open, in place, never blind-append.

The orchestrator mines the config-driven LOCAL clones first (Charon + Aeneas, resolved via
config -> auto-detect -> prompt -> error, never hardcoded), reports clone staleness gracefully, and
dispatches `fvs-doc-syncer` once per mode. The user reviews and approves each proposed change.

Output: Updated FVS references / extraction docs, a reconciled blocker catalog, a refreshed snapshot,
and updated `_sync-meta.json`.
</purpose>

<process>

<step name="preflight_sync_metadata">
## Step 0: Preflight Installed Sync Metadata

Before config resolution, clone prompts, fetches, or dispatches, resolve
`${CLAUDE_PLUGIN_ROOT}/fv-skills/upstream/aeneas/_sync-meta.json` (the installer rewrites the runtime path)
and require a non-empty, parseable JSON object with `upstream_source`, a non-empty `mapping` array,
and an object-valued `tactic_renames` table.

If it is missing or invalid, STOP and report:

```
FVS >> AENEAS SYNC METADATA MISSING

Run /fvs:update, or run `npx fv-skills-baif@latest` and choose the current runtime in the normal
installer flow. There is no separate Aeneas install option.
```

**Inputs:** installed FVS tree
**Outputs:** validated `$SYNC_META`
**Error handling:** fail before every network call and worker dispatch; never continue with an empty
mapping and never direct the user to a nonexistent installer option.
</step>

<step name="resolve_models">
## Step 1: Resolve Subagent Model

Read `.formalising/fvs-config.json` and resolve the `fvs-doc-syncer` model via the model-profiles
dispatch sequence (config `model_overrides` -> profile table -> `inherit`). On Codex the `model=`
parameter is silently ignored.

**Inputs:** config file
**Outputs:** `$SYNCER_MODEL`
</step>

<step name="resolve_clones">
## Step 2: Resolve the Local Clones

Resolve `charon_clone_path` and `aeneas_clone_path` with the precedence config -> auto-detect ->
prompt -> error. Never hardcode an absolute clone path. Quote every path expansion, reject a path
with shell metacharacters, never `eval` a path. Validate each resolved clone is a directory before
any `git -C "<clone>"`.

**Inputs:** config clone-path keys
**Outputs:** resolved `$CHARON_CLONE` / `$AENEAS_CLONE` (or a recorded "unresolved" for graceful
degradation)

**Error handling:**
- A clone path resolves but is not a directory: report and skip mining that source.
- A clone cannot be resolved at all (config tail): report the missing source and CONTINUE the other
  mode rather than aborting the run -- mining is config-gated, not run-gating.
</step>

<step name="report_staleness">
## Step 3: Report Clone Staleness

For each resolved clone compare `git -C "<clone>" rev-parse HEAD` against the pin the project
expects (Charon vs the rev in Aeneas's `charon-pin`; Aeneas vs the lakefile-pinned rev). Report
`up-to-date` / `behind N` / `ahead N` / `diverged`. Use `rev-list --count` for the N; a pin commit
absent from the clone's history means `diverged / fetch needed`.

**Inputs:** resolved clones, `charon-pin`, lakefile rev
**Outputs:** staleness report

**Error handling:**
- Staleness is REPORTED, never a hard failure -- a stale clone is still mineable; flag the caveat
  and proceed.
</step>

<step name="sync_tactics_lean_syntax">
## Step 4: Fan Out — Mode (a) tactics-lean-syntax

Dispatch the worker for the tactic/Lean-syntax scope, inlining the `_sync-meta.json` mapping, the
`tactic_renames` table, the current snapshot SHA, and the resolved Aeneas clone path:

```
Task(subagent_type="fvs-doc-syncer", model="$SYNCER_MODEL",
     description="Sync tactics + Lean-syntax (mode a)",
     prompt="<sync_mode>tactics-lean-syntax</sync_mode> ...inlined mapping + tactic_renames + ...")
```

The worker fetches mapped upstream files (local clone first, read-only `gh api` / `curl` fallback
when thin), computes a SECTION-LEVEL diff (split by `## `, hash, classify added/removed/modified),
maps changes via `merge_strategy`, checks `tactic_renames`, and PROPOSES each change (yes / skip /
edit). It updates the snapshot files and `_sync-meta.json` at the end.

**Inputs:** mapping, tactic_renames, snapshot SHA, Aeneas clone
**Outputs:** worker return summary (applied / skipped / renames propagated)

**Error handling:**
- GitHub unreachable AND clone unresolved: report, propose no changes for this mode, continue.
- Mapping references a non-existent FVS file: worker reports and skips that entry.
</step>

<step name="sync_extraction_docs">
## Step 5: Fan Out — Mode (b) extraction-docs

Dispatch the worker for the extraction-docs scope + blocker-catalog reconcile, inlining the Charon
and Aeneas extraction doc targets and the current `blocker-catalog.md` seed:

```
Task(subagent_type="fvs-doc-syncer", model="$SYNCER_MODEL",
     description="Sync extraction docs + reconcile catalog (mode b)",
     prompt="<sync_mode>extraction-docs</sync_mode> ...Charon docs/{what_charon_translates,
             transformations,limitations}.md + README.md + CONTRIBUTING.md +
             .github/ISSUE_TEMPLATE/*; Aeneas documentation/*.md +
             documentation/skills/*.instructions.md (source-of-truth, NOT symlinks) + README.md +
             tests/README.md; resolved clone paths; the current catalog seed...")
```

The worker fetches the extraction docs (local clone first; on-demand read-only GH fetch only when
in-repo docs are thin, under evidence discipline), section-level-diffs them, then RECONCILES the
blocker catalog: re-check each seed blocker against live upstream and PROPOSE retire /
update-signature / still-open. "Fixed in upstream main" is NOT "fixed for us" -- an entry stays
`needs-manual-check` until the resolved pin is diffed against the fix; never auto-`retire`. Never
duplicate an entry whose `signature` already exists; update it in place. Propose each change
(yes / skip / edit).

**Inputs:** extraction doc targets, resolved clones, catalog seed
**Outputs:** worker return summary (applied / skipped / catalog entries reconciled)

**Error handling:**
- Aeneas has no issue templates / CONTRIBUTING: the worker reports the gap, does not fabricate one.
- A reconcile would overwrite the seed wholesale: rejected by the reconcile-not-append discipline.
</step>

<step name="report">
## Step 6: Report

Merge the two workers' return summaries into one banner:

```
FVS >> Sync Complete

| Mode                | Applied | Skipped | Notes                          |
|---------------------|---------|---------|--------------------------------|
| tactics-lean-syntax | {N}     | {M}     | {K} tactic renames propagated  |
| extraction-docs     | {N}     | {M}     | {R} catalog entries reconciled |

Snapshot updated: {old_commit} -> {new_commit}

Run `npm test` to verify no frontmatter or structural issues.
```

**Inputs:** both worker summaries
**Outputs:** final merged report
</step>

</process>

<success_criteria>
- Installed `_sync-meta.json` exists and passes its minimum schema preflight before any other work.
- Clone paths resolved via config -> auto-detect -> prompt -> error; no hardcoded absolute path.
- Clone staleness computed and reported gracefully (never a hard failure of mining).
- `fvs-doc-syncer` dispatched in BOTH `tactics-lean-syntax` and `extraction-docs` modes.
- Section-level diff (not byte-level) in each mode; each change proposed individually for approval.
- tactics-lean-syntax: mapping + tactic-rename machinery; metadata updated.
- extraction-docs: extraction docs synced; blocker catalog reconciled in place; no blind append; no
  auto-retire before the resolved pin carries the fix.
- No `gh` auto-open/create; read-only fetch is the only GH path and only a fallback to local mining.
- No silent failures -- all errors reported to the user.
</success_criteria>
