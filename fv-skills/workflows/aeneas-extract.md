<purpose>
Drive a Rust crate, folder, or file through the bounded Aeneas extraction repair loop:
PRE-FLIGHT (pin audit + clone resolution + mode selection) -> EXTRACT -> CLASSIFY -> DISPATCH
(A-apply / bisect / propose-B-gate / escalate) -> DOCUMENT (reversible records) ->
re-EXTRACT, until the build is clean or a blocker is escalated to the human.

There are two extraction modes, selected by `scripts/fvs-extract-patches.mjs` (never by this
workflow's own guess):
- `translation-patches` (the default for new projects): every change to the Rust extraction
  inputs is one translation patch in `translation-patches/`, applied only inside a disposable copy
  while Charon runs. The original checkout is never edited by the loop.
- `legacy-source-ledger` (projects that already carry an active `src-modifications.diff` ledger and
  have not migrated): the loop edits the source in place and records the edits in the ledger, as
  before. Nothing is reinterpreted until the owner migrates explicitly; see
  `extraction-patch-migration.md`.

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
- Every source change is recorded reversibly at the crate root: a translation patch in patch
  mode, a ledger hunk in legacy mode. The two never mix in one run.
- A semantic (Category-B) change is gated by an independent assessor and a human ratification
  token; the success oracle refuses completion while any token is absent.
- A translation adaptation changes the program the extractor sees. A clean extraction of a
  patched function does not prove equivalence with the original source; the correspondence
  obligations each patch records stay open until correspondence evidence closes them.
- Escalation is a human decision point and a valid outcome, not a failure.
- The build's exit status is read from the tool itself (`set -o pipefail` / `${PIPESTATUS[0]}`),
  never from the tail of a piped log (the green-build trap).
- Builds always run under `LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build`.
</purpose>

<process>

<step name="resolve_models">
Use the command's confirmed selection manifest from `model-profiles.md` with exact stage keys:
`extract_classify` for the classifier, `extract_apply` for the applier, `extract_bisect` for the
bisector, `extract_assess` for the independent assessor, and `extract_investigate` for the draft
investigator. If any stage needed by the chosen path is absent, rebuild and reconfirm the manifest
before dispatch. Never derive tiers from agent names or silently fall back.
</step>

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

The crate ROOT (`CRATE_ROOT`, the directory holding `Cargo.toml`) is resolved regardless of
shape -- the reversible records always live at the crate root, even when the target is a single
file.

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

<step name="cache_preflight">
## Step 1f: Warm the project cache

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
</step>

<step name="select_mode">
## Step 1g: Select the extraction mode

The patch engine decides the mode. This workflow reads its verdict and never infers the mode from
which files happen to exist. Run `check` once, before any edit, with the crate ROOT from Step 1a:

```bash
PATCH_ENGINE=~/.claude/scripts/fvs-extract-patches.mjs
MODE_RESULT=$(node "$PATCH_ENGINE" check --project-root "$CRATE_ROOT" --format json 2>/dev/null)
MODE_CODE=$(printf '%s' "$MODE_RESULT" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8")).code))')
```

`check` writes nothing. It rehearses the patch list in a temporary copy (every patch applies in
the order `translation-patches/series` lists and undoes back to the exact starting state) and
resolves the mode. The engine reads `extraction.mode` and `extraction.inputs` from
`.formalising/fvs-config.json` under the directory passed as `--project-root` (the crate ROOT).
When `extraction.mode` is unset, a project with an active legacy ledger
(`src-modifications.diff`, `.json` or `.md` at a crate root in the input set) is
`legacy-source-ledger`; every other project, including a new one with no patches yet, is
`translation-patches`. Without `extraction.inputs` the inputs are the crate root's `Cargo.toml`,
`Cargo.lock`, `build.rs` and `src` (those that exist); a crate that keeps sources elsewhere sets
`extraction.inputs`.

`legacy-mode` and `mixed-mode` share exit code 4, so read the `code` field of the JSON result,
never the exit status.

| `code` | Meaning | Action |
|--------|---------|--------|
| `ok` | `translation-patches`; the patch list was rehearsed | PATCH MODE: continue with the patch-mode steps below |
| `legacy-mode` | `legacy-source-ledger` | LEGACY MODE: continue with the legacy steps below; the engine is not run again this run (it refuses `prepare` in legacy mode by design) |
| `mixed-mode` | an active legacy ledger and a patch list (or patch mode configured beside an active ledger) | STOP; print the result's `message` verbatim; edit nothing |
| anything else, or an empty result | a stale, already-applied or irreversible patch, invalid input, a dirty original, or an engine failure | STOP; print the `message`; never fuzzy-apply or reorder a patch |

The two modes never mix inside a run: patch mode never writes `src-modifications.diff`, `.json`
or `.md`, and legacy mode never writes `translation-patches/`. A ledger that `migrate` has retired
is **inactive**: it stays on disk byte for byte, marked by `src-modifications.inactive.json`, and
does not make the project legacy or mixed. Editing a retired ledger file makes it active again,
and `check` then reports `mixed-mode`.

This workflow never migrates a project on its own. `migrate` is an explicit owner action
described in `extraction-patch-migration.md`; there is no other migration command.

Record `MODE` (`translation-patches` or `legacy-source-ledger`) for the run-end summary.
</step>

<step name="extract">
## Step 2: EXTRACT -- run extraction, read the tool's real exit status

Run the extraction (Charon -> Aeneas -> split -> tweaks) and then build. NEVER read the tail
of a piped log to decide success -- a pipe reports the *filter's* exit status (`0`), masking a
real failure. Read the tool's own status with `set -o pipefail` / `${PIPESTATUS[0]}`, or test
for the build artifact directly. Always build under `LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build`.

### Patch mode (translation-patches)

Charon runs in a disposable copy the engine prepares: the original checkout is never the
extraction tree. Every cycle uses a NEW `OUT` outside the crate checkout, because the patch list
may have changed since the last one; an earlier cycle's copy is never reused.

```bash
set -o pipefail
OUT="$(mktemp -d "${TMPDIR:-/tmp}/fvs-extract.XXXXXX")/copy"
node "$PATCH_ENGINE" prepare --project-root "$CRATE_ROOT" --out "$OUT"   # records the manifest; refusal -> STOP
node "$PATCH_ENGINE" verify-tree --out "$OUT"                            # before Charon: the copy is the recorded post-patch tree
( cd "$OUT/tree" && <the project's Charon command> --dest-file "$OUT/<crate>.llbc" ) 2>&1 | tee "$OUT/charon.log"
test ${PIPESTATUS[0]} -eq 0 || echo "charon-layer failure"               # read the TOOL's status, not the pipe's
node "$PATCH_ENGINE" verify-tree --out "$OUT"                            # after Charon: the tree it consumed is still the recorded one
# Aeneas on "$OUT/<crate>.llbc" with the project's usual options, then its split and tweaks steps
node "$PATCH_ENGINE" verify-restore --out "$OUT"                         # the original sources still match the recorded start
LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build 2>&1 | tee build.log
test ${PIPESTATUS[0]} -eq 0 || echo "lean-layer failure"                 # read the TOOL's status, not the pipe's
```

Send Charon's `.llbc` file and logs outside `"$OUT/tree"` (`--dest-file` as above; without it
Charon writes into its working directory). Only cargo's `target/` directory may appear in the copy
after `prepare`; any other new, edited or deleted file there fails `verify-tree`. Keep `Cargo.lock`
committed and current so cargo has nothing to rewrite in the copy. When Charon fails, still run
the second `verify-tree`, skip Aeneas, and go to CLASSIFY.

