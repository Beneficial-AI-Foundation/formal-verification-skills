---
name: fvs-lean-refactor
description: Reduce verified Lean proof code through reuse within an agreed scope
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
Reduce net Lean source LoC across an agreed file, module or project scope through reuse,
shared lemmas, deduplication and clearer proofs. Include all new helpers and wiring in the total.
Preserve useful prose, readability and the confirmed statements/core definitions/public interfaces.
Do not promise a percentage reduction or a performance gain.

The target is any Lean file whose proofs already compile: an FVS spec or an ordinary Lean project
file. If the file has `sorry` or does not build, stop and route it to `/fvs:lean-verify`; never
promise to refactor a broken file. Existing file arguments seed the scope recommendation; editing
neighbouring modules or a project requires the owner's agreement.
Apply Aeneas conventions only to Aeneas-extracted projects; use current definitions/proof support
without freezing a particular tactic sequence.
</objective>

<execution_context>
@../../../fv-skills/workflows/lean-refactor.md
@../../../fv-skills/references/ui-brand.md
</execution_context>

<process>
## Step 1: Orient and propose the boundary

Parse `$ARGUMENTS` into the starting `SPEC_PATH` and flags: `--theorem name`, `--mode safe|balanced|aggressive`
(default balanced), `--max-passes N` (nonnegative per-target ceiling, default 5, cap 20), and
`--report-only`. Reject unsupported values rather than dropping a flag. A shared change counts
against each affected target; zero allows no editing passes. A cap is a budget limit, not a quota.
`--theorem` limits editable proof targets; adding other proofs requires scope approval.

Read the supplied task, starting file, imports, nearby reuse candidates and any existing
`Contract.lean`/approved agreement. Recommend file, module or project scope from this evidence.
Propose exact editable files/declarations/helper locations and protected statements, core definitions,
assumptions, attributes and public interfaces. Preserve existing user edits. A recall view is a
summary, not enforcement: check the actual source/diff and gates. Confirm uncovered or changed
boundaries before edits; reuse an existing agreement only when it matches the current source/scope.

Load the trusted installed guidance before dispatch; never resolve it from the consumer cwd:

```bash
LAKE_BUILD_GUIDE=$(cat ../../../fv-skills/references/lake-build.md) || exit 1
LEAN_REFACTORING=$(cat ../../../fv-skills/references/lean-refactoring.md) || exit 1
```

## Step 2: Confirm settings, scope and compatibility

Read the complete config and apply `model-profiles.md`. Declare `research` for `fvs-researcher`
and `lean_refactor` for `fvs-lean-refactorer`; resolve each independently. Current project/native
role settings and confirmed stages remain authoritative. Use the existing selection gate for a
mismatch; do not rewrite roles or substitute cheaper models.
Refactoring `--mode` is independent of `model_profile` and never selects a cheaper role or effort.

Show one command-level selection manifest with scope, budget and both model/effort choices before
dispatch. Combine scope/settings confirmation where practical. Offer the existing one-run change,
exact-stage Save override, notes/reconfirmation and Cancel.

If `--mode` was explicitly supplied, emit one legacy-mapping warning: safe starts locally,
balanced compares reuse/helpers/strategy, and aggressive explores broader proposals. The agreement
controls edits in every mode. The default mode needs no compatibility question. An explicit flag
gets a warning, not an extra approval prompt. No new approval is needed for each coherent edit
inside the agreed boundary.

Record baseline/final LoC inventory and comparable build/elaboration commands, cache conditions,
timer, repetitions and resource limits. Use existing performance criteria or agreed evidence/noise;
Do not invent a fixed regression percentage. Additional benchmark/provider work needs bounded
consent. The parent alone runs compiler commands, gates and measurements serially. Children never
run Lake in the shared workspace.

## Step 3: Establish the baseline and file gates

Run from the validated project root. Preserve toolchain/dependency pins. Warm Mathlib only when
the exact root/dependency identity supplies its cache executable; failure stops the workflow:

