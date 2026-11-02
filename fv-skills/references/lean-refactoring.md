<overview>
# Lean proof refactoring

Reduce net Lean source LoC across the selected scope through reuse, shared lemmas, deduplication
and clearer proof structure. Count new helpers and import or compatibility wiring in that total.
Keep useful prose, conventional formatting and readable proofs. Shorter theorem bodies alone are
not the objective. There is no fixed reduction percentage or promised speedup.

Refactor compiling proofs without admissions. First agree the editable scope and protected
statements, core definitions, assumptions, attributes and public interfaces. Within that boundary,
helper extraction, file organisation and a different proof strategy are permitted. A protected
change, new public API or scope expansion needs a concrete proposal and approval first.

Use [Practical Lake builds](lake-build.md) for the pinned toolchain's targets and import preparation.
</overview>

<quick_reference>
## Agreement before edits

Recommend a file, module or project scope from the task and evidence. The input file is a starting
point, not permission to edit its neighbours. Show the actual file/declaration list, including
where new helper files may be created. Identify existing user edits and preserve them.

The agreement records:

| Part | What to confirm |
| --- | --- |
| Goal | Net LoC reduction with readable, maintainable proofs and useful prose preserved |
| Editable scope | Files, declarations, proof bodies, allowed helper locations and reorganisation |
| Protected meaning | Exact statements/types, core definitions, assumptions and required attributes |
| Public interfaces | Names, signatures, exported instances/attributes and supported import paths |
| Verification | Per-file gates, required project/style/trust checks and unchanged tool/dependency pins |
| Measurement | LoC inventory, actual build/elaboration commands, cache conditions, repetitions and resource budget |

Use an existing `Contract.lean` or approved agreement if it covers the current source and scope.
Confirm gaps instead of inferring approval from its filename. A recall view summarises the agreed
boundary; it is not enforcement or proof acceptance. Compare actual source/diffs and run the
required checks. Do not import recall axioms or incomplete witnesses to justify a refactoring.

## Existing flags

Keep `--theorem`, `--mode safe|balanced|aggressive`, `--max-passes N` and `--report-only` recognised.
The default uses adaptive balanced search without a compatibility question. If `--mode` was
explicitly passed, warn once that these names now select search preferences, not tactic tiers:

| Mode | Search preference; the confirmed boundary controls edits in every mode |
| --- | --- |
| safe | Start with existing lemmas and local duplication; present larger alternatives separately |
| balanced | Compare reuse, helper extraction, proof strategy and local cleanup together |
| aggressive | Explore broader strategy and organisation options; propose expansion before edits |

These labels grant no extra scope or permission to change protected meaning. They do not select
a different model profile. Keep explicit values visible; do not ignore them or add a second
compatibility approval prompt. A request for the old tier behaviour becomes a proposal, not a
silent fallback. Scope/settings confirmation remains separate.
`--max-passes` keeps its per-target ceiling: default 5, cap 20. A shared change counts against each
affected target; zero permits no editing passes. It is a budget limit, not a quota. A budget stop reports remaining work and partial
completion. `--report-only` produces findings and proposals without changing proof sources.
</quick_reference>

<patterns>
## Find worthwhile work

Search current project code and the pinned libraries for an existing result before designing one.
Check the actual declaration, type, assumptions, namespace and imports. A similar name is not
evidence of reuse. Consider these options using the current proof context:

- Reuse an existing theorem or a stronger already-approved abstraction.
- Replace repeated reasoning with a well-named helper and simpler callers.
- Change proof strategy when it makes the reasoning clearer and reduces total code.
- Remove local redundancy after checking the goal/context and elaborating the changed proof.

Choose by evidence, expected net saving, readability and measured cost. There are no tactic tiers,
minimum theorem lengths, required numbers of consumers or universal tactic replacements.
Keep a useful explanation even when removing it would improve the line count.

## Compare a broader opportunity before expanding

For a materially better cross-file opportunity, show both the narrow option and the proposed
broader option. Name affected files, the shared abstraction and its proposed interface. Estimate
removed lines, added helper/wiring lines and net benefit, with the evidence and uncertainty behind
the estimate. Also disclose dependency, public-API and measurement costs. Ask before expanding.
If expansion is declined, continue only worthwhile work within the original agreement and report
the broader opportunity as out of scope. Never invent a percentage guarantee to justify expansion.

