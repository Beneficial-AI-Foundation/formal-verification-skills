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

The manifest also shows the patch pair for new tool-blocker patches: a `WRITER` seat and a
`REVIEWER` seat. The writer defaults to the saved spec-writing selection (`fc_spec`) and the
reviewer to the saved spec-review selection (`spec_review`); the user can choose another pair at
confirmation. The two must resolve to different models: if they resolve to the same one, stop and
ask for a different pair (noninteractive: stop with the exact remediation, never pick silently). The
reviewer runs as a fresh `fvs-equivalence-assessor` dispatch on this runtime; when the saved
spec-review selection names another runtime or leaves its model unset, show the seat as unresolved
and ask for a model that differs from the writer's. The seats replace the `extract_apply` /
`extract_bisect` and `extract_assess` settings only for the patch write-and-review dispatches
below. The pair is whatever the manifest says; no model is built into this command.

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
6. Read the observer set, which the target names once and every gate cites. Under the auto track
   it is the agreement's `conventions` entry that starts with `Observer set:`. Standalone, ask the
   user once, offering: `Observer set: return values, error results as callers distinguish them,
   external effects, panic occurrence and the file and line it reports. Not observed: timing,
   backtrace contents, debug formatting.` Write the answer to
   `<extract_workspace>/<target>/observer-set.md`, outside `equivalence-gate/`.