An engine refusal (`prepare`, either `verify-tree`, or `verify-restore` exiting nonzero) is a
setup or evidence failure, not a Charon, Aeneas or Lean failure. STOP and surface the result's
`message`. It is never classified, never repaired inside the copy, and never re-run against the
same `OUT`; the loop's own fixes are patches (Step 6) that the next cycle's `prepare` applies. A
`verify-tree` refusal means something other than the engine changed the extraction copy (an
unrecorded repair, a file a tool wrote, a rewritten `Cargo.lock`) and the run fails. An
interrupted cycle leaves a manifest whose status is `partial`; it is never evidence. Discard that
`OUT`, start a new one, and leave the checkout alone: the engine never wrote to it.

### Legacy mode (legacy-source-ledger)

The checkout itself is the extraction tree and the loop edits it in place, as before:

```bash
set -o pipefail
LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build 2>&1 | tee build.log
test ${PIPESTATUS[0]} -eq 0 || echo "lean-layer failure"   # read the TOOL's status, not the pipe's
```

### Both modes

After a pin bump, confirm the resolved backend revision equals the pin before classifying a
baffling `lean` error -- a stale dependency manifest can produce kernel-mismatch errors that
look like a `lean` defect but are setup drift.

- **Clean build** -> proceed to the SUCCESS ORACLE (Step 9).
- **Failure of Charon, Aeneas, split, tweaks or lean** -> capture the log and proceed to
  CLASSIFY (Step 3).
