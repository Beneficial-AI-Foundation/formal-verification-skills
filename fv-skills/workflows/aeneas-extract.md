<purpose>
Drive a Rust crate, folder, or file through the bounded Aeneas extraction repair loop:
PRE-FLIGHT (pin audit + clone resolution) -> EXTRACT -> CLASSIFY -> DISPATCH
(A-apply / bisect / propose-B-gate / escalate) -> DOCUMENT (reversible records) ->
re-EXTRACT, until the build is clean or a blocker is escalated to the human.

This workflow is the state machine. The command body (`/fvs:aeneas-extract`) is the
orchestrator: it OWNS loop termination, FIRES the synchronous Category-B equivalence gate
itself (never a fixing subagent), and runs the success oracle. The orchestrator dispatches
the loop subagents and reconciles their results; this file documents what each step must do.

The loop is restartable from its own on-disk records: re-extraction is idempotent and skips
already-clean blockers, so a long run interrupted by a gate, an escalation, or a session
handoff (`/fvs:pause-work` + `/fvs:resume-work`) resumes from the reversible records at the
crate root and the workspace tree. There is no separate status/resume command.

Hard invariants this workflow preserves:
- Generated Lean (`Types.lean` / `Funs.lean`) is NEVER written; annotations are preferred
  over source edits.
- Every source change is recorded reversibly at the crate root.
- A semantic (Category-B) change is gated by an independent assessor and a human ratification
  token; the success oracle refuses completion while any token is absent.
- Escalation is a human decision point and a valid outcome, not a failure.
- The build's exit status is read from the tool itself (`set -o pipefail` / `${PIPESTATUS[0]}`),
  never from the tail of a piped log (the green-build trap).
- Builds always run under `nice -n 19 lake build`.
</purpose>

<process>

<step name="pre_flight">
## Step 1: PRE-FLIGHT -- target detection, clone resolution, pin audit

### 1a. Detect target shape and scope the loop

The single `<path>` argument is auto-detected into one of three shapes:

```bash
TARGET="$1"
if [ -f "$TARGET/Cargo.toml" ]; then
  SHAPE="crate"          # whole crate -- scope = every extracted function in the crate
elif [ -d "$TARGET" ]; then
  SHAPE="folder"         # a module folder -- scope = functions under this folder
elif [ -f "$TARGET" ]; then
  SHAPE="file"           # a single source file -- scope = functions defined in this file
else
  echo "FVS >> ERROR: <path> is neither a crate (Cargo.toml), a folder, nor a file: $TARGET"
  exit 1
fi
```

The crate ROOT (the directory holding `Cargo.toml`) is resolved regardless of shape -- the
reversible records always live at the crate root, even when the target is a single file.

**Path safety:** quote every expansion; reject a target path containing shell metacharacters;
never `eval` a path. The target and the clone paths flow into `git -C` and file writes -- treat
them as untrusted input.

### 1b. Resolve clone paths + workspace (config -> auto-detect -> prompt -> error)

Resolve `charon_clone_path`, `aeneas_clone_path`, and `extract_workspace` with the standard
FVS precedence (matching `/fvs:map-code`): read `.formalising/fvs-config.json` first, then
auto-detect, then prompt the user, then error. Never hardcode an absolute clone path -- the
resolution is the only place a clone path is determined.

```bash
# 1. config first
cat .formalising/fvs-config.json 2>/dev/null
# 2. auto-detect a sibling clone only inside this documented step
#    (a probe is allowed here; a hardcoded literal path in the loop body is not)
# 3. prompt the user for the clone path if neither config nor a probe resolved it
# 4. error only if the user declines and mining/pin-audit truly cannot proceed
```

A missing clone is reported gracefully: precedent mining and the pin audit degrade, but the
loop can still run (EXTR-08). Validate that a resolved clone path is a directory before any
`git -C <clone>` call.

### 1c. Pin audit (EXTR-03) -- warn-and-confirm, never silent, never hard-block

Read the Aeneas `charon-pin` (strip comments and whitespace) and compare it against:
(a) the Charon clone HEAD, (b) the project `lakefile.toml` Charon/Aeneas rev, and
(c) the recorded known-good anchor.