Initialise the workspace tree `<extract_workspace>/<target>/` with subdirs `equivalence-gate/`,
`mwe/`, `drafts/`, `catalog-candidates/`, `escalations/`, `known-issues/`, `patch-review/`.

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
PATCH_ENGINE="$HOME/.claude/scripts/fvs-extract-patches.mjs"
node "$PATCH_ENGINE" check --project-root "$CRATE_ROOT" --format json
```

- `ok` -> PATCH MODE (`translation-patches`).
- `legacy-mode` -> LEGACY MODE (`legacy-source-ledger`); the engine is not run again this run.
- `mixed-mode`, or any other result -> STOP, print the result's `message` verbatim, edit nothing.

The command never migrates a project: `migrate` is an explicit owner action described in
`extraction-patch-migration.md`.

## Step 3: Run the bounded loop

Repeat EXTRACT -> CLASSIFY -> KNOWN ISSUES -> DISPATCH -> WRITE AND REVIEW -> DOCUMENT until clean or escalated, enforcing the
loop bounds (per-blocker attempt-cap 3, per-run cycle hard-cap ~25, bisection variant-budget
~12, patch review rounds 2, no-progress key `sha256(layer || signature)` -- a same-key recurrence
after an applied fix escalates immediately).

**Fresh child per pass:** every pass or round of this loop that delegates work dispatches a new
child of the role named here, with the current inputs and the confirmed settings; the parent never
performs that role's work itself. Wait for the child's terminal result through the runtime's normal
wait or notification; a spawn acknowledgement or progress message is not a result. If the dispatch
fails, the child cannot be confirmed, or it ends in a terminal error, stop and report the affected
pass. Valid results such as a failed build, NOVEL, REJECT, REVISE or FOLLOWUP still route as this
step describes, and parent-owned baseline, build, revert and report steps stay with the parent.

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
- **KNOWN ISSUES FIRST:** at the `charon` or `aeneas` layer, before a new patch (a NOVEL signature
  before bisecting, or a recipe that is a source change), look for an existing fix in the tools'
  own trackers. Search open and closed issues and pull requests, release notes and the changelog,
  at the pinned revisions and at the newest release, using the stripped `signature` only: never a
  project name, path or source text, because a search leaves this machine. Reads only (`gh api`
  with an explicit read method, `gh search`, `curl` on a public page); never post, comment, label
  or open anything. Record one outcome per signature, with its link:
  `fix, no source change` (use it, write no patch; a result that makes a coverage target opaque
  still goes through the coverage-escalation guard to the gate), `workaround that edits source`
  (the patch route, citing the link in the patch's `Why:` line and the packet),
  `fix only in a newer version` (report it to the owner as a pin-change option; never change a pin
  alone; the patch route continues for the current pin), `none found`, or `not checked: <why>` when
  the tracker was unreachable (never recorded as `none found`, never cached as an answer, retried
  next time). Keep a short cached record per pin pair in
  `<extract_workspace>/<target>/known-issues/<aeneas-rev>-<charon-rev>.md` (the first twelve
  characters of each revision), keyed by signature, with date, sources, links and result. After the
  owner confirms a pin change, try the patch series with each patch removed in turn (a throwaway
  copy outside the checkout, Charon and Aeneas only) and report which patches the new tools no
  longer seem to need; this only proposes, and retirement goes through the retire step and the gate.
- **DISPATCH by category + coverage_impact:**
  - Category-A -> `Task(subagent_type="fvs-extract-applier", model="$APPLIER_MODEL", reasoning_effort="$APPLIER_EFFORT", ...)`.
    The coverage-escalation guard: A-opacity on a function inside required coverage is NOT
    auto-applied -- it becomes Category-B and routes to the gate. The prompt names the mode; in
    patch mode a change to the Rust inputs is a translation patch, never an in-place edit, and
    the applier writes no `src-modifications.*` file for any recipe, including non-Rust repairs
    such as `namespace-cascade` and `refresh-manifest`, which stay ordinary edits.
  - NOVEL -> `Task(subagent_type="fvs-extract-bisector", model="$BISECTOR_MODEL", reasoning_effort="$BISECTOR_EFFORT", ...)` to
    minimize to an MFE, write a schema-conformant candidate, and PROPOSE a fix.
  - Forced Category-B -> the GATE (Step 4).
  - Escalate conditions (attempt-cap hit, same-signature recurrence, forced
    toolchain-remediation, gate rejection, a patch the reviewer still objects to after the second
    round, or a gap no patch can fix) -> ESCALATE (Step 6).
- **WRITE AND REVIEW A NEW PATCH (patch mode):** a new patch to the Rust inputs is written by the
  `WRITER` seat (the applier or bisector dispatch with `model="$WRITER_MODEL"`,
  `reasoning_effort="$WRITER_EFFORT"`) and staged in `<extract_workspace>/<target>/patch-review/`;
  its prompt inlines the known-issues outcome and link, the header fields, the authoring recipe, the
  line-preserving rule with its zero-context line-count command and the observer set, because
  agents have no @-references. The writer stages the patch with the Write tool and does not run
  the patch engine's `check`, which cannot see a staged patch; it runs after installation. A new `fvs-equivalence-assessor` dispatch with `model="$REVIEWER_MODEL"` and
  `reasoning_effort="$REVIEWER_EFFORT"` then tries to break it: line preservation per hunk, each
  observer-set member against the change, panic occurrence and the file and line it reports. For a
  Category-B patch that dispatch also drafts sections 2-6 of the packet (it is the gate's assessor
  dispatch; do not dispatch a second one for the same bytes). It ends with
  `Reviewer verdict: no objection` or `Reviewer verdict: objection: <observer or line>`; "no
  objection" stamps nothing. An objection goes back to a new writer dispatch (round two); a second
  objection escalates, with no third round. A reviewer's objection is not a patch attempt against
  the attempt-cap, because the patch is never installed and never gets a packet; it is distinct from
  a human rejection at the gate. After "no objection": Category B -> the GATE (Step 4); Category A
  -> install the patch byte for byte, run `check`, and re-extract with a new `prepare`. A gap no
  patch can fix is recorded as a boundary (Step 6).
- **DOCUMENT:** after any applied change, write the reversible records at the crate ROOT.
  Generated `Types.lean`/`Funs.lean` are NEVER written; annotations are preferred over edits.
  - Patch mode: one `translation-patches/<name>.patch` per function (a classified supporting
    patch is allowed), appended to `translation-patches/series`, with the header the workflow
    specifies (`Classification:`, `Assumptions:`, `Obligations:`, `Evidence:` for B), then
    `check`; plus `src-assumptions.md` entries that name the patch on a line
    `patch-file: <exact file name>`. Every patch is line-preserving: the change goes on an
    existing line, or each hunk keeps its line count (an import goes on an existing `use` line or
    is written as a full path at its use site). The workflow's zero-context diff check is
    necessary, not sufficient; the reviewer checks the panic and the file and line it reports, and
    nothing in the patch engine enforces the rule. A patch that cannot be made line-preserving goes
    to the owner as a gap. Patch mode never writes
    `src-modifications.diff`, `.json` or `.md`: an active ledger beside a patch list is a mixed
    state the engine refuses.
  - Legacy mode: `src-modifications.diff` (regenerated against the pin),
    `src-modifications.md`, `src-assumptions.md`, and the DERIVED `src-modifications.json`
    (hunk -> M-entry -> classification -> ratification-token mapping).

## Step 4: GATE -- fired by THIS orchestrator (the independence invariant)

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
   `fvs-extract-bisector` dispatch above. For a new patch it is the reviewer dispatch of the
   write-and-review bullet in Step 3.
3. HALT and present the rendered 7-field packet to the owner (write it to
   `<extract_workspace>/<target>/equivalence-gate/<change-id>.md`). Section 7 and the ratification
   token come last, and only from the owner or from someone the owner explicitly delegated to. A
   delegation is recorded: the stamp's `Reviewed-by:` line names the delegate and its `Delegation:`
   line says where the owner recorded the delegation (the agreement, or a dated line the owner
   wrote); the owner's own stamp reads `Delegation: owner`. The delegate is
   never the writer or the reviewer of that patch, and no model seat stamps. Use `AskUserQuestion`
   to present the halt; on Codex, degrade to a plain-text question and WAIT (fail-closed -- never
   auto-pick a default, and no model seat ever stamps a packet).
4. Re-extract only once the token `equivalence-ratified:` is present. Reject -> record the
   reason and a `status: rejected` line in the packet and ESCALATE; never re-submit the identical
   change.

In patch mode, section 1 is the candidate translation patch itself, with its complete header,
held beside the packet as `equivalence-gate/<change-id>.patch`, and the packet records its
`patch-file:` and `patch-sha256:`. After ratification, a NEW proposal enters
`translation-patches/` and `series` byte for byte; then run `check` and re-extract with a new
`prepare`. A patch that is already installed (a migrated patch, whose legacy approval is
historical) is fired through the gate as it stands, with the installed patch as section 1, and is
NOT installed again: its bytes and its existing `series` entry stay as they are, because a second
entry makes `check` refuse the list.

A packet is active unless it carries a `status: rejected`, `status: superseded` or
`status: retired` line. The oracle's checks read active packets only; retained packets stay in
`equivalence-gate/` as the audit trail. When the loop replaces or removes an installed patch, it
retires it as the workflow's Step 6 describes: remove its `series` entry AND move the patch file
to `translation-patches/retired/` (the engine refuses an unlisted `.patch` file), mark its packet
`status: superseded` (or `status: retired`) with the reason, and change its `src-assumptions.md`
`patch-file:` line to `retired-patch:`, keeping the history.

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
4. Every Category-B patch, migrated ones included, carries a human ratification bound to its
   current bytes: the workflow's ratification check finds, in
   `<extract_workspace>/<target>/equivalence-gate/`, an active packet that carries
   `equivalence-ratified:`, names the patch on a `patch-file:` line, and records on a
   `patch-sha256:` line the sha256 the
   manifest records for it. A patch edited after ratification, and any B patch without such a
   packet, fails. A migrated patch's `Evidence:` and `Ratification:` lines are historical
   metadata the check never reads, so it needs a new gate (Step 4) before the run can complete.
   Refuse completion while the check fails.
5. The diff-to-record check holds over patch identities (file name and sha256): the workflow's
   record check finds the patches in `translation-patches/series` exactly the manifest's patches
   (`status --out "$OUT"`), in its order, each with a `Classification:` line, and no active gate
   packet or `src-assumptions.md` entry naming a patch absent from the manifest on a
   `patch-file:` line. Retained (rejected, superseded or retired) packets are the audit trail and
   never block completion.

Legacy mode:

1. The build is clean (the tool's own exit status `0`, read via `${PIPESTATUS[0]}`).
2. Every Category-B change carries a present ratification token --
   `grep -l "equivalence-ratified:" <extract_workspace>/<target>/equivalence-gate/*.md`
   matches for each B-change. Refuse completion while any token is absent.
3. The diff <-> record 1:1 check holds: every hunk in `src-modifications.diff` maps to an entry
   in `src-modifications.json`.

A ledger that `migrate` retired is inactive (`src-modifications.inactive.json` marks it, its
files stay byte for byte): the oracle never reads it and never treats legacy evidence as patch
evidence. The classification, assumptions and obligations `migrate` copied into patch headers are
the patch's record; the copied approval is historical and never counts toward completion.

If any clause fails, the run is not complete -- continue the loop or HALT for the human.

## Step 6: ESCALATE -- a human decision point and a valid outcome

On any escalate condition: persist the blocker to
`<extract_workspace>/<target>/escalations/<id>.md` with the signature, the symbol (fix site),
the attempt history, and the MFE; surface it to the user; and OFFER a draft. Two exits from the
write-and-review bullet land here. A patch the reviewer still objects to after the second round is
recorded with both rounds, the staged patch and the known-issues outcome; the owner picks another
pair, a different patch, or a boundary. A gap no patch can fix is recorded as a boundary: the
function, why no line-preserving patch clears it, the roots that reach it, and the tool issue it
waits for (the link found, or `none found`), plus a matching `src-assumptions.md` entry. The
coverage consequence (accept the function as an assumption, or block the run) is the owner's
explicit decision and is never skipped without a record; under the auto track the externals record
carries the boundary. Drafting runs
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
Copy:                  {the OUT of the last cycle}; build exit {that cycle's real exit status, or none when it stopped before the build}
Oracle:                {complete | refused: <the failing oracle clauses> | unknown: <why the oracle did not run>} (complete only when every success-oracle clause above holds)
Extraction:            {clean build | escalated | stopped: <engine code>} ({K} patches in series)
Restored source:       {verify-restore ok | refused: <message>}
Evidence:              tree check {ok | refused}; B patches {N} ratified and bound to their hashes; diff-to-record check {ok | failed}
Obligations remaining: {the open `Obligations:` lines of the patches, grouped by patch file}
Escalations:           {M} outstanding (re-offer drafts: {ids})
Known issues:          {per signature: fix used | workaround cited | newer-version option reported | none found | not checked}; record known-issues/{aeneas-rev}-{charon-rev}.md
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
default, never lets a model seat stamp a gate packet, and never writes an upstream artifact. The
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
- [ ] The orchestrator fires the gate itself, dispatching `fvs-equivalence-assessor` distinctly from `fvs-extract-bisector`; the success oracle greps `equivalence-ratified:` and refuses completion without it. The owner (or a delegate the owner named, recorded on the stamp) stamps last.
- [ ] A new patch at the `charon` or `aeneas` layer starts with a read-only known-issues check (stripped signature only; `none found` and `not checked` kept apart), is written and reviewed by two different models with at most two rounds, is line-preserving, and is checked against the one observer set; a gap no patch can fix is recorded as a boundary and the owner decides the coverage consequence.
- [ ] Reversible records at the crate root (patch mode: `translation-patches/` + `series`, never `src-modifications.*`); generated Lean never written; annotations preferred.
- [ ] Patch-mode oracle: clean build AND `verify-tree` AND `verify-restore` AND a ratification bound to the `patch-sha256:` of every B patch, migrated ones included, AND the diff-to-record check over patch identities; retired legacy records are inactive and never read as patch evidence.
- [ ] Attempt-cap 3 + no-progress rule enforced; escalation is a human decision point and a valid outcome.
- [ ] Drafting runs only on acceptance; no `gh` open/create call anywhere in the command or the draft path.
</success_criteria>