```bash
if { [ ! -f lakefile.lean ] && [ ! -f lakefile.toml ]; } || [ ! -f lean-toolchain ]; then
  echo "FVS >> ERROR: run from the Lean project root" >&2
  exit 1
fi
# Exact identity: the root package or a recorded dependency is named mathlib in lake-manifest.json.
if node -e 'const m = JSON.parse(require("fs").readFileSync("lake-manifest.json", "utf8"));
  process.exit(m.name === "mathlib" || (m.packages || []).some(p => p.name === "mathlib") ? 0 : 1)' 2>/dev/null; then
  LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake exe cache get
  CACHE_STATUS=$?
  if [ "$CACHE_STATUS" -ne 0 ]; then
    echo "FVS >> ERROR: Lake cache preflight failed; stopping workflow" >&2
    exit "$CACHE_STATUS"
  fi
else
  echo "FVS >> Cache preflight not applicable: no Mathlib cache executable in this project"
fi
```

Selected proofs must compile without admissions. A text scan is a lead to inspect, not proof that
an identifier in a comment is an admission. Record/check the existing project trust policy and
protected source before editing. Stop on a real unfinished proof or baseline error.

For every selected Lean file, set `SPEC_PATH` and try its workspace-module gate:

```bash
set -o pipefail
LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build "$SPEC_PATH" 2>&1 | tail -40
FILE_GATE_STATUS=${PIPESTATUS[0]}
```

Only an unknown target/module outside library roots uses the import-building direct gate below.
`lake lean` builds actual imports before checking; raw `lake env lean` does not. If unsupported by
the pinned toolchain, stop instead of using stale artifacts. Preserve real status independently
from the displayed tail:

Keep this import preparation in `FILE_GATE` on every pass.

```bash
set -o pipefail
LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake lean "$SPEC_PATH" 2>&1 | tail -40
FILE_GATE_STATUS=${PIPESTATUS[0]}
```

Record the applicable command as `FILE_GATE` for each file, including any new helper file, and
rerun it after each coherent change. For a multi-file task, `$FILE_GATE` contains the complete
file-to-command map, including new helpers, not only the last file. Non-zero `FILE_GATE_STATUS`
stops acceptance. A default build
does not prove that an unselected file was checked. Run/record the required project baseline too:

```bash
set -o pipefail
LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build 2>&1 | tail -40
PROJECT_STATUS=${PIPESTATUS[0]}
```

Stop on non-zero `PROJECT_STATUS`. Before any edit, execute the inlined reference's printed
boundary recipe: capture the pristine source/context and fixed protected-name query; collect
types, protected definition bodies and axiom footprints with pinned Lean. Record complete expected
coverage and protected-definition output slots; require fully rendered `:=` bodies, not signatures,
missing values or `⋯`. Theorems use only types/axioms, never printed proofs. Keep the baseline exclusive. If a protected dependency cannot be observed in its
original built context, explain the exact gap and use the reference's reviewed boundary fallback.
A helper limitation does not make a valid Lean file unrefactorable. Never omit protected coverage,
claim equivalence from a signature, or waive compilation/axiom checks.
The view is syntax evidence, not a kernel identity proof. No new checker/receipt framework is added.

Capture the reference's net-code-LoC baseline and three warm serial timing samples within the
approved budget. The parent alone runs these commands. Do not recapture the baseline after edits.

## Step 4: Research in proportion to the task

A small cleanup uses lightweight analysis and one fresh refactorer. Parent compiler work is serial and waits until all edit workers are terminal. For substantial cross-file
work, use two fresh read-only scouts with distinct questions: reuse/dependency evidence and
scope/net-cost alternatives. Use the configured researcher role for both; await terminal results. Scouts do not run compiler
commands. A feedback path that may trigger builds uses the conservative serial plan.

