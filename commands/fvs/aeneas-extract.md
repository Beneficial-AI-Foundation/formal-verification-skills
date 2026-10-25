---
name: fvs:aeneas-extract
description: Drive a Rust crate/folder/file through the bounded Aeneas extraction repair loop
argument-hint: "<path>"
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

<objective>
Drive a Rust crate, folder, or single source file through the bounded Aeneas extraction
repair loop and either reach a clean build or escalate the remaining blockers to the human.

This command is the ORCHESTRATOR. It owns loop termination, fires the synchronous Category-B
equivalence gate itself (never delegating gate-firing to a subagent), and runs the success
oracle. The loop subagents do the bounded work (classify, apply, bisect, assess, draft); the
orchestrator routes their results and enforces the hard invariants.

Extraction runs in one of two modes, chosen by `scripts/fvs-extract-patches.mjs`:
`translation-patches` (the default for new projects: every change to the Rust inputs is a
translation patch in `translation-patches/`, applied only in a disposable copy while Charon runs,
so the original checkout is never edited by the loop) or `legacy-source-ledger` (a project that
already carries an active `src-modifications.diff` ledger keeps the in-place flow until the owner
migrates it explicitly; see `extraction-patch-migration.md`).

Output: a clean extraction (or a documented escalation), reversible source records at the
crate root (patch mode: `translation-patches/*.patch` + `series` + `src-assumptions.md`; legacy
mode: `src-modifications.diff` + derived `.json` + `src-modifications.md` +
`src-assumptions.md`), and the workspace tree under the resolved `extract_workspace`. A
translation adaptation does not prove equivalence with the original source; the patches' open
correspondence obligations are reported with every run.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/aeneas-extract.md
@~/.claude/fv-skills/references/extraction-patch-migration.md
@~/.claude/fv-skills/references/extraction-safety-model.md
@~/.claude/fv-skills/references/blocker-catalog.md
@~/.claude/fv-skills/references/model-profiles.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Target path: $ARGUMENTS (required -- a crate root with Cargo.toml, a module folder, or a
single source file).

The loop is restartable from its own on-disk records. If a prior run was paused at a gate, an
escalation, or a session handoff (`/fvs:pause-work` + `/fvs:resume-work`), re-running on the
same target resumes from the reversible records at the crate root -- re-extraction is
idempotent and skips already-clean blockers. There is no separate status/resume command.
</context>

<process>

## Step 1: Read config and resolve subagent models + effort

Read the complete project config and apply the canonical resolution contract in
`model-profiles.md`. Declare these stage keys rather than deriving tiers from agent names:

- `fvs-extract-classifier` -> `extract_classify`
- `fvs-extract-applier` -> `extract_apply`
- `fvs-extract-bisector` -> `extract_bisect`
- `fvs-equivalence-assessor` -> `extract_assess`
- `fvs-draft-investigator` -> `extract_investigate`

Resolve model and effort independently for every distinct stage. Before the first dispatch, show
one command-level selection manifest and obtain confirmation. `Adjust once` changes only this run;
`Save override` writes the exact runtime+stage entry. Notes rebuild the manifest and require
reconfirmation. Missing preferred models or unsupported efforts prompt interactively and fail with
exact remediation in noninteractive mode. Pass only validated native model/effort fields.

## Step 2: PRE-FLIGHT (pin audit + clone resolution)

Follow the PRE-FLIGHT step of the workflow:

1. Auto-detect the target shape (`crate` if `<path>/Cargo.toml` exists, else `folder` if a
   directory, else `file`) and resolve the crate ROOT (`CRATE_ROOT`). Quote every path expansion, reject a
   path with shell metacharacters, never `eval` a path.
2. Resolve `charon_clone_path` / `aeneas_clone_path` / `extract_workspace` with the precedence
   config -> auto-detect -> prompt -> error. Never hardcode an absolute clone path. Validate a
   resolved clone path is a directory before any `git -C <clone>`.
3. Run the pin audit: read the Aeneas `charon-pin` (strip comments/whitespace) and compare
   against the Charon clone HEAD, the project `lakefile.toml` rev, and the known-good anchor.
   On ANY drift, report loudly which pins moved and whether a fix may/may-not be in the pinned
   Charon, then HALT for explicit user confirmation (warn-and-confirm: never silent, never a
   hard block) and record the acknowledgment as `pin_context`.