</step>

<step name="classify">
## Step 3: CLASSIFY -- reduce the log to a routable signature

Dispatch the read-only classifier to reduce the raw failure log to a stable signature by the
earliest failing layer (`charon -> aeneas -> split -> tweaks -> lean`):

```
Task(subagent_type="fvs-extract-classifier", model=$CLASSIFIER_MODEL, reasoning_effort=$CLASSIFIER_EFFORT, ...)
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
  Task(subagent_type="fvs-extract-applier", model=$APPLIER_MODEL, reasoning_effort=$APPLIER_EFFORT, ...)
  ```

  The coverage-escalation guard fires here: **A-opacity applied to a function inside required
  coverage is NOT auto-applied** -- axiomatizing or excluding a verification target is a
  meaning-affecting decision, so it becomes Category-B and routes to the GATE.

  The dispatch prompt names `MODE`. In patch mode a change to the Rust extraction inputs is
  written as a translation patch (Step 6), never edited into the checkout, and the applier writes
  no `src-modifications.*` file; the prompt inlines the Step 6 header fields, the authoring recipe
  and the `check` command, because the applier has no @-references.

- **NOVEL** -> dispatch the bisector to shrink/grow to a minimal failing example (MFE) under
  the variant-budget, emit a schema-conformant `candidate` (real evidence = the MFE path +
  observed `pin_context`) to `catalog-candidates/`, and a PROPOSED fix. The bisector proposes,
  never disposes:

  ```
  Task(subagent_type="fvs-extract-bisector", model=$BISECTOR_MODEL, reasoning_effort=$BISECTOR_EFFORT, ...)
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
   Task(subagent_type="fvs-equivalence-assessor", model=$ASSESSOR_MODEL, reasoning_effort=$ASSESSOR_EFFORT, ...)
   ```

   (The bisector dispatch `subagent_type="fvs-extract-bisector"` and this assessor dispatch
   `subagent_type="fvs-equivalence-assessor"` are deliberately different agents -- the gate's
   independence is enforced by topology, not convention.)
3. The orchestrator HALTS and presents the rendered 7-field packet to the human. **Section 7
   (the human's own independent checklist) and the ratification token are stamped by the human
   alone.** The loop does NOT re-extract until the token is present (D-03 synchronous).

The packet is written to `<extract_workspace>/<target>/equivalence-gate/<change-id>.md`; it is
the reversible record for the B-change (the minimized diff + the stamped token).

**Patch mode.** Section 1 is the candidate translation patch itself, authored as in Step 6 with
its complete header (`Classification: B` and an `Evidence:` line naming this packet) and held
beside the packet as `equivalence-gate/<change-id>.patch`. It is NOT in `translation-patches/` or
`series` until ratified. The packet records the patch's identity on a `patch-sha256:` line (the
sha256 of those exact bytes), so the token binds to them: a patch edited after ratification no
longer matches its packet.

- **Ratified** (`equivalence-ratified:` present) -> the change stands. Patch mode: install the
  staged patch byte for byte as `translation-patches/<name>.patch`, append it to `series`, run
  `check`, then re-EXTRACT (Step 2) with a new `prepare`. Legacy mode: apply the change in place
  and re-EXTRACT (Step 2).
