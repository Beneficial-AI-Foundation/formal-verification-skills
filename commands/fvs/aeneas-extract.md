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

Output: a clean extraction (or a documented escalation), reversible source records at the
crate root (`src-modifications.diff` + derived `.json` + `src-modifications.md` +
`src-assumptions.md`), and the workspace tree under the resolved `extract_workspace`.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/aeneas-extract.md
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

## Step 1: Read config and resolve subagent models

Read the project config and resolve the model for each subagent dispatch using the
model-profiles dispatch sequence (config `model_overrides` first, then the profile table,
then `inherit` for unknown agents):

```bash
CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null)
# profile = config.model_profile || "quality"
# for each agent: model = model_overrides[agent] ?? PROFILE_TABLE[agent][profile]
```

Resolve and store:
- `$CLASSIFIER_MODEL` for `fvs-extract-classifier`
- `$APPLIER_MODEL` for `fvs-extract-applier`
- `$BISECTOR_MODEL` for `fvs-extract-bisector`
- `$ASSESSOR_MODEL` for `fvs-equivalence-assessor`
- `$DRAFT_MODEL` for `fvs-draft-investigator`

On Codex (which does not support dynamic model selection) the `model=` parameter is silently
ignored; the same dispatches work unchanged.

## Step 2: PRE-FLIGHT (pin audit + clone resolution)

Follow the PRE-FLIGHT step of the workflow:

1. Auto-detect the target shape (`crate` if `<path>/Cargo.toml` exists, else `folder` if a
   directory, else `file`) and resolve the crate ROOT. Quote every path expansion, reject a
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

## Step 3: Run the bounded loop

Repeat EXTRACT -> CLASSIFY -> DISPATCH -> DOCUMENT until clean or escalated, enforcing the
loop bounds (per-blocker attempt-cap 3, per-run cycle hard-cap ~25, bisection variant-budget
~12, no-progress key `sha256(layer || signature)` -- a same-key recurrence after an applied
fix escalates immediately).

- **EXTRACT:** run extraction and build under `set -o pipefail` + `nice -n 19 lake build`;
  read the tool's real exit status via `${PIPESTATUS[0]}`, never the tail of a piped log.
  Clean -> success oracle (Step 5). Failure -> classify.
- **CLASSIFY:** `Task(subagent_type="fvs-extract-classifier", model="$CLASSIFIER_MODEL", ...)`
  -> `{ layer, symbol, signature, match }`.
- **DISPATCH by category + coverage_impact:**
  - Category-A -> `Task(subagent_type="fvs-extract-applier", model="$APPLIER_MODEL", ...)`.
    The coverage-escalation guard: A-opacity on a function inside required coverage is NOT
    auto-applied -- it becomes Category-B and routes to the gate.
  - NOVEL -> `Task(subagent_type="fvs-extract-bisector", model="$BISECTOR_MODEL", ...)` to
    minimize to an MFE, write a schema-conformant candidate, and PROPOSE a fix.
  - Forced Category-B -> the GATE (Step 4).
  - Escalate conditions (attempt-cap hit, same-signature recurrence, forced
    toolchain-remediation, gate rejection) -> ESCALATE (Step 6).
- **DOCUMENT:** after any applied change, write the reversible records at the crate ROOT --
  `src-modifications.diff` (regenerated against the pin), `src-modifications.md`,
  `src-assumptions.md`, and the DERIVED `src-modifications.json` (hunk -> M-entry ->
  classification -> ratification-token mapping). Generated `Types.lean`/`Funs.lean` are NEVER
  written; annotations are preferred over edits.

## Step 4: GATE -- fired by THIS orchestrator (EXTR-05)

When DISPATCH yields a Category-B change, THIS command body fires the synchronous gate -- never
a fixing subagent:

1. The proposer (the bisector or proposing agent) supplies section 1 of the packet (the
   minimized diff).
2. Dispatch the DISTINCT assessor to draft sections 2-6 (the gate independence is structural --
   the assessor is a different agent from the proposer and never writes the token):

   ```
   Task(subagent_type="fvs-equivalence-assessor", model="$ASSESSOR_MODEL",
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

## Step 5: SUCCESS ORACLE -- refuse completion without the token

Mark the run complete only when ALL of:

1. The build is clean (the tool's own exit status `0`, read via `${PIPESTATUS[0]}`).
2. Every Category-B change carries a present ratification token --
   `grep -l "equivalence-ratified:" <extract_workspace>/<target>/equivalence-gate/*.md`
   matches for each B-change. Refuse completion while any token is absent.
3. The diff <-> record 1:1 check holds: every hunk in `src-modifications.diff` maps to an entry
   in `src-modifications.json`.

If any clause fails, the run is not complete -- continue the loop or HALT for the human.

## Step 6: ESCALATE -- a human decision point and a valid outcome

On any escalate condition: persist the blocker to
`<extract_workspace>/<target>/escalations/<id>.md` with the signature, the symbol (fix site),
the attempt history, and the MFE; surface it to the user; and OFFER a draft. Drafting runs
ONLY on the user's acceptance -- on acceptance dispatch the draft-investigator:

```
Task(subagent_type="fvs-draft-investigator", model="$DRAFT_MODEL",
     description="Mine precedent + draft an evidence-cited HTML+MD report",
     prompt="...the MFE + the escalation context...")
```

The draft is HTML+MD written to the workspace `drafts/` directory ONLY. No upstream artifact
is auto-opened or auto-created from any draft step. "skip and continue" is ONLY an explicit
human choice; escalation is a valid outcome, not a failure.

## Step 7: RUN-END SUMMARY (FVS >> banner)

```
FVS >> EXTRACTION RUN COMPLETE

Target:        {target} ({shape})
Build:         {clean | escalated}
B-changes:     {N} ratified
Escalations:   {M} outstanding (re-offer drafts: {ids})
Pin context:   {pin_context summary}
Records:       src-modifications.diff / .json / .md, src-assumptions.md (crate root)
```

Re-remind the user of outstanding escalations and re-offer drafting; note that a later run on
the same target re-surfaces them from their on-disk records.

</process>

<codex_skill_adapter>
On Codex, every interactive HALT in this command -- the pin-audit warn-and-confirm (Step 2),
the Category-B gate presentation (Step 4), and the escalation draft offer (Step 6) -- degrades
to a plain-text question and WAITS for the user. It is fail-closed: it never auto-picks a
default, never self-ratifies a gate packet, and never writes an upstream artifact. The
`Task(...)` dispatches survive intact (the `model=` parameter is silently ignored on Codex,
per model-profiles runtime handling).
</codex_skill_adapter>

<success_criteria>
- [ ] `<path>` auto-detected into crate/folder/file; the loop scoped accordingly.
- [ ] Pin-audit warn-and-confirm on drift records `pin_context`; clone staleness reported gracefully.
- [ ] EXTRACT reads the tool's real exit status (`set -o pipefail` / `${PIPESTATUS[0]}`); always `nice -n 19 lake build`.
- [ ] The orchestrator fires the gate itself, dispatching `fvs-equivalence-assessor` distinctly from `fvs-extract-bisector`; the success oracle greps `equivalence-ratified:` and refuses completion without it.
- [ ] Reversible records at the crate root; generated Lean never written; annotations preferred.
- [ ] Attempt-cap 3 + no-progress rule enforced; escalation is a human decision point and a valid outcome.
- [ ] Drafting runs only on acceptance; no `gh` open/create call anywhere in the command or the draft path.
</success_criteria>