4. Report clone staleness gracefully (`up-to-date` / `behind N` / `ahead N` / `diverged`).
5. Collect the coverage policy (config key or prompt); default to "all extracted functions are
   required coverage" (the most conservative posture).

Initialise the workspace tree `<extract_workspace>/<target>/` with subdirs `equivalence-gate/`,
`mwe/`, `drafts/`, `catalog-candidates/`, `escalations/`.

Run the mandatory cache preflight from the validated Lean project root. A failure stops the
workflow before extraction, delegation, or build:

```bash
if { [ ! -f lakefile.lean ] && [ ! -f lakefile.toml ]; } || [ ! -f lean-toolchain ]; then
  echo "FVS >> ERROR: run from the Lean project root" >&2
  exit 1
fi
LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake exe cache get
CACHE_STATUS=$?
if [ "$CACHE_STATUS" -ne 0 ]; then
  echo "FVS >> ERROR: Lake cache preflight failed; stopping workflow" >&2
  exit "$CACHE_STATUS"
fi
```

Select the extraction mode once, before any edit. Run the engine's read-only `check` with the
crate ROOT and read the `code` field of its JSON result (`legacy-mode` and `mixed-mode` share
exit code 4, so never read the exit status):

```bash
PATCH_ENGINE=~/.claude/scripts/fvs-extract-patches.mjs
node "$PATCH_ENGINE" check --project-root "$CRATE_ROOT" --format json
```

- `ok` -> PATCH MODE (`translation-patches`).
- `legacy-mode` -> LEGACY MODE (`legacy-source-ledger`); the engine is not run again this run.
- `mixed-mode`, or any other result -> STOP, print the result's `message` verbatim, edit nothing.

The command never migrates a project: `migrate` is an explicit owner action described in
`extraction-patch-migration.md`.

## Step 3: Run the bounded loop

Repeat EXTRACT -> CLASSIFY -> DISPATCH -> DOCUMENT until clean or escalated, enforcing the
loop bounds (per-blocker attempt-cap 3, per-run cycle hard-cap ~25, bisection variant-budget
~12, no-progress key `sha256(layer || signature)` -- a same-key recurrence after an applied
fix escalates immediately).

- **EXTRACT:** run extraction and build under `set -o pipefail` + `LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build`;
  read the tool's real exit status via `${PIPESTATUS[0]}`, never the tail of a piped log.
  Clean -> success oracle (Step 5). Failure -> classify.
  - Patch mode: every cycle runs `node "$PATCH_ENGINE" prepare --project-root "$CRATE_ROOT" --out "$OUT"`
    into a NEW `OUT` outside the checkout, then `verify-tree --out "$OUT"`, then the project's Charon
    with `"$OUT/tree"` as its working directory and `--dest-file` outside the tree, then
    `verify-tree` again, Aeneas on the `.llbc`, `verify-restore --out "$OUT"`, and the build. Only
    cargo's `target/` may appear in the copy after `prepare`. An engine refusal STOPs the run: it is
    never classified, never repaired inside the copy, and never re-run against the same `OUT`.
  - Legacy mode: extract and edit in place, as before.
- **CLASSIFY:** `Task(subagent_type="fvs-extract-classifier", model="$CLASSIFIER_MODEL", reasoning_effort="$CLASSIFIER_EFFORT", ...)`
  -> `{ layer, symbol, signature, match }`.
- **DISPATCH by category + coverage_impact:**
  - Category-A -> `Task(subagent_type="fvs-extract-applier", model="$APPLIER_MODEL", reasoning_effort="$APPLIER_EFFORT", ...)`.
    The coverage-escalation guard: A-opacity on a function inside required coverage is NOT
    auto-applied -- it becomes Category-B and routes to the gate. The prompt names the mode; in
    patch mode a change to the Rust inputs is a translation patch, never an in-place edit, and
    the applier writes no `src-modifications.*` file.
  - NOVEL -> `Task(subagent_type="fvs-extract-bisector", model="$BISECTOR_MODEL", reasoning_effort="$BISECTOR_EFFORT", ...)` to
    minimize to an MFE, write a schema-conformant candidate, and PROPOSE a fix.
  - Forced Category-B -> the GATE (Step 4).
  - Escalate conditions (attempt-cap hit, same-signature recurrence, forced
    toolchain-remediation, gate rejection) -> ESCALATE (Step 6).