- **Rejected** -> record the rejection reason in the packet and ESCALATE; NEVER re-submit the
  identical change (the loop must propose a smaller/different one).
</step>

<step name="document">
## Step 6: DOCUMENT -- reversible records at the crate root (D-08)

After any applied change, write the reversible records at the CRATE ROOT (not the workspace).

### Patch mode (translation-patches)

Patch mode never writes `src-modifications.diff`, `.json` or `.md`: those names are the legacy
ledger, and an active ledger beside a patch list is a mixed state the engine refuses. The records
are:

- `translation-patches/<name>.patch` -- one patch per function by default; a classified
  supporting patch is allowed when a change cannot stand alone (an import a rewrite needs). The
  engine requires the first four header lines below; the rest is the record that replaces the
  ledger's `.md` narrative and `.json` index:

  ```
  Translation patch: <item>           (or "Supporting patch: <item>")

  Change: <what is rewritten>
  Why: <the blocker it clears>
  Behaviour: <what the rewrite preserves or changes>
  Classification: A-mechanical | A-opacity | B
  Assumptions: <trust assumptions it introduces; omit when none>
  Obligations: <correspondence obligations that stay open; omit when none>
  Evidence: <B only: equivalence-gate/<change-id>.md>
  Independent: yes                    (only when it applies on its own to the source snapshot)

  diff --git a/<path> b/<path>
  ...
  ```

  The same `Classification:`, `Assumptions:`, `Obligations:` and `Evidence:` lines are what
  `migrate` writes. A `Ratification:` line appears only on a patch `migrate` produced, carrying the
  legacy token verbatim; a patch written by this workflow keeps its ratification in its packet.
- `translation-patches/series` -- one patch file name per line, in application order; every
  `.patch` file listed exactly once (the engine refuses any other list).
- `src-assumptions.md` -- each entry names the patch (file name and sha256) that introduced it;
  it stays at the crate root in both modes.

A patch identity is its file name together with the sha256 `prepare` records for it in the
manifest. Only changes to the Rust extraction inputs are patches (the engine refuses a patch that
touches any other path). Edits to hand-authored Lean files and project config (`namespace-cascade`,
`refresh-manifest`) stay ordinary working-tree edits, recorded in `src-assumptions.md` where they
introduce an assumption.

**Authoring a patch.** A new patch applies after every patch already in `series`, so its base is
the copy from the last `prepare`. Work in a scratch directory outside the checkout:

```bash
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/fvs-patch.XXXXXX")"
cp -R "$OUT/tree/." "$SCRATCH/" && rm -rf "$SCRATCH/target"
git -C "$SCRATCH" init -q && git -C "$SCRATCH" add -A
git -C "$SCRATCH" -c user.name=fvs -c user.email=fvs@localhost commit -qm base
# edit the files under "$SCRATCH", then take the diff body (its a/ and b/ paths are crate-root relative):
git -C "$SCRATCH" add -A && git -C "$SCRATCH" diff --cached
```

Write the header followed by that diff body with the Write tool as
`translation-patches/<name>.patch`, and append `<name>.patch` to `series`. Then run
`node "$PATCH_ENGINE" check --project-root "$CRATE_ROOT"`. A refusal (it does not apply, it does
not undo cleanly, the header is incomplete, a path is outside the extraction inputs) means remove
the patch and its `series` line and report the message; an unchecked patch is never left in the
list. Only a patch that passes `check` starts the next cycle, with a new `prepare`.

### Legacy mode (legacy-source-ledger)

- `src-modifications.diff` -- regenerated against the pin (the machine-reversible record).
- `src-modifications.md` -- the human narrative of what changed and why.
- `src-assumptions.md` -- the trust assumptions introduced (axiomatized/opaque leaves, gated
  build-script stubs, etc.).
- `src-modifications.json` -- DERIVED from the diff: each hunk maps to an M-entry carrying its
  classification (A-mechanical / A-opacity / B) and, for a B-change, the ratification token.
  The `.json` is the generated machine index, not a pre-required input -- it is regenerated
  from the diff on every documentation pass.

### Both modes