```bash
# charon-pin resolves the Charon rev the extractor expects
AENEAS_PIN=$(grep -v '^#' "$AENEAS_CLONE/charon-pin" | tr -d '[:space:]')
CHARON_HEAD=$(git -C "$CHARON_CLONE" rev-parse HEAD)
# is the pinned rev reachable from the clone HEAD?
git -C "$CHARON_CLONE" merge-base --is-ancestor "$AENEAS_PIN" "$CHARON_HEAD" \
  && echo "pin reachable" || echo "DRIFT: pinned rev not an ancestor of clone HEAD"
```

On ANY drift: report LOUDLY which pins moved, and -- following the catalog
`needs-manual-check` discipline -- whether a fix may or may not already be present in the
pinned Charon ("fixed in upstream main" is NOT "fixed for us" until the pin is diffed against
the fix). Then REQUIRE explicit user confirmation to proceed (D-10 warn-and-confirm: never
silent, never a hard block). Record the acknowledgment as `pin_context` -- it is stamped into
the reversible records so every later change carries the pin it was made against.

### 1d. Clone staleness -- reported gracefully

Report clone staleness as one of `up-to-date` / `behind N` / `ahead N` / `diverged` using a
cheap `git -C <clone> rev-list --left-right --count <pin>...HEAD`. Staleness is NEVER a hard
mining failure -- it is informational and folds into `pin_context`.

### 1e. Coverage policy

Collect the COVERAGE POLICY at pre-flight (a config key or a prompt). Default to the most
conservative posture: **all extracted functions are required coverage** -- so every opacity
decision on a target then escalates to the gate via the coverage-escalation guard. A narrower
coverage set is the user's explicit choice.

**Outputs:** `SHAPE`, crate ROOT, resolved clone paths + workspace, `pin_context`, coverage
policy. Initialise the workspace tree `<extract_workspace>/<target>/` with subdirs
`equivalence-gate/`, `mwe/`, `drafts/`, `catalog-candidates/`, `escalations/`.
</step>

<step name="extract">
## Step 2: EXTRACT -- run extraction, read the tool's real exit status

Run the extraction (Charon -> Aeneas -> split -> tweaks) and then build. NEVER read the tail
of a piped log to decide success -- a pipe reports the *filter's* exit status (`0`), masking a
real failure. Read the tool's own status with `set -o pipefail` / `${PIPESTATUS[0]}`, or test
for the build artifact directly. Always build under `nice -n 19 lake build`.

```bash
set -o pipefail
nice -n 19 lake build 2>&1 | tee build.log
test ${PIPESTATUS[0]} -eq 0 || echo "lean-layer failure"   # read the TOOL's status, not the pipe's
```

After a pin bump, confirm the resolved backend revision equals the pin before classifying a
baffling `lean` error -- a stale dependency manifest can produce kernel-mismatch errors that
look like a `lean` defect but are setup drift.

- **Clean build** -> proceed to the SUCCESS ORACLE (Step 7).
- **Failure** -> capture the log and proceed to CLASSIFY (Step 3).
</step>

<step name="classify">
## Step 3: CLASSIFY -- reduce the log to a routable signature

Dispatch the read-only classifier to reduce the raw failure log to a stable signature by the
earliest failing layer (`charon -> aeneas -> split -> tweaks -> lean`):

```
Task(subagent_type="fvs-extract-classifier", model=$CLASSIFIER_MODEL, ...)
```

It returns `{ layer, symbol, signature, match }` where `signature` is the stripped,
Aeneas-facing match key (crate/module/function names, user line numbers, temp paths stripped),
`symbol` is the fix site (kept for the escalation report, NOT the match key), and `match` is a
catalog id or `NOVEL`. A miss returns `NOVEL` -- never a forced nearest-match.
</step>

<step name="dispatch">
## Step 4: DISPATCH -- route by category + coverage_impact

Route the classified blocker:

- **Category-A** (safe-by-construction; A-mechanical or A-opacity on a leaf you intend to
  trust) -> dispatch the applier, which applies one recipe alone and writes the reversible
  records:

  ```
  Task(subagent_type="fvs-extract-applier", model=$APPLIER_MODEL, ...)
  ```

  The coverage-escalation guard fires here: **A-opacity applied to a function inside required
  coverage is NOT auto-applied** -- axiomatizing or excluding a verification target is a
  meaning-affecting decision, so it becomes Category-B and routes to the GATE.