```
Task(
  subagent_type="fvs-researcher",
  model="$RESEARCH_MODEL",
  reasoning_effort="$RESEARCH_EFFORT",
  description="Assess reuse and net-cost opportunities in the agreed scope",
  prompt="Research mode: lean-refactor
<agreement>$CONFIRMED_BOUNDARY_AND_READ_SCOPE</agreement>
<question>$SCOUT_QUESTION</question>
<current_sources>$CURRENT_SOURCE_CONTEXT</current_sources>
<lean_refactoring>$LEAN_REFACTORING</lean_refactoring>
<lake_build_guide>$LAKE_BUILD_GUIDE</lake_build_guide>
Return current declarations/types, affected files, removed/added/helper/wiring estimates,
basis and uncertainty, the narrow alternative and any needed public-API/scope proposal.
Read parent boundary views and LSP evidence only. Do not run Lake, Lean or compiler-backed scripts
in the shared workspace; ask the parent for serial queries. No invented times. Return ## RESEARCH COMPLETE."
)
```

For a materially better cross-file opportunity, show concrete affected files, the shared abstraction
and estimated net benefit with basis/uncertainty versus the narrow option. Ask BEFORE expanding.
If declined, stay inside the agreement and retain the opportunity in the final out-of-scope list.
`--report-only` returns findings/proposals here without changing proof sources.

## Step 5: Plan independent coherent changes

Compare reuse, helper extraction, proof strategy and local cleanup using the reference. Reject
format golf and deletion of useful prose as a way to meet the objective. Include new helper/import
costs. A new public API or protected change requires a concrete proposal and approval first.

Assign disjoint ownership by file and snapshot each coherent unit before editing. For substantial cross-file work use at most five independent
workers in a batch, within host/project limits and the confirmed budget. Assign a helper and its call sites as one coherent ownership unit. Units with a direct or transitive
import relation are dependent and run serially, even with disjoint files. A new module imported by
another owned unit is dependent too. If independence is unknown, use one worker. A small cleanup
uses one worker.
If usable child LSP feedback is unavailable, use one edit worker at a time, with parent gates between units. Required-live requests still stop; degraded serial feedback needs the existing parent consent.
Check each affected target's remaining pass budget before dispatch. At zero or an exhausted budget,
dispatch no edit worker; report partial completion and remaining work instead.

**Fresh child per pass:** every pass or round of this loop that delegates work dispatches a new
child of the role named here, with the current inputs and the confirmed settings; the parent never
performs that role's work itself. Wait for the child's terminal result through the runtime's normal
wait or notification; a spawn acknowledgement or progress message is not a result. If the dispatch
fails, the child cannot be confirmed, or it ends in a terminal error, stop and report the affected
pass. Valid results such as a failed build, NOVEL, REJECT, REVISE or FOLLOWUP still route as this
step describes, and parent-owned baseline, build, revert and report steps stay with the parent.

For each approved coherent task, pass the full current agreement, reference and source/gate inputs:

```
Task(
  subagent_type="fvs-lean-refactorer",
  model="$REFACTORER_MODEL",
  reasoning_effort="$REFACTORER_EFFORT",
  description="Reduce net proof code within assigned ownership",
  prompt="<agreement>$CONFIRMED_BOUNDARY_AND_PROTECTED_SOURCE</agreement>
<ownership>$OWNED_FILES_AND_INDEPENDENCE</ownership>
<current_sources>$CURRENT_SOURCE_CONTEXT</current_sources>
<research_findings>$RESEARCH_OUTPUT</research_findings>
<lean_refactoring>$LEAN_REFACTORING</lean_refactoring>
<lake_build_guide>$LAKE_BUILD_GUIDE</lake_build_guide>
<file_gate>$FILE_GATE</file_gate>
<measurement_plan>$BASELINE_AND_COMPARABLE_MEASUREMENT_PLAN</measurement_plan>
<previous_feedback>$ACTUAL_PREVIOUS_DIAGNOSTICS</previous_feedback>
Apply one coherent refactor within ownership. You are not alone; preserve other work.
Use child LSP feedback only. Do not run Lake, Lean or compiler-backed project scripts in the shared workspace. Return ready for the parent gate.
Helpers, file organisation and strategy changes are allowed only within the agreement.
Propose a new public API/protected change before editing it. Report helper/wiring cost and actual
LSP diagnostics and estimates; child build/timing status is UNRUN and a candidate is not acceptance. Return a documented terminal header."
)
```