Annotations are preferred over source edits. Generated `Types.lean` / `Funs.lean` are NEVER
written. Workspace writes stay confined to the resolved `extract_workspace`; reversible records
stay confined to the crate root.
</step>

<step name="loop_bounds">
## Step 7: LOOP BOUNDS (EXTR-06) -- caps and the no-progress rule

All four bounds are config-tunable; the documented defaults and rationale:

| Bound | Default | Rationale |
|-------|---------|-----------|
| Per-blocker attempt-cap | `3` | A small fixed cap: a blocker that survives three distinct fixes needs escalation, not more retries. |
| Per-run cycle hard-cap | `~25` | Bounds a whole run; on exhaustion ESCALATE with the full transcript. |
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
   Task(subagent_type="fvs-draft-investigator", model=$DRAFT_MODEL, reasoning_effort=$DRAFT_EFFORT, ...)
   ```

   The draft is HTML+MD to the workspace `drafts/` directory ONLY. No upstream artifact is
   auto-opened or auto-created from the draft path.
4. "skip and continue" is ONLY an explicit human choice.
</step>

<step name="success_oracle">
## Step 9: SUCCESS ORACLE -- refuse completion without the token

A run is "complete" only when every clause of its mode holds. The patch-mode clauses replace the
legacy ones; they are not added to them.

### Patch mode (translation-patches)

All of, for the cycle whose `OUT` built the extraction:

1. The build is clean (the tool's own exit status is `0` -- read via `${PIPESTATUS[0]}`,
   not the pipe).
2. `node "$PATCH_ENGINE" verify-tree --out "$OUT"` passes when the oracle runs it: the tree Charon
   consumed equals the manifest's recorded post-patch state. An unrecorded repair made inside the
   copy after `prepare` fails here, and the run fails.
3. `node "$PATCH_ENGINE" verify-restore --out "$OUT"` passes: the original sources equal the
   recorded start.
4. Every Category-B patch carries a present ratification token: its `Evidence:` line names a gate
   packet in the workspace and `grep equivalence-ratified:` matches that packet. When the packet
   records a `patch-sha256:`, it equals the sha256 the manifest records for that patch, so an
   edited patch is not ratified. Refuse "complete" while any token is absent.
5. The record check holds over patch identities (file name and sha256), compared with the
   manifest (`node "$PATCH_ENGINE" status --out "$OUT"`, which refuses a partial manifest): the
   patches `translation-patches/series` lists now are exactly the manifest's patches, in its
   order, with unchanged sha256; each carries a `Classification:` line; and no gate packet and no
   `src-assumptions.md` entry names a patch absent from the manifest (no orphan record). A patch
   added after `prepare` needs a new cycle.

A patch that `migrate` produced names its legacy packet in `Evidence:` and carries the legacy
`Ratification:`. That packet predates the patch and records no `patch-sha256:`, so clause 4 reads
its token as for any B patch and the run-end summary reports it as carried over from the legacy
ledger, never as fresh evidence that the patched function matches the original.

### Legacy mode (legacy-source-ledger)

All of:

1. The build is clean (the tool's own exit status is `0` -- read via `${PIPESTATUS[0]}`,
   not the pipe).
2. Every Category-B change carries a present ratification token -- `grep equivalence-ratified:`
   over the gate packets returns a match for each B-change. Refuse "complete" while any token
   is absent.
3. The diff <-> record 1:1 check holds: every hunk in `src-modifications.diff` maps to an entry
   in `src-modifications.json` (no undocumented change; no orphan record).

### Inactive legacy records

After a successful `migrate`, the retired ledger (`src-modifications.diff`, `.json` and `.md`)
stays on disk byte for byte and is **inactive**: `src-modifications.inactive.json` records its
exact files and the entries `migrate` copied. The oracle never reads inactive records and never
reinterprets legacy evidence as patch evidence; the only legacy values that count are the ones
`migrate` copied into patch headers, and they count as carried over. Editing a retired ledger
file makes it active again, and `check` then reports `mixed-mode`.

### Both modes

If any clause fails, the run is NOT complete -- return to the loop or HALT for the human.
</step>

<step name="run_end_summary">
## Step 10: RUN-END SUMMARY (D-07)

At run end (clean or paused), re-remind the user of any outstanding escalations and re-offer
drafting for each. Note that a later run on the same target re-surfaces the escalations from
their on-disk records -- the loop is idempotent and restartable, so nothing is lost across a
session handoff.

Legacy mode:

```
FVS >> EXTRACTION RUN COMPLETE