- **DOCUMENT:** after any applied change, write the reversible records at the crate ROOT.
  Generated `Types.lean`/`Funs.lean` are NEVER written; annotations are preferred over edits.
  - Patch mode: one `translation-patches/<name>.patch` per function (a classified supporting
    patch is allowed), appended to `translation-patches/series`, with the header the workflow
    specifies (`Classification:`, `Assumptions:`, `Obligations:`, `Evidence:` for B), then
    `check`; plus `src-assumptions.md` entries that name the patch. Patch mode never writes
    `src-modifications.diff`, `.json` or `.md`: an active ledger beside a patch list is a mixed
    state the engine refuses.
  - Legacy mode: `src-modifications.diff` (regenerated against the pin),
    `src-modifications.md`, `src-assumptions.md`, and the DERIVED `src-modifications.json`
    (hunk -> M-entry -> classification -> ratification-token mapping).

## Step 4: GATE -- fired by THIS orchestrator (EXTR-05)

When DISPATCH yields a Category-B change, THIS command body fires the synchronous gate -- never
a fixing subagent:

1. The proposer (the bisector or proposing agent) supplies section 1 of the packet (the
   minimized diff).
2. Dispatch the DISTINCT assessor to draft sections 2-6 (the gate independence is structural --
   the assessor is a different agent from the proposer and never writes the token):

   ```
   Task(subagent_type="fvs-equivalence-assessor", model="$ASSESSOR_MODEL",
        reasoning_effort="$ASSESSOR_EFFORT", // when supported; otherwise apply the capability gate
        description="Draft equivalence-gate packet sections 2-6",
        prompt="...minimized diff (section 1) + the blocker context...")
   ```

   This `fvs-equivalence-assessor` dispatch is deliberately distinct from the
   `fvs-extract-bisector` dispatch above.
3. HALT and present the rendered 7-field packet to the human (write it to
   `<extract_workspace>/<target>/equivalence-gate/<change-id>.md`). Wait for the human to stamp
   section 7 and the ratification token. Use `AskUserQuestion` to present the halt; on Codex,
   degrade to a plain-text question and WAIT (fail-closed -- never auto-pick a default, never
   self-ratify).
4. Re-extract only once the token `equivalence-ratified:` is present. Reject -> record the
   reason and ESCALATE; never re-submit the identical change.

In patch mode, section 1 is the candidate translation patch itself, with its complete header,
held beside the packet as `equivalence-gate/<change-id>.patch`, and the packet records its
`patch-sha256:`. It enters `translation-patches/` and `series` byte for byte only after
ratification; then run `check` and re-extract with a new `prepare`.

## Step 5: SUCCESS ORACLE -- refuse completion without the token

Mark the run complete only when every clause of the run's mode holds. The patch-mode clauses
replace the legacy ones; they are not added to them.

Patch mode, for the cycle whose `OUT` built the extraction:

1. The build is clean (the tool's own exit status `0`, read via `${PIPESTATUS[0]}`).
2. `node "$PATCH_ENGINE" verify-tree --out "$OUT"` passes: the tree Charon consumed equals the
   manifest's recorded post-patch state. An unrecorded repair made inside the copy after
   `prepare` fails the run.
3. `node "$PATCH_ENGINE" verify-restore --out "$OUT"` passes: the original sources equal the
   recorded start.
4. Every Category-B patch carries a present ratification token: its `Evidence:` line names a gate
   packet in `<extract_workspace>/<target>/equivalence-gate/` and
   `grep "equivalence-ratified:"` matches it; a recorded `patch-sha256:` equals the manifest's
   sha256 for that patch. Refuse completion while any token is absent.
5. The diff-to-record check holds over patch identities (file name and sha256): the patches in
   `translation-patches/series` are exactly the manifest's patches (`status --out "$OUT"`), in
   its order, each with a `Classification:` line, and no gate packet or `src-assumptions.md`
   entry names a patch absent from the manifest.

Legacy mode:

1. The build is clean (the tool's own exit status `0`, read via `${PIPESTATUS[0]}`).
2. Every Category-B change carries a present ratification token --
   `grep -l "equivalence-ratified:" <extract_workspace>/<target>/equivalence-gate/*.md`
   matches for each B-change. Refuse completion while any token is absent.
3. The diff <-> record 1:1 check holds: every hunk in `src-modifications.diff` maps to an entry
   in `src-modifications.json`.

A ledger that `migrate` retired is inactive (`src-modifications.inactive.json` marks it, its
files stay byte for byte): the oracle never reads it and never treats legacy evidence as patch
evidence; only the values `migrate` copied into patch headers count, as carried over.

If any clause fails, the run is not complete -- continue the loop or HALT for the human.

## Step 6: ESCALATE -- a human decision point and a valid outcome

On any escalate condition: persist the blocker to
`<extract_workspace>/<target>/escalations/<id>.md` with the signature, the symbol (fix site),
the attempt history, and the MFE; surface it to the user; and OFFER a draft. Drafting runs
ONLY on the user's acceptance -- on acceptance dispatch the draft-investigator:

```
Task(subagent_type="fvs-draft-investigator", model="$DRAFT_MODEL",
     reasoning_effort="$DRAFT_EFFORT", // when supported; otherwise apply the capability gate
     description="Mine precedent + draft an evidence-cited HTML+MD report",
     prompt="...the MFE + the escalation context...")
```

The draft is HTML+MD written to the workspace `drafts/` directory ONLY. No upstream artifact
is auto-opened or auto-created from any draft step. "skip and continue" is ONLY an explicit
human choice; escalation is a valid outcome, not a failure.

## Step 7: RUN-END SUMMARY (FVS >> banner)

Legacy mode:

```
FVS >> EXTRACTION RUN COMPLETE

Target:        {target} ({shape})
Build:         {clean | escalated}
B-changes:     {N} ratified
Escalations:   {M} outstanding (re-offer drafts: {ids})
Pin context:   {pin_context summary}
Records:       src-modifications.diff / .json / .md, src-assumptions.md (crate root)
```

Patch mode reports four things separately; a clean extraction never stands in for the others:

```
FVS >> EXTRACTION RUN COMPLETE

Target:                {target} ({shape}), mode translation-patches
Extraction:            {clean build | escalated | stopped: <engine code>} ({K} patches in series)
Restored source:       {verify-restore ok | refused: <message>}
Evidence:              tree check {ok | refused}; B-changes {N} ratified ({C} carried over from a legacy ledger); diff-to-record check {ok | failed}
Obligations remaining: {the open `Obligations:` lines of the patches, grouped by patch file}
Escalations:           {M} outstanding (re-offer drafts: {ids})
Pin context:           {pin_context summary}
Records:               translation-patches/ and series, src-assumptions.md (crate root)
```

Re-remind the user of outstanding escalations and re-offer drafting; note that a later run on
the same target re-surfaces them from their on-disk records.

</process>

<codex_skill_adapter>
On Codex, every interactive HALT in this command -- the pin-audit warn-and-confirm (Step 2),
the Category-B gate presentation (Step 4), and the escalation draft offer (Step 6) -- degrades
to a plain-text question and WAITS for the user. It is fail-closed: it never auto-picks a
default, never self-ratifies a gate packet, and never writes an upstream artifact. The
Before any Codex dispatch, apply the model-profile capability gate: confirm only the actual
active/inherited model and applicable effort, or fail before dispatch. Never silently ignore a
confirmed field.
</codex_skill_adapter>

<success_criteria>
- [ ] `<path>` auto-detected into crate/folder/file; the loop scoped accordingly.
- [ ] Pin-audit warn-and-confirm on drift records `pin_context`; clone staleness reported gracefully.
- [ ] The mode comes from the engine's `check` verdict (its `code` field): `ok` -> patch mode, `legacy-mode` -> legacy mode, `mixed-mode` or any refusal -> STOP; the command never migrates.
- [ ] EXTRACT reads the tool's real exit status (`set -o pipefail` / `${PIPESTATUS[0]}`); always `LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build`.
- [ ] Patch-mode EXTRACT runs `prepare`, `verify-tree`, Charon in the copy, `verify-tree`, Aeneas, `verify-restore`; an engine refusal stops the run and is never repaired in the copy.
- [ ] The orchestrator fires the gate itself, dispatching `fvs-equivalence-assessor` distinctly from `fvs-extract-bisector`; the success oracle greps `equivalence-ratified:` and refuses completion without it.
- [ ] Reversible records at the crate root (patch mode: `translation-patches/` + `series`, never `src-modifications.*`); generated Lean never written; annotations preferred.
- [ ] Patch-mode oracle: clean build AND `verify-tree` AND `verify-restore` AND a token for every B patch AND the diff-to-record check over patch identities; retired legacy records are inactive and never read as patch evidence.
- [ ] Attempt-cap 3 + no-progress rule enforced; escalation is a human decision point and a valid outcome.
- [ ] Drafting runs only on acceptance; no `gh` open/create call anywhere in the command or the draft path.
</success_criteria>