## Helpers and organisation

Start with local reasoning for a single proof and a private helper for reuse within a file.
A cross-file helper needs an importable declaration. A namespace called `Internal` does not by
itself make a declaration private. Propose and obtain approval for any new public name/interface
not already authorised in the agreement. Count helper declarations, new files, imports and any
compatibility forwarding code in the net total.

Treat a shared helper and its call sites as one coherent unit. The parent gates the helper before its callers. Preserve agreed public names and
import paths when reorganising files. Report any change to assumptions or attributes as a protected
change. Revise the agreement and take a new baseline only after explicit approval; do not describe
a changed specification as preservation of the old one.

Local context matters: a tactic may use a hypothesis without naming it in its source text. Treat
textual absence as a search hint, then inspect the actual goal/context and check the removal.
Private names include the defining module, so inspect visibility and imports before moving helpers.
These cautions follow the checked Lean 4.31 sources for
[assumption search](https://github.com/leanprover/lean4/blob/v4.31.0/src/Lean/Meta/Tactic/Assumption.lean)
and [private names](https://github.com/leanprover/lean4/blob/v4.31.0/src/Lean/PrivateName.lean).
Other tactic syntax, capabilities and cost must be checked against the consumer's current pins.

In an Aeneas project, inspect the current generated code and proof support. `step` or `unfold`
syntax is not a universal refactoring boundary. Preserve the agreed specification, extraction
correspondence and attributes; change strategy only within that agreement. Refactoring does not
authorise Rust changes, re-extraction, dependency upgrades or weakening a theorem.

## Resolve the project's installed context before using recipes

The refactoring strategy is version-neutral; command syntax, printer output, options and tactics
are not. A 4.31 citation is evidence about that example, not a requirement to upgrade the consumer.
Read `lean-toolchain` and resolve the effective environment/directory/file override in the actual
project cwd. With a supported installed Elan, use `dump-state --no-net` and the reporting helper's
`toolchain` operation as shown in the command/workflow. The helper only interprets data and hashes
existing executables; it never runs or installs Lean. It requires an active project override and
an exact installed match, never the global default. Cached offline channel resolution is labelled;
an unresolved/uninstalled pin stops without downloads or substitution.

Keep the file pin, effective selection and override origin visible. If an ambient override conflicts
with the requested project pin, resolve that mismatch before edits; do not reset it or silently
choose4.31. Record relevant configuration/environment overrides, actual `lean`/`lake` version output,
absolute executable paths/hashes, dependency revisions, actual source roots and package Lean arguments.
Validate the Lake-selected environment/compiler against this context too. Preserve local pins and
lockfiles. Inspect local dependency availability before Lake loads configuration; do not authorize
fetches/cache downloads implicitly. Use the existing task's network/confinement policy.

Elan shims can install missing toolchains; even `elan show`/`which` can resolve through installing
paths. Do not use them as an offline preflight. If the installed resolver lacks the no-network API,
validate an existing project-specific installed setup explicitly and record equivalent identities;
never install/upgrade Elan or guess a replacement. See official [Elan selection/installation](https://github.com/leanprover/elan)
and [CLI/state API](https://github.com/leanprover/elan/blob/master/src/elan-cli/elan_mode.rs).

Before edits, establish this small capability plan from the selected tools' help, matching official
source and pristine project probes. Commands use `PROJECT_LAKE`/`PROJECT_LEAN` from this context:

| Capability | If unavailable on this pin/project |
| --- | --- |
| File-path build selector | Use the actual configured module target such as `+MyProject.Core`; never guess roots from filenames |
| Import-building `lake lean` | Validate equivalent prerequisite/import builds plus direct elaboration with the project's arguments/plugins; raw `lake env lean` alone is insufficient |
| JSON / `#check` / `#print axioms` / pp options and full-body rendering | Use a validated project query or the explicit reviewed comparison below; never drop compilation/axiom safeguards |
| `--profile` and profiler options | Mark unavailable detail; time the same validated elaboration argv without unsupported options, not a cached no-op |
| Tactic/linter recommendation | Check current definitions/parser or a bounded probe; use available reuse/proof tools instead of assuming a named tactic exists |
| Lexical metric coverage | Keep unsupported counts unavailable and use reviewed full-scope accounting |

A real compiler/build failure is not an unsupported capability. Classify a pristine probe as a
capability gap only with pin-specific evidence and passing actual source gates. A capability that
worked on the baseline and fails after edits remains a regression stop. Freeze the chosen query,
file/import gates and timing argv before baseline/final measurements; do not renegotiate them to
hide a regression. Send this context/plan to scouts and edit workers. This is not a new runtime or
compatibility framework, and no complete-version support matrix is implied.

## Printed boundary recipe: parent only

Before editing, resolve the protected declaration/definition inventory in the real project and
allocate fresh owned baseline/final directories. Include relevant definition closure and required
attributes. Preserve source/configuration snapshots and record pinned tool versions/executable
hashes. Build the protected modules with their recorded gates first. No child may write while the
parent captures or checks a boundary.
Use a fresh check/final directory for every pass; the baseline remains read-only. Hash the source
inputs around each capture too, so the saved view is not paired with a changing source snapshot.

Write a scratch query using the actual built modules/names. For example:

```lean
import MyProject.Core
set_option pp.all true
set_option pp.maxSteps 20000
#check @MyProject.publicRoot
#check @MyProject.coreDefinition
#print MyProject.coreDefinition
#print axioms MyProject.publicRoot
#print axioms MyProject.coreDefinition
```

Use `#check` for each protected declaration, `#print` for each protected definition, and
`#print axioms` for each protected declaration's footprint. The example has five observations;
set `BOUNDARY_EXPECTED` from the approved query, not from whatever output happens to appear.
Theorems use only `#check` and `#print axioms`; never `#print` their proofs. Provide
`BOUNDARY_DEFINITION_SLOTS`, a JSON file of zero-based output positions for protected definition
bodies: the example is `[2]`. Every protected definition must have its body observation listed.
For this automated path each must actually render as `def` or `abbrev` with `:=` followed by a value.
Classify an instance by its printed header, not its declaration category. Signature-only opaque/axiom/
constructor views, `<not imported>` and any `⋯` elision refuse coverage. The helper never falls
back to a signature. The finite `pp.maxSteps` example is a display budget, not protection depth or
a proof resource override. Choose it in the inspection plan; remaining elision leaves a coverage gap.
The following recipe was checked on Lean/Lake 4.31. Other pins require the same operations to be
validated first. Names must be observable in their original built module context. A private or
unimportable protected dependency needs a validated query or the reviewed fallback below.
Do not omit the dependency or silently copy it into a different module context to make the check pass.

`SCOPE_FILES` is an approved JSON source-path list, including possible new helpers. `CONTEXT_FILES`
lists the project's toolchain/configuration/manifest inputs. All paths below are parent-owned.
Load the reporting helper from the trusted installed FVS root:

```bash
REFACTOR_REPORT_TOOL=~/.claude/scripts/fvs-refactor-report.mjs
(
  set -C
  cat "$BOUNDARY_QUERY" > "$BASELINE_DIR/query.lean" || exit 1
  cat "$TOOLCHAIN_DIR/toolchain.json" > "$BASELINE_DIR/toolchain.json" || exit 1
  node "$REFACTOR_REPORT_TOOL" hashes "$PROJECT_ROOT" "$SCOPE_FILES" "$BASELINE_DIR/source-before.json" || exit 1
  node "$REFACTOR_REPORT_TOOL" capture "$PROJECT_ROOT" "$SCOPE_FILES" "$BASELINE_DIR/source.json" || exit 1
  node "$REFACTOR_REPORT_TOOL" hashes "$PROJECT_ROOT" "$CONTEXT_FILES" "$BASELINE_DIR/context.json" || exit 1
  LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 "$PROJECT_LAKE" env "$PROJECT_LEAN" --json "$BOUNDARY_QUERY" > "$BASELINE_DIR/raw.jsonl" 2> "$BASELINE_DIR/stderr.log"
  BOUNDARY_STATUS=$?
  echo "$BOUNDARY_STATUS" > "$BASELINE_DIR/inspection-status.txt" || exit 1
  if [ "$BOUNDARY_STATUS" -eq 0 ]; then
    node "$REFACTOR_REPORT_TOOL" messages "$BOUNDARY_QUERY" "$BASELINE_DIR/raw.jsonl" "$BOUNDARY_EXPECTED" "$BOUNDARY_DEFINITION_SLOTS" "$BASELINE_DIR/view.json" || exit 1
  else
    echo "FVS >> Inspection failed: retain diagnostics and establish the reviewed boundary route" >&2
  fi
  node "$REFACTOR_REPORT_TOOL" hashes "$PROJECT_ROOT" "$SCOPE_FILES" "$BASELINE_DIR/source-after.json" || exit 1
  diff -u "$BASELINE_DIR/source-before.json" "$BASELINE_DIR/source-after.json" || exit 1
) || exit 1
```

This capture happens once on the pristine pre-edit source, after parent import/module gates.
Outputs are exclusive files. Never overwrite or regenerate the baseline from the edited context.
The helper rejects malformed, diagnostic, missing or extra observations; it does not run Lean.
A supported message set with unavailable body coverage produces `coverage: "review-required"`,
not a successful printed comparison. A zero helper exit means a report was written, not acceptance.
After all workers stop, run the updated file/module gates serially, then:

```bash
cmp -s "$BASELINE_DIR/query.lean" "$BOUNDARY_QUERY" || exit 1
(
  set -C
  "$ELAN_BIN" dump-state --no-net > "$FINAL_DIR/elan.json" || exit 1
  node "$REFACTOR_REPORT_TOOL" toolchain "$PROJECT_ROOT" "$FINAL_DIR/elan.json" "$FINAL_DIR/toolchain.json" || exit 1
) || exit 1
diff -u "$BASELINE_DIR/toolchain.json" "$FINAL_DIR/toolchain.json" || exit 1
node "$REFACTOR_REPORT_TOOL" hashes "$PROJECT_ROOT" "$FINAL_SCOPE_FILES" "$FINAL_DIR/source-before.json" || exit 1
(
  set -C
  LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 "$PROJECT_LAKE" env "$PROJECT_LEAN" --json "$BOUNDARY_QUERY" > "$FINAL_DIR/raw.jsonl" 2> "$FINAL_DIR/stderr.log"
  BOUNDARY_STATUS=$?
  echo "$BOUNDARY_STATUS" > "$FINAL_DIR/inspection-status.txt" || exit 1
  if [ "$BOUNDARY_STATUS" -eq 0 ]; then
    node "$REFACTOR_REPORT_TOOL" messages "$BOUNDARY_QUERY" "$FINAL_DIR/raw.jsonl" "$BOUNDARY_EXPECTED" "$BOUNDARY_DEFINITION_SLOTS" "$FINAL_DIR/view.json" || exit 1
  else
    echo "FVS >> Inspection failed: retain diagnostics and complete the reviewed boundary route" >&2
  fi
) || exit 1
node "$REFACTOR_REPORT_TOOL" hashes "$PROJECT_ROOT" "$FINAL_SCOPE_FILES" "$FINAL_DIR/source-after.json" || exit 1
diff -u "$FINAL_DIR/source-before.json" "$FINAL_DIR/source-after.json" || exit 1
node "$REFACTOR_REPORT_TOOL" hashes "$PROJECT_ROOT" "$CONTEXT_FILES" "$FINAL_DIR/context.json" || exit 1
diff -u "$BASELINE_DIR/context.json" "$FINAL_DIR/context.json" || exit 1
# A previously covered boundary must remain covered.
BASELINE_COVERAGE=$(node -e 'const fs = require("fs"); const p = process.argv[1]; const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)).coverage : "review-required"; if (!["available", "review-required"].includes(c)) process.exit(1); process.stdout.write(c)' "$BASELINE_DIR/view.json") || exit 1
if [ "$BASELINE_COVERAGE" = "available" ]; then
  [ "$(cat "$FINAL_DIR/inspection-status.txt")" = "0" ] || { echo "FVS >> Final inspection failed after a covered baseline; stop affected unit" >&2; exit 1; }
  node -e 'const fs = require("fs"); const p = process.argv[1]; process.exit(fs.existsSync(p) && JSON.parse(fs.readFileSync(p)).coverage === "available" ? 0 : 1)' "$FINAL_DIR/view.json" || { echo "FVS >> Previously available protected coverage lost; stop affected unit" >&2; exit 1; }
  diff -u "$BASELINE_DIR/view.json" "$FINAL_DIR/view.json" || exit 1
else
  echo "FVS >> Pre-existing coverage gap: complete the explicit reviewed boundary comparison"
fi
node "$REFACTOR_REPORT_TOOL" compare "$BASELINE_DIR/source.json" "$PROJECT_ROOT" "$FINAL_SCOPE_FILES" "$FINAL_DIR/metrics.json" || exit 1
```

The views compare fully printed types, definition bodies and axiom footprints. They are syntax
observations, not a kernel identity proof, complete semantic closure or proof acceptance. Inspect
the source diff for protected definition closure, attributes, instances and scope commands too.
Complete the reviewed fallback for gaps; never declare unverified preservation. A changed
view or context stops acceptance; do not quietly rebase the baseline. Printed-output differences
may need owner review even when the underlying change is harmless.

### Reviewed boundary fallback

A helper limitation must not make a valid file/declaration unrefactorable. Explain the exact missing
observation and retain its source/query hashes, tool pin and diagnostics. `coverage: "available"`
is required on both views before using their equality; two identical gap reports prove nothing.
Do not present a signature as a definition body or claim semantic equivalence from printed syntax.
Loss of previously available coverage is a regression signal: failed final inspection, a missing
view or final elision stops acceptance of that affected unit. It cannot be relabelled as a
pre-existing helper limitation. Diagnose and repair it before continuing acceptance.

Before editing an affected unit, record an appropriate comparison route using the preserved pristine
source and protected inventory. Prefer an existing project-supported inspection that can expose the
missing declaration in its original context. Otherwise arrange explicit independent review of the
exact baseline/final protected declarations, types, definition bodies, dependency closure, namespace/
instance resolution and attributes. Bind that review to source hashes and the full diff, including
helpers/import wiring. Record what is checked, what is not, and the reviewer's conclusion; source
review is not a kernel identity proof. Do not silently substitute a weaker check for the agreed
protection. Use the project's established review channel, not a new checker framework.

Compilation and axiom safeguards remain mandatory: run the selected-file/import, affected-consumer
and project gates and compare protected-root axiom footprints with pinned Lean. For an external file
that cannot be imported, a project-validated temporary instrumented copy may append the same type/
axiom queries to the file's own source after its import gate. Validate name resolution and module/
private-name effects first; a different-context copy is not automatically equivalent. This recipe
does not establish body visibility for temporary copies; keep any protected-body gap explicit unless
that project/pin validates the body query too. Compare pristine
and final observations under the same validated setup. Keep snapshots exclusive and disclose every
remaining coverage gap. A failed inspection is not permission to dismiss compiler errors: establish
why the file itself still passes its gates and how the missing check will be supplied.

If preservation or required axiom evidence still cannot be established, hold only the affected unit
as an unaccepted proposal, explain the missing evidence and continue independent work. Do not weaken
a statement, import recall axioms, change project configuration, or waive safeguards to obtain success.

## Delegate in proportion to the task

A small cleanup uses lightweight analysis and one fresh refactorer. Substantial cross-file work
uses two fresh read-only scouts, then at most five independent edit workers per batch within the
confirmed budget. Ownership is disjoint by file. A helper and all affected call sites form a
coherent unit; dependent/overlapping units run sequentially.
Files in different workers' units must have no direct or transitive import relation. A new module
and a unit importing it are dependent too, even with disjoint paths. Run those units serially.
If import independence cannot be established, use the conservative serial plan.

Children, including scouts, use available LSP diagnostics/goals and return evidence or a candidate
ready for gate. They do
not run Lake, Lean or compiler-backed scripts in the shared workspace. The parent waits until all
edit workers are terminal, then runs every `FILE_GATE`, boundary query, measurement and project
gate strictly one at a time. This avoids relying on a shared build lock; Lake 4.31
[does not use one](https://github.com/leanprover/lean4/blob/v4.31.0/src/lake/Lake/Util/Lock.lean#L18-L20).
This serial policy does not depend on other pins sharing4.31 lock behavior. Check the project pin's
LSP/import setup before assuming feedback is build-free. If child LSP feedback is unavailable, use serial edit/parent-gate cycles with one child. Honour
required-live stops and the existing consent for degraded feedback. Do not call parallel edits
or compiler fallback safe merely because files are disjoint.
If an LSP feedback path may trigger shared compiler/build jobs, use the conservative serial path.

Use current project roles and confirmed `research`/`lean_refactor` settings. Optional cheaper
models remain user choices through the existing manifest, never implicit substitutions. Each
delegated pass gets a fresh child and current inputs; await a terminal result. Stop new dispatch
on failure, collect/cancel active work normally, and keep parent checks/recovery serial. These
instructions are not host-enforced receipts.

Capture each unit's owned-file snapshot before that unit starts. On a failed unit, restore only
that owner's files, including removal of its new files. Gate the other independent units serially
and preserve passing candidates and unrelated work. Passing units still need integrated checks.
If a final failure cannot be attributed safely, hold an unaccepted proposal rather than guess a
rollback or reset the workspace. Report the failed unit and partial completion.

## Net code LoC and readability

Use the complete before/after source union from the actual diff, including new helpers/imports,
removed files and compatibility wiring. New files have baseline zero; removed files final zero.
The reporting helper measures nonblank Lean code lines while excluding comments/docstrings.
It reports raw lines and removed/added comment text separately, so deleting an explanation earns
no code reduction. Useful prose must still be preserved or explicitly accounted for in review.

Report `net code LoC change = final code total - baseline code total`, including helper costs.
The helper also counts `;`/`<;>` tokens outside comments, supported strings/chars and quoted
identifiers. This is a readability hint, not a parsed proof-step count or a hard acceptance limit.
Genuine idiomatic shorter proofs may increase that hint. Do not penalise them by count alone.
List every file with `sequenceHintDelta > 0` and fewer code lines, with a one-line explanation.
The helper exposes `mixedPackingFiles` for that disclosure; it is not an automatic penalty.

Whitespace-only changes and pure sequence packing earn zero reduction credit. The helper detects
whole-file cases through lexical token comparisons; it is not a general Lean parser. Mixed
format/strategy changes require hunk review or the same approved formatter/counter on both owned
views. If the structural saving cannot be separated reliably, present a proposal instead of an
automatic win. The metric supports readability judgment, not scoring.

Unsupported interpolated-string syntax makes automated code counts and hints unavailable for that
file. Source snapshots/hashes remain usable; `metricStatus: "unavailable"` and `unavailableFiles`
identify the gap, and full-scope totals/`metricWin` are null, never zero or a partial total passed off
as complete. Supported rows may still be inspected separately. Continue refactoring with a clearly
reviewed baseline/final comparison across the entire agreed scope, including helper/wiring costs.
Use a validated project counter when available, or explicit reviewed source/hunk accounting that
excludes prose deletion and line packing. State the method, affected files and any uncertainty; do
not invent exact numbers or naively parse nested interpolation as a plain string. The reviewer must
be able to establish worthwhile net reduction and readability from the comparison. If evidence is
insufficient, hold that candidate as a proposal and continue other work; the helper limitation alone
does not block the whole task.

Ancillary language/configuration growth counts as cost. Deletions in an unsupported language earn
no automatic credit because they may only remove prose. Report them separately or agree a validated
counter. The helper's legacy `metricWin` field is only a candidate hint, not a score or correctness/
readability acceptance. Its value is null when automated full-scope comparison is unavailable.

## Comparable timing: parent serial recipe

After a warm build, the default is three serial baseline and three serial final runs per affected
file using the same pins, imports/cache state, thread limit and quiet worker state. This is part of
the approved budget, not permission for a provider benchmark. A new helper file has no baseline
run: record zero prior contribution and measure its final cost. A removed file has no final run.
Compare the scope totals as well as unchanged entry points, and disclose changed coverage. Never
invent samples for a path that did not exist.

Before sampling, freeze `ELABORATION_CMD` as a Bash argv array for this file and actual installed
context. Where `lake lean` is supported, it is `( "$PROJECT_LAKE" lean "$SPEC_PATH" --
"${PROFILE_ARGS[@]}" )`; `PROFILE_ARGS` is empty unless the actual compiler advertises `--profile`.
On another pin use a validated equivalent with import preparation and the project's Lean arguments.
Unsupported profiling is unavailable detail, not a broken proof. Do not silently change argv/cache
conditions between baseline/final; if meaningful comparable elaboration cannot be established,
report timing inconclusive and hold the performance trade-off. The sampling loop is:

```bash
declare -p ELABORATION_CMD >/dev/null 2>&1 || { echo "FVS >> Validated elaboration argv required" >&2; exit 2; }
for SAMPLE in 1 2 3; do
  (
    set -C
    TIMEFORMAT='FVS_ELAPSED_SECONDS=%R'
    { time LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 "${ELABORATION_CMD[@]}"; } > "$TIMING_DIR/$PHASE-$SAMPLE.log" 2>&1
  )
  TIMING_STATUS=$?
  [ "$TIMING_STATUS" -eq 0 ] || exit "$TIMING_STATUS"
done
```

`PHASE` is baseline or final; use a separate fresh `TIMING_DIR` for each file. Record all samples,
actual build gate wall
time, cache/rebuilt state and the profiling phases the pin reports. The checked `--profile` probe
reported cumulative phases, not a complete per-declaration table. On that pin,
`profiler.threshold` defaults to 100 ms; declarations below it have no individual profile message.
Record the threshold actually used by the selected pin/project and keep it unchanged for comparable
runs; do not apply this4.31 default to another toolchain or override a project setting. Do not invent missing timings.
See the [pinned profiler option](https://github.com/leanprover/lean4/blob/v4.31.0/src/Lean/Util/Profile.lean#L23-L26). The syntax
is documented in [Lake 4.31 help](https://github.com/leanprover/lean4/blob/v4.31.0/src/lake/Lake/CLI/Help.lean#L679-L687)
and the pinned `lean --help`.

Use an existing project criterion first. Otherwise compare the three-run ranges and timer/noise
evidence: a consistent material slowdown beyond baseline variation blocks automatic acceptance
and becomes an owner trade-off. Three observations are not a statistical guarantee. Label noisy
or incomparable results inconclusive; do not compare a cached no-op with fresh elaboration or
assume decomposition is faster. Never delete global caches or acquire tools just for timing.

## Compatibility evidence and limits

Dependency-free tests exercised installed Lean/Lake **4.25.2, 4.31.0 and 4.35.0**, with network denied
and isolated temporary profiles. Each ran the file/import gates, protected type/body/axiom and
coverage-regression cases, reporting-helper limits, worked proof examples and timing-log recipe.
Installed Elan4.2.3 tests covered file, environment and directory overrides, rejection of an
uninstalled pin without installing, and unchanged pin/toolchain identities. These are bounded
fixtures, not a real consumer refactor, benchmark or universal compatibility claim.

Older4.19 source documents import-building `lake lean`, but its build-target parser differs from
the newer source-path selector. That version was not installed/tested here. Compare official
[4.19 target parsing](https://github.com/leanprover/lean4/blob/v4.19.0/src/lake/Lake/CLI/Build.lean),
[4.19 Lean command](https://github.com/leanprover/lean4/blob/v4.19.0/src/lake/Lake/CLI/Help.lean), and
[4.35 Lean command](https://github.com/leanprover/lean4/blob/v4.35.0/src/lake/Lake/CLI/Help.lean).
Keep4.31-specific printer/profiler/tactic citations scoped to their checked pin; another project
still needs its own capability/context validation. Custom parsers, private/module contexts and
other Elan state schemas may need the explicit project/review route. Never upgrade a project to
fit this matrix.

## Evidence tools and short examples

On checked Lean 4.31, `simp?`, `exact?` and `apply?` are
[core suggestion tactics](https://github.com/leanprover/lean4/blob/v4.31.0/src/Init/Tactics.lean).
[`grind?`](https://github.com/leanprover/lean4/blob/v4.31.0/src/Init/Grind/Tactics.lean#L283-L297)
can suggest a sufficient `grind only` call. Suggestions still need goal/type and gate checks.
`linter.unusedSimpArgs` and `linter.unnecessarySimpa` are enabled by default in that pin
([source](https://github.com/leanprover/lean4/blob/v4.31.0/src/Lean/Elab/Tactic/Simp.lean#L675-L685),
[source](https://github.com/leanprover/lean4/blob/v4.31.0/src/Lean/Elab/Tactic/Simpa.lean#L19-L23)).
They are evidence, not universal replacement rules. Revalidate availability for another consumer pin.

1. **Shared reasoning.** Two eight-code-line proofs repeat a zero/successor case split. A private
   six-line helper plus two two-line callers costs ten code lines instead of sixteen: net minus six,
   including the helper. Keep the target statements and explanations; search existing lemmas first.

```lean
/-- Classifies a natural number as zero or positive. -/
private theorem splitHelper (n : Nat) : n = 0 ∨ 0 < n := by
  cases n with
  | zero =>
    exact Or.inl rfl
  | succ k =>
    exact Or.inr (Nat.zero_lt_succ k)

theorem first (n : Nat) : n = 0 ∨ 0 < n := by
  exact splitHelper n
theorem second (n : Nat) : n = 0 ∨ 0 < n := by
  exact splitHelper n
```

2. **Existing result.** After checking the available `Nat.add_comm` type, replace a manual induction
   for the same statement with reuse. No helper cost is hidden:

```lean
theorem commDemo (a b : Nat) : a + b = b + a := by
  exact Nat.add_comm a b
```

3. **Non-win.** Joining these last two tactics with `;` only packs the same steps. It lowers raw
   code lines but earns zero structural reduction credit. Removing genuinely redundant reasoning
   would be a different candidate, subject to the usual gates:

```lean
theorem packingDemo (p : Prop) (h : p) : p := by
  have h' : p := h
  exact h'
```

The packed form is a non-win, despite one fewer physical code line:

```lean
theorem packingDemo (p : Prop) (h : p) : p := by
  have h' : p := h; exact h'
```

These small examples validate the accounting/strategy distinction, not a performance guarantee.

## Accept or stop

After workers stop, the parent serially runs every applicable recorded file gate, including import preparation,
and capture real statuses. After integrating a batch, check the complete affected scope and required
project/style/trust gates. Run the printed-boundary/context diffs and review protected source/attributes against the agreement.
A green default build alone is insufficient. Recover only this session's edits on failure;
preserve other work. A failed delegated child stops the batch rather than moving the work inline.

Retain a result only when the measured or explicitly reviewed full-scope net code total decreases without format/prose deletion credit, readability/prose and
the protected boundary are preserved, required checks pass, and comparable timing evidence has no
repeatable material regression. Otherwise present an explicit proposal/trade-off or restore the
session's changes. Keep any proposed diff visibly unaccepted until the owner decides.

Stop when worthwhile permitted opportunities are exhausted. Do not fill a pass budget with cosmetic
edits or stop at an arbitrary percentage. A budget/resource stop is partial completion with remaining
opportunities listed. Moving code without a net reduction can be a proposal, not an automatic win.
</patterns>

<output_format>
## Final report

Report scope and protected boundary; reused declarations and removed duplication; original/added
helper/wiring costs; baseline/final code LoC, helper cost, raw/prose deltas and net code delta; actual build/elaboration samples
and conditions; check outcomes; and the stopping reason. List remaining out-of-scope opportunities
with affected files and evidence. Disclose automated coverage gaps, the reviewed comparison route
and its result. Distinguish estimates, unavailable counts and measurements.

- `REFACTORED`: retained result meets all acceptance conditions; disclose partial completion if capped.
- `NO_CHANGE`: no source change retained; explain the search boundary and remaining proposals.
- `PROPOSAL`: scope/API/protected-meaning or net-cost/performance choice needs the owner; not accepted.
- `ERROR`: verification, dispatch or recovery failed; report actual diagnostics and retained state.

A worker's `REFACTORED` header describes a candidate patch, not whole-scope acceptance. The parent
checks the integrated result and reports the final status. No refactoring report is a proof receipt.
</output_format>

<provenance>
## Prior art

The ordinary-Lean entry point, compiled-proof prerequisite, strategy/reuse focus and helper locality
draw on Cameron Freer and the Lean 4 Theorem Proving Skill Contributors' MIT-licensed
[lean4-skills refactor command](https://github.com/cameronfreer/lean4-skills/blob/83582df9d9172456993929f32ac4dd9d99c6211c/plugins/lean4/commands/refactor.md).
The checked pin is `83582df9d9172456993929f32ac4dd9d99c6211c`; its
[license](https://github.com/cameronfreer/lean4-skills/blob/83582df9d9172456993929f32ac4dd9d99c6211c/LICENSE)
credits Copyright (c) 2025 Lean 4 Theorem Proving Skill Contributors. This guidance is newly written;
no upstream text or code is copied. Readability hints about sequence packing also draw on the
pinned [golf command](https://github.com/cameronfreer/lean4-skills/blob/83582df9d9172456993929f32ac4dd9d99c6211c/plugins/lean4/commands/golf.md);
FVS uses no hard semicolon rule or upstream scoring policy. The agreed FVS boundary governs.
</provenance>