- **NOVEL** -> dispatch the bisector to shrink/grow to a minimal failing example (MFE) under
  the variant-budget, emit a schema-conformant `candidate` (real evidence = the MFE path +
  observed `pin_context`) to `catalog-candidates/`, and a PROPOSED fix. The bisector proposes,
  never disposes:

  ```
  Task(subagent_type="fvs-extract-bisector", model=$BISECTOR_MODEL, ...)
  ```

  A NOVEL B-fix routes to the GATE.

- **Forced Category-B** (any meaning-judgment: "this branch is unreachable", "these compute
  the same", an ungated source rewrite, or A-opacity on a coverage target) -> the synchronous
  GATE (Step 5).

- **Escalate conditions** (attempt-cap hit, same `{layer, signature}` recurrence, forced
  toolchain-remediation, or gate rejection) -> ESCALATE (Step 6).
</step>

<step name="gate">
## Step 5: GATE -- the EXTR-05 invariant (orchestrator-fired, independent assessor)

This is the synchronous Category-B equivalence gate. **It is fired by the ORCHESTRATOR (the
command body), never by a fixing agent.** The independence is structural:

1. The PROPOSER (the bisector, or whichever agent proposed the meaning-bearing change) supplies
   **section 1** of the gate packet -- the minimized before/after diff (the smallest edit that
   clears the blocker). It writes nothing past section 1.
2. The orchestrator dispatches a DISTINCT assessor subagent to draft **sections 2-6** (the
   obligation, the drafted equivalence argument, blast radius, alternatives considered, coverage
   rationale). The assessor is NOT the proposer and never writes section 7 / the token:

   ```
   Task(subagent_type="fvs-equivalence-assessor", model=$ASSESSOR_MODEL, ...)
   ```

   (The bisector dispatch `subagent_type="fvs-extract-bisector"` and this assessor dispatch
   `subagent_type="fvs-equivalence-assessor"` are deliberately different agents -- the gate's
   independence is enforced by topology, not convention.)
3. The orchestrator HALTS and presents the rendered 7-field packet to the human. **Section 7
   (the human's own independent checklist) and the ratification token are stamped by the human
   alone.** The loop does NOT re-extract until the token is present (D-03 synchronous).

The packet is written to `<extract_workspace>/<target>/equivalence-gate/<change-id>.md`; it is
the reversible record for the B-change (the minimized diff + the stamped token).

- **Ratified** (`equivalence-ratified:` present) -> the change stands; re-EXTRACT (Step 2).
- **Rejected** -> record the rejection reason in the packet and ESCALATE; NEVER re-submit the
  identical change (the loop must propose a smaller/different one).
</step>

<step name="document">
## Step 6: DOCUMENT -- reversible records at the crate root (D-08)

After any applied change, write the reversible records at the CRATE ROOT (not the workspace):

- `src-modifications.diff` -- regenerated against the pin (the machine-reversible record).
- `src-modifications.md` -- the human narrative of what changed and why.
- `src-assumptions.md` -- the trust assumptions introduced (axiomatized/opaque leaves, gated
  build-script stubs, etc.).
- `src-modifications.json` -- DERIVED from the diff: each hunk maps to an M-entry carrying its
  classification (A-mechanical / A-opacity / B) and, for a B-change, the ratification token.
  The `.json` is the generated machine index, not a pre-required input -- it is regenerated
  from the diff on every documentation pass.

Annotations are preferred over source edits. Generated `Types.lean` / `Funs.lean` are NEVER
written. Workspace writes stay confined to the resolved `extract_workspace`; reversible records
stay confined to the crate root.
</step>

<step name="loop_bounds">
## Step 7: LOOP BOUNDS (EXTR-06) -- caps and the no-progress rule

All four bounds are config-tunable; the documented defaults and rationale:

| Bound | Default | Rationale |
|-------|---------|-----------|
| Per-blocker attempt-cap | `3` | Matches the established FVS `lean-verify` per-sorry limit; defensibly conservative. |
| Per-run cycle hard-cap | `~25` | Mirrors the `lean-verify` total cap; on exhaustion ESCALATE with the full transcript. |
| Bisection variant-budget | `~12` | Comfortably covers the worked NO-BOTTOMS example (6 rows) with headroom; on exhaustion emit best partial isolation + ESCALATE. |
| No-progress key | `sha256(layer || signature)` | `symbol` is kept for the escalation report (the fix site), NOT the match key. |

**No-progress rule:** if the same `sha256(layer || signature)` key recurs AFTER a fix was
applied for it, the fix did not work -> IMMEDIATE escalate. Do NOT consume the remaining
attempt budget on a known-stuck fix.
</step>

<step name="escalate">
## Step 8: ESCALATE (D-04) -- a human decision point, never an automatic disposition

Escalation is always a HUMAN decision point and a VALID outcome -- not a failure. On any
escalate condition:

1. Persist the escalated blocker to `<extract_workspace>/<target>/escalations/<id>.md` with the
   full context: the stripped `signature`, the `symbol` (fix site), the attempt history, and the
   MFE.
2. Surface it to the user.
3. OFFER a draft. **Drafting runs only on the user's acceptance** -- on acceptance, dispatch the
   draft-investigator (dedup-first precedent mining + an evidence-cited HTML+MD draft to disk):

   ```
   Task(subagent_type="fvs-draft-investigator", model=$DRAFT_MODEL, ...)
   ```

   The draft is HTML+MD to the workspace `drafts/` directory ONLY. No upstream artifact is
   auto-opened or auto-created from the draft path.
4. "skip and continue" is ONLY an explicit human choice.
</step>

<step name="success_oracle">
## Step 9: SUCCESS ORACLE -- refuse completion without the token

A run is "complete" only when ALL of:

1. The build is clean (the tool's own exit status is `0` -- read via `${PIPESTATUS[0]}`,
   not the pipe).
2. Every Category-B change carries a present ratification token -- `grep equivalence-ratified:`
   over the gate packets returns a match for each B-change. Refuse "complete" while any token
   is absent.
3. The diff <-> record 1:1 check holds: every hunk in `src-modifications.diff` maps to an entry
   in `src-modifications.json` (no undocumented change; no orphan record).

If any clause fails, the run is NOT complete -- return to the loop or HALT for the human.
</step>

<step name="run_end_summary">
## Step 10: RUN-END SUMMARY (D-07)

At run end (clean or paused), re-remind the user of any outstanding escalations and re-offer
drafting for each. Note that a later run on the same target re-surfaces the escalations from
their on-disk records -- the loop is idempotent and restartable, so nothing is lost across a
session handoff.

```
FVS >> EXTRACTION RUN COMPLETE

Target:        {target} ({SHAPE})
Build:         {clean | escalated}
B-changes:     {N} ratified
Escalations:   {M} outstanding (re-offer drafts: {ids})
Pin context:   {pin_context summary}
Records:       src-modifications.diff / .json / .md, src-assumptions.md (crate root)
```
</step>

</process>

<success_criteria>
- [ ] PRE-FLIGHT detects crate/folder/file, resolves clones via config -> auto-detect -> prompt -> error, runs the pin audit, and warn-and-confirms on drift recording `pin_context`.
- [ ] EXTRACT reads the tool's real exit status (`set -o pipefail` / `${PIPESTATUS[0]}`), never the pipe; always `nice -n 19 lake build`.
- [ ] CLASSIFY reduces the log to `{layer, symbol, signature, match}`; NOVEL on a miss.
- [ ] DISPATCH routes A -> applier, NOVEL -> bisector, forced-B -> gate, escalate-conditions -> escalate; the coverage-escalation guard turns A-opacity on a coverage target into B.
- [ ] GATE is fired by the orchestrator; the assessor (`fvs-equivalence-assessor`) is a distinct dispatch from the proposer (`fvs-extract-bisector`) and never writes the token; the human stamps `equivalence-ratified:`.
- [ ] DOCUMENT writes `src-modifications.diff` + derived `.json` + `src-modifications.md` + `src-assumptions.md` at the crate root; generated Lean never written; annotations preferred.
- [ ] LOOP BOUNDS: attempt-cap 3, cycle hard-cap ~25, variant-budget ~12, no-progress key `sha256(layer || signature)`; same-key recurrence after a fix -> immediate escalate.
- [ ] ESCALATE persists to the workspace, surfaces to the user, offers a draft (drafting only on acceptance), and "skip" is an explicit human choice.
- [ ] SUCCESS ORACLE: clean build AND every B-change has a present token AND diff <-> record 1:1; refuses completion otherwise.
- [ ] No `gh` open/create call appears in the draft or escalation steps.
</success_criteria>