Wait for every launched worker to be terminal before integration or recovery. On dispatch/child
failure, stop new dispatch and collect or cancel active work through the normal runtime.

Route each terminal result:

- `## REFACTORED`: this is a candidate ready for the parent, not an acceptance. After the batch is
  terminal, the parent runs the recorded FILE_GATE with `set -o pipefail` and uses its captured
  status. Run one file/new helper at a time, including import preparation; gate a helper before
  callers. Run printed-boundary/context comparisons and inspect protected closure/attributes.
- `## NO_CHANGE`: record the evidence and search boundary.
- `## PROPOSAL`: present the concrete scope/API/protected-meaning or cost trade-off. Obtain the
  owner's decision before further edits or acceptance.
- `## ERROR`: Stop the affected batch and report the error; do not start another pass. Once active
  workers stop, the parent gates the other independent owned units serially. Keep passing
  candidates and restore only the failed owner's files from its unit snapshot. Preserve other
  work. If failure ownership is unclear, hold an unaccepted proposal instead of guessing rollback.

Passing units still need integrated final checks. Report failed units and partial completion.

Repeat only while worthwhile permitted opportunities remain and the confirmed budget allows it.
Count coherent passes per affected target. At a budget/resource limit, report partial completion
and remaining work; do not claim that opportunities were exhausted.

## Step 6: Check the integrated scope and measurements

After the last integrated batch, the parent serially reruns all affected file gates and the required project gate above,
plus existing project/style/trust checks. The parent owns integration, checks and recovery; never
overwrite other edits. Stop on verification/recovery failure rather than weakening a statement.

Use the reporting recipe for final net code LoC across the baseline/new-file union. Include all
helper and compatibility wiring.
Derive that inventory from the actual diff, including new/untracked helper files. Include ancillary
source/configuration cost in the combined net total. Stop/propose an out-of-scope edit instead of
omitting its cost or silently accepting it.
Report code LoC, helper costs, raw/prose deltas and `final code total - baseline code total`.
Keep conventional formatting and useful explanations. List every file whose sequence hint rises
while code lines fall, with a one-line reason. Semicolon counts are hints, not a parser
or a hard veto. Review mixed format/strategy changes. If unsupported syntax makes automated
counts/hints unavailable, disclose that and continue with a clearly reviewed full-scope comparison;
never use fake counts or block the task solely on the metric helper. The metric supports readability
judgment, not scoring.

After serial final gates, the parent reruns the fixed query. Require unchanged query/context and
printed boundary data where fully covered. Loss of previously available coverage stops acceptance
of the affected unit as a regression, not a pre-existing helper limit. Complete the explicit review/checkable comparison for
any recorded gap; unverified preservation is not acceptance. Missing compilation or axiom evidence
still blocks retention of the affected unit. Then run the same
three warm serial timing samples and record the profiling phases actually reported.

Do not infer speed from fewer lines or decomposition. Repeat a suspected material regression within
the agreed budget; a repeatable material regression blocks automatic acceptance. Present an owner
trade-off with actual samples/cost and uncertainty. Incomparable measurements remain inconclusive.

Retain a result only with evidence of full-scope net code reduction without formatting/comment-deletion
credit, preserved protected meaning/readability, passing checks and no repeatable material timing
regression. An unavailable automated metric or printed view uses the documented reviewed comparison,
not an automatic rejection or an unsupported success claim. Otherwise hold an explicitly unaccepted proposal or restore the
session's edits. Reconfirm a changed agreement and take a new baseline before a different task.

## Step 7: Report and stop

Use the reference's report fields: confirmed scope/protection, deduplication and reused declarations,
baseline/final total and helper costs, net delta, actual build/elaboration samples/conditions,
check results, stopping reason, partial completion and remaining out-of-scope opportunities.
Return `REFACTORED`, `NO_CHANGE`, `PROPOSAL` or `ERROR` with the corresponding evidence. A worker
header is not a final acceptance or proof receipt. Update existing derived context only after
checks and only inside the agreed scope. Do not commit unless the user separately requests it.
</process>