Target:        {target} ({SHAPE})
Build:         {clean | escalated}
B-changes:     {N} ratified
Escalations:   {M} outstanding (re-offer drafts: {ids})
Pin context:   {pin_context summary}
Records:       src-modifications.diff / .json / .md, src-assumptions.md (crate root)
```

Patch mode reports four things separately; a clean extraction never stands in for the others, and
nothing here says the patched functions match the original source:

```
FVS >> EXTRACTION RUN COMPLETE

Target:                {target} ({SHAPE}), mode translation-patches
Extraction:            {clean build | escalated | stopped: <engine code>} ({K} patches in series)
Restored source:       {verify-restore ok | refused: <message>}
Evidence:              tree check {ok | refused}; B-changes {N} ratified ({C} carried over from a legacy ledger); record check {ok | failed}
Obligations remaining: {the open `Obligations:` lines of the patches, grouped by patch file}
Escalations:           {M} outstanding (re-offer drafts: {ids})
Pin context:           {pin_context summary}
Records:               translation-patches/ and series, src-assumptions.md (crate root)
```
</step>

</process>

<success_criteria>
- [ ] PRE-FLIGHT detects crate/folder/file, resolves clones via config -> auto-detect -> prompt -> error, runs the pin audit, and warn-and-confirms on drift recording `pin_context`.
- [ ] MODE comes from the engine's `check` verdict (its `code` field, never the exit status): `ok` -> patch mode, `legacy-mode` -> legacy mode, `mixed-mode` or any refusal -> STOP; the workflow never migrates.
- [ ] EXTRACT reads the tool's real exit status (`set -o pipefail` / `${PIPESTATUS[0]}`), never the pipe; always `LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build`.
- [ ] Patch-mode EXTRACT runs `prepare`, `verify-tree`, Charon inside `"$OUT/tree"` with its output outside the tree, `verify-tree`, Aeneas, then `verify-restore`; an engine refusal stops the run and is never classified or repaired in the copy.
- [ ] CLASSIFY reduces the log to `{layer, symbol, signature, match}`; NOVEL on a miss.
- [ ] DISPATCH routes A -> applier, NOVEL -> bisector, forced-B -> gate, escalate-conditions -> escalate; the coverage-escalation guard turns A-opacity on a coverage target into B.
- [ ] GATE is fired by the orchestrator; the assessor (`fvs-equivalence-assessor`) is a distinct dispatch from the proposer (`fvs-extract-bisector`) and never writes the token; the human stamps `equivalence-ratified:`.
- [ ] DOCUMENT (patch mode) writes `translation-patches/<name>.patch` + `series` + `src-assumptions.md` at the crate root and never `src-modifications.*`; (legacy mode) writes `src-modifications.diff` + derived `.json` + `src-modifications.md` + `src-assumptions.md`; generated Lean never written; annotations preferred.
- [ ] LOOP BOUNDS: attempt-cap 3, cycle hard-cap ~25, variant-budget ~12, no-progress key `sha256(layer || signature)`; same-key recurrence after a fix -> immediate escalate.
- [ ] ESCALATE persists to the workspace, surfaces to the user, offers a draft (drafting only on acceptance), and "skip" is an explicit human choice.
- [ ] SUCCESS ORACLE (patch mode): clean build AND `verify-tree` AND `verify-restore` AND every B patch has a present token AND the record check over patch identities holds; (legacy mode) clean build AND every B-change has a present token AND diff <-> record 1:1; refuses completion otherwise.
- [ ] Retired legacy records are inactive and never read as patch evidence; the run-end summary reports extraction, restored source, evidence and remaining obligations separately.
- [ ] No `gh` open/create call appears in the draft or escalation steps.
</success_criteria>
