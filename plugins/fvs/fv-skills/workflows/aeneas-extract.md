<purpose>
Drive a Rust crate, folder, or file through the bounded Aeneas extraction repair loop:
PRE-FLIGHT (pin audit + clone resolution + mode selection) -> EXTRACT -> CLASSIFY -> KNOWN ISSUES
(look for an existing fix first) -> DISPATCH (A-apply / bisect / propose-B-gate / escalate) ->
WRITE AND REVIEW A PATCH (two different models) -> DOCUMENT (reversible records) ->
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
- A semantic (Category-B) change is gated by an independent assessor and an owner ratification
  token (the owner's own, or one from someone the owner explicitly delegated to, a person or a
  model or session the owner named, recorded on the stamp); the success oracle refuses completion
  while any token is absent.
- A tool blocker gets a known-issues check before any patch is written. A patch is written by one
  model and reviewed by a different one, with at most two review rounds before it goes to the
  owner. A reviewer's "no objection" is an ordinary review result and never a ratification;
  ratifying is a separate, authorized action.
- Patches are line-preserving, and every gate checks them against the one observer set the
  target agreed to, panic occurrence and the file and line it reports included.
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

**Patch pair.** A new patch for a tool blocker (Step 4a) is written by one model and checked by a
different one. The manifest shows two seats, `WRITER` and `REVIEWER`; a seat here is a model role
in this loop, not the orchestrator, worker or owner seat that `auto-seats.md` assigns to engine
operations. The user chooses the two at confirmation. The default writer is the user's saved
spec-writing selection (stage `fc_spec`); the default reviewer is the user's saved spec-review
selection (`spec_review`). The seats replace the
`extract_apply` / `extract_bisect` settings (for the writer) and the `extract_assess` settings (for
the reviewer) only for the dispatches in Step 4a; every other dispatch keeps its own stage.

- Each seat records its runtime and its model (and effort), because a model id means nothing
  without the runtime that serves it. The two seats must resolve to different models. If they
  resolve to the same one, stop and ask for a different pair; a noninteractive run stops and
  prints the exact remediation. Never pick one silently.
- A seat whose runtime is this one, and whose child dispatch can set the model, runs as a child of
  this session (the `Task` calls of Step 4a). A seat on another runtime, or on a runtime whose child
  dispatch cannot set a per-child model, runs through an external runner: that runtime's own
  authenticated command-line client (for example Claude Code CLI or Codex CLI, as `model-profiles.md`
  routes reviews), or an Agent Orchestrator worker session started with the seat's model. The
  brief is the same as the child's: the prompt inlines everything, the writer returns the staged
  patch file, and the reviewer returns the review record that ends in the `Reviewer verdict:` line.
  Record the runner, model and effort the run reports in the review record; never copy them from the
  request. A saved pair of a Claude writer and a Codex reviewer, or the other way round, therefore
  works as the default: it needs no change to the pair.
- Show a seat as unresolved, and ask the user for a replacement that differs from the other seat,
  only when the chosen runner is really unavailable: its client is not installed or not
  authenticated, no worker route can start it, or the saved selection leaves its model unset. A
  seat on another runtime is not unresolved for that reason alone. A noninteractive run stops with
  the exact remediation. Never switch to another runner silently.
- No model name is built into this workflow. The pair is whatever the user's manifest says.
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
loop can still run. Validate that a resolved clone path is a directory before any
`git -C <clone>` call.

### 1c. Pin audit -- warn-and-confirm, never silent, never hard-block

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
the fix). Then REQUIRE explicit user confirmation to proceed (warn-and-confirm: never
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

### Observer set -- named once, cited by every gate

The observer set is the list of behaviours a patch may be checked against: what a caller or a
user can observe of a function. It is agreed once per target. Every Category-B gate packet and
every reviewer check cites it; none defines "observable" again.

- Under the auto track the agreement names it, as one entry in the agreement's `conventions` list
  that starts with `Observer set:` (see `auto-init.md`). Read it from the agreement.
- Standalone, with no agreement, ask the user once and offer this proposal: `Observer set: return
  values, error results as callers distinguish them, external effects, panic occurrence and the
  file and line it reports. Not observed: timing, backtrace contents, debug formatting.` Write the
  answer to `<extract_workspace>/<target>/observer-set.md`, outside `equivalence-gate/`, and read
  that file on later runs. A change to it is recorded in the file with its date.
- A gate ratified before a change of the set was checked against the old set. The owner decides
  whether to fire that gate again.

**Outputs:** `SHAPE`, crate ROOT, resolved clone paths + workspace, `pin_context`, coverage
policy, observer set. Initialise the workspace tree `<extract_workspace>/<target>/` with subdirs
`equivalence-gate/`, `mwe/`, `drafts/`, `catalog-candidates/`, `escalations/`, `known-issues/`,
`patch-review/`.
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
PATCH_ENGINE="${CLAUDE_PLUGIN_ROOT}/scripts/fvs-extract-patches.mjs"
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
may have changed since the last one; an earlier cycle's copy is never reused. `OUT` lies in a durable
evidence directory, not a temporary one (`$HOME/.fvs/extractions` unless `FVS_EVIDENCE_DIR` says
otherwise): the extraction record, the oracle and the reviews cite files inside it (the LLBC and logs,
each crate's attempt and stage records, the published-file hashes, `tree/Cargo.lock`), and a
temporary directory can be cleared before anyone reads them. The whole attempt directory stays for as
long as the record that cites it does.

```bash
set -o pipefail
EVIDENCE_ROOT="${FVS_EVIDENCE_DIR:-$HOME/.fvs/extractions}"
mkdir -p "$EVIDENCE_ROOT" || exit 1
OUT="$(mktemp -d "$EVIDENCE_ROOT/$(basename "$CRATE_ROOT")-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")/copy"
RELEASE_DIR=...   # the release directory the spec names as `release` (relative to the project root, or absolute)
node "$PATCH_ENGINE" prepare --project-root "$CRATE_ROOT" --out "$OUT" --release "$RELEASE_DIR" || exit 1   # records the manifest, the workspace and the scope; refusal -> STOP
node "$PATCH_ENGINE" verify-tree --out "$OUT" || exit 1                  # before Charon: the copy is the recorded post-patch tree
# One recorded attempt. $EXTRACT_SPEC (JSON: release, crate, publishDir, charonArgs, cargoArgs) states the
# project's usual invocation in the supported form; the engine refuses anything else before recording.
# (A repository with several target crates uses a spec with a crates list: see "Several crates" below.)
node "$PATCH_ENGINE" attempt --out "$OUT" --spec "$EXTRACT_SPEC" || exit 1
# Charon runs in "$OUT/tree" with --dest-file "$OUT/<crate>.llbc", under the controlled environment.
node "$PATCH_ENGINE" run --out "$OUT" --step charon; CHARON_STATUS=$?   # 9 = Charon failed -> CLASSIFY
node "$PATCH_ENGINE" verify-tree --out "$OUT" || exit 1                  # after Charon: the tree it consumed is still the recorded one
# Aeneas on the recorded LLBC into a fresh "$OUT/aeneas-dest"; then the publication into publishDir.
node "$PATCH_ENGINE" run --out "$OUT" --step aeneas; AENEAS_STATUS=$?   # 9 = Aeneas failed -> CLASSIFY
node "$PATCH_ENGINE" run --out "$OUT" --step publish || exit 1           # refusal leaves publishDir unchanged -> STOP
node "$PATCH_ENGINE" verify-restore --out "$OUT" || exit 1               # the original sources still match the recorded start
LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build 2>&1 | tee build.log
test ${PIPESTATUS[0]} -eq 0 || echo "lean-layer failure"                 # read the TOOL's status, not the pipe's
```

The recorded attempt is what lets `/fvs:auto-extract`'s extraction record, and the Rust identity
record built from it, claim that the artifacts came from this attempt under its recorded supported
configuration. `run` executes each stage once, in order, under an environment it builds itself
(`HOME`, `RUSTUP_HOME`, `CARGO_HOME`, its own `PATH`, the release's pinned `RUSTUP_TOOLCHAIN`). It
records the tool hashes, the exact arguments and every cargo configuration file by hash. An
influential or unknown variable in the caller's environment, or a present cargo configuration file,
leaves the attempt unsupported; it is recorded by name only and never by value. The `attempt` message
names them (`unsupported: NAME (class), ...`): prepare a new copy and run the engine from a shell
without them, for example by starting each engine command with `env -i HOME="$HOME" PATH="$PATH"` (a
coding agent's shell often carries such variables; the extraction is only recorded as supported when
none is left). Every stage and the
final check derive the invocation again and re-read the cargo configuration files and the toolchain
identity; any difference from the recorded attempt refuses the stage. A failed or
interrupted stage ends the attempt: prepare a new copy to retry. Publication writes only into
`publishDir`, which must be empty or hold only files an earlier publication owns, unmodified; it never
overwrites a maintained file and never deletes. When the project's invocation is outside the
supported contract (`attempt` refuses with `invalid-input`), run the project's own Charon command in
`"$OUT/tree"` with `--dest-file "$OUT/<crate>.llbc"` and Aeneas as before. That extraction can still
be recorded, but it carries no recorded attempt and stays unbound.

#### Several crates

A repository whose crates call each other is extracted crate by crate inside the ONE prepared
copy. The owner decides which in-repo crates are verification targets (by default every crate
that has a library); each crate left out is declared a non-target, and only the items of a
non-target may become assumptions. `prepare --release` reads the workspace of the checkout and of the
copy (cargo only reads) and records both, and the attempt refuses unless every in-repo library crate of
the original workspace is accounted for: a target, a `nonTargets` entry (its sources are in the copy),
or a `dropped` entry (they are not: the crate is outside the copy, or a patch replaced its path
dependency by a registry release). A several-crate attempt on a copy prepared without `--release` is
refused. A crate that reaches Charon's output undeclared is refused there as well.

`prepare` always records the scope of the extraction in the manifest (`scope`), with or without the
release, because a single crate is established, never inferred from missing data. With the release,
cargo's inventory gives `{ kind: 'multi-crate' | 'single-crate', basis: 'cargo', libraryCrates }`
(multi-crate when the checkout holds two or more library crates). Without it nothing reads cargo, so
`kind: 'single-crate'` (`basis: 'manifest'`) is claimed only when the project and the copy each hold one
manifest that is a plain package: no `[workspace]`, `[patch]` or `[replace]` table, no workspace
inheritance, no path dependency, a second `Cargo.toml` nowhere among the inputs, and no workspace
manifest in a directory above the project or the copy. Anything else is `kind: 'unknown'` with the
reason, and a single-crate `attempt` on an unknown scope is refused (prepare a new copy with
`--release`); so is a copy whose manifest records no scope (prepared before it was recorded). The
attempt, each unit's record and `attempt-status` (`run.scope`) carry the scope; `status --out` shows it
for a copy that has no attempt.

```bash
RELEASE_DIR=...   # the release directory the spec names as `release` (relative to the project root, or absolute)
node "$PATCH_ENGINE" crates --project-root "$CRATE_ROOT" --release "$RELEASE_DIR"   # a fresh checkout: every in-repo crate, and the extraction.inputs a copy needs
node "$PATCH_ENGINE" crates --out "$OUT" --release "$RELEASE_DIR"   # advisory: in-repo crates, their in-repo dependencies, an order (providers first)
node "$PATCH_ENGINE" attempt --out "$OUT" --spec "$EXTRACT_SPEC"     # a spec with a crates list records one attempt chain per crate
# then, for each crate in the attempt's `order` (providers before the crates that import them):
node "$PATCH_ENGINE" run --out "$OUT" --step charon  --crate "$CRATE"
node "$PATCH_ENGINE" run --out "$OUT" --step aeneas  --crate "$CRATE"
node "$PATCH_ENGINE" run --out "$OUT" --step publish --crate "$CRATE"
node "$PATCH_ENGINE" attempt-status --out "$OUT"                      # refuses unless EVERY crate is complete
```

`crates` runs `cargo metadata --no-deps --offline` and writes nothing. On a checkout it offers every
in-repo crate: the workspace members and the path dependencies inside the checkout that are not
members, followed to any depth (package, crate name, directory, `member`, the in-repo crates it
depends on, an order with providers first, so a member comes after the non-member crates it needs),
proposes the `extraction.inputs` a copy needs (workspace manifest and lock, every member and in-repo
path dependency) and names the symbolic links under them. A copy holds regular
files only, and a build script, `include_str!` or `include_bytes!` may read a link of any name and
fall back silently when it is missing, so no link is left out on a guess. A link the build certainly
reads (a manifest, lock, build script, toolchain or cargo configuration file, a Rust source file,
anything under `src`, or an input itself) is listed in `links` and refused whatever the owner says:
the owner replaces it by its content or leaves its crate out. Every other link (generated C headers,
say) is refused too, unless the owner lists it in `extraction.unreadLinks` (`[{ path, reason }]`) as a
link the build does not read. `crates` proposes that list: `proposedUnreadLinks` holds each such link
with its `target`, a `reason` to adopt, and `buildScript` (true when the crate that holds it has a
build script, which could read it). Show the whole proposal to the user and write it into
`extraction.unreadLinks` only after their yes; never edit the list on your own. `unreadLinks` holds
the links already listed (with their reasons) and `staleUnreadLinks` the entries that name no link
under the inputs, which `check` and `prepare` refuse. A listed link is not copied; `check` and the
manifest (`source.links`) record it with its target and reason. It also names
a member whose real directory lies outside the checkout (`outside`). On a prepared copy it also names the path
dependencies the patches removed (`pathDependenciesRemoved`) and the packages the copy lacks
(`packagesNotInCopy`), so a patch that hides an in-repo crate is never silent; the attempt enforces
the same from the workspace that `prepare --release` recorded. A workspace cargo cannot read (a missing member, inheritance without a workspace, a path
dependency without a manifest) is reported with cargo's first error lines.

**A workspace larger than the verification targets.** A copy holds a manifest for every workspace
member, and a large repository (libcrux has 43 in-repo packages, one of them with a 42 MB test-vector
directory) needs far more than the crates the owner verifies. `trim-workspace` prints, and writes
nothing, the translation patches that cut the workspace down:

```bash
node "$PATCH_ENGINE" trim-workspace --project-root "$CRATE_ROOT" --release "$RELEASE_DIR" \
  --keep "$TARGET_CRATES"   # comma-separated crate or package names; add --dev-dependencies drop to prune test-only path dependencies
```

The kept set is the `--keep` crates plus every in-repo crate they need by path. The root manifest's
`members` list loses the rest, and a root package that is not kept loses its package tables so the
workspace is virtual. With `--dev-dependencies drop`, a path dev-dependency on a crate that is not
needed otherwise is removed from the kept manifest instead of pulling that crate in; the result
lists those crates under `devOnly` with their size in bytes. The result also names the `kept` and
`dropped` crates (the library ones among the dropped are what the spec lists as `dropped`), the
`extraction.inputs` the trimmed copy needs (`config`), and each patch with its `sha256`. Before
printing, the command has cargo read a trial copy of exactly those inputs and applies every patch to
a clean copy of the originals. It refuses a `--keep` name that is not an in-repo crate or has no
library, a `members` pattern (the owner lists the members one by one first), a manifest it cannot cut
line by line, a path dependency outside the checkout, and a symbolic link inside the kept crates that
the build certainly reads (`links`, as in `crates`). Every other link under the kept crates is reported
as `crates` reports it: `unreadLinks` (already listed in `extraction.unreadLinks`),
`proposedUnreadLinks` (each with its target and a suggested reason, for the owner to list) and
`staleUnreadLinks` (listed, but no longer a link under these inputs). The printed `config` holds the
inputs only; the owner's yes adds the link entries.

Show the owner the kept and dropped crates, the `devOnly` bytes and the patches, and wait for a
yes. That yes covers installing the patches, writing the printed `extraction.inputs` AND bringing
`extraction.unreadLinks` in line with them (removing each `staleUnreadLinks` entry, a link of a crate
the trim leaves out, which `prepare` would refuse, and adding the `proposedUnreadLinks` the owner
adopts) into the
project's configuration; the owner may instead keep a larger selection by running it again with other
`--keep` names. On the yes, install each printed patch as in Step 6 (write it as
`translation-patches/<name>.patch`, append the name to `series`, run `check`); the engine wrote them
from the owner's choice of crates and has already applied them, so there is no model-written text to
review, and the owner's yes is the ratification. Record each dropped library crate in the spec's
`dropped` with the reason "left out by the owner's workspace trim". The trimmed manifests remove
packages the existing `Cargo.lock` still lists, so run the next `prepare` with `--lock update
--release "$RELEASE_DIR"` (or keep a lock that already matches); `crates --out "$OUT"` then lists the
kept crates and shows the others under `packagesNotInCopy`.

The spec keeps the single-crate fields as a base (`release`, `cargoArgs`, `charonArgs`) and adds
`main` (the crate the extraction record is about), `crates` (one entry per target) and
`nonTargets`:

| Field | Meaning |
|-------|---------|
| `crates[].crate`, `package`, `dir` | the crate name Charon labels items with (underscored), the cargo package name, and its directory in the copy |
| `crates[].publishDir` | where that crate's Lean is published; one folder per crate, none inside another |
| `crates[].moduleRoot` | the Lean module name of that folder, so another crate can import it |
| `crates[].stitch` | `[{ crate, assume }]`: this crate calls target `crate`; its Lean imports that crate's published module (see below) |
| `crates[].substitutions` | `[{ file, find, replace, count, reason }]`: a rename of a name Lean cannot read, with the exact number of matches. `find` holds U+00B7 (Aeneas writes a shadowed local as `len·`), `replace` is a plain identifier that occurs nowhere in the crate's generated Lean, no match follows a `.`, and the rename is made inside a definition body only. Every match has to be an identifier in code: a match inside a string literal, a character literal or a comment (or in text the engine cannot read to the end, such as an unclosed string) refuses the whole substitution when the file is published, so literal data is never renamed. Any other edit is refused: it belongs in a patch of the Rust source. Recorded with before and after hashes and recomputed by `attempt-status` |
| `nonTargets` | `[{ crate, dir }]`: in-repo crates the owner decided not to verify, with their sources in the copy |
| `dropped` | `[{ crate, reason }]`: in-repo crates left out of the copy by the owner's decision, or whose path dependency a patch replaced by a registry release (the single-crate spec has this field too); the reason says who decided and why, and a crate still in the copy cannot be dropped |

Every crate has its own Charon, Aeneas and publish chain, so a failing crate ends only its own
chain. `attempt-status` refuses until every crate is complete and then lists each crate's status;
`--crate NAME` reads one crate.

The attempt also records its roster: `main`, the `order` (providers first), one row per crate with
its `package`, `dir` and the crates it is `stitch`ed to, the `nonTargets` and the `dropped` crates,
in that canonical form (fixed key order, every list sorted except the order). The roster and its
hash `rosterSha256` are written into the top-level record and into every crate's own attempt record,
and the status returns both (`run.roster`, `run.rosterSha256`; each crate's row carries the hash).
Whoever reads the status can bind to that one hash. `attempt-status` and every stage rebuild the
roster from the crates' records and refuse when it differs from the recorded one: a crate left out
of the top-level record (a failed crate's row deleted), a changed `main`, `dropped`, package,
directory or imports, an order that the stitching does not give, or a directory under `units/` that
is not in the roster. A crate's own directory is not read alone: `attempt-status --out
OUT/units/NAME` is refused and points to the copy, where the roster is checked. Each unit row is a whole single-crate run plus its `imports`,
`stitch`, `hasErrors` (the items Aeneas could not translate; they are never roots),
`foreignCrates` (each crate the LLBC reaches, as `target`, `non-target` or `external`; an external says where it comes from: `origin` `toolchain` or `registry`, with the locked `package`, `version` and `checksum` for a registry crate) and the
pinned sources of each non-target.

What the Charon stage accepts as a source. Every source file the LLBC names lands in exactly one
class, or the stage fails. A path relative to the copy, or absolute and under it, is a file of the
copy: it must be a file the prepared copy records, its label must be the crate that owns its
directory, and the main crate's contents must be the recorded bytes. A `/rustc/library/...` path is
the toolchain and must be labelled with a crate of the toolchain (`core`, `alloc`, `std`,
`proc_macro`, `test`; the label need not match the directory, since `core` vendors `stdarch`). A path
under `<cargo home>/registry/src/<index>/<name>-<version>/`, where the cargo home is the `CARGO_HOME`
the tools ran with (a path that merely ends like one is not a registry path), is a registry package
only when all of these hold: its label is neither a declared crate nor a crate of the toolchain, the
`Cargo.lock` in the copy lists `<name>-<version>` with a `registry+` source and a checksum, and the
archive that cargo kept at `<cargo home>/registry/cache/<index>/<name>-<version>.crate` has exactly that
checksum. Every file the LLBC read from that package is then compared with the archive, which the
engine reads without unpacking it: the file must be a plain file (not a link, at the file or at any
directory above it) at its own place under the cargo home's unpacked copy, the archive must hold it as
a regular file, and its bytes, and the `contents` the LLBC carries for it when it carries any, must be
the archive entry's bytes. A changed, missing, redirected or non-archive file refuses the stage even
though the archive's checksum is the lock's; so does an archive that cannot be read as a package (not
gzip, a repeated or unknown entry, a wrong header checksum, trailing bytes). Files of the package that
the LLBC does not read are not compared. Only the cargo home itself may be reached through a link: a
cargo home whose `registry`, `src` or index directory is a link (a cache kept on another volume) makes
every registry file read as redirected, and the stage is refused until the cargo home is a real tree. One crate label cannot stand behind two different identities. A crate that is none of these
and none of the declared crates, including one that is only a name in the `Cargo.lock` (a path, git
or registry package with no source file in the LLBC), is refused, not filed as external. Everything else is refused with
the path or form named: a path outside the copy (another tree, an absolute path into the original
checkout), a file the copy does not record (an input missing from `extraction.inputs`, or a file a
build script made), a `Virtual` or `NotReal` name, and a git dependency's checkout. Those forms have
not been seen in real Charon output yet, so the engine does not guess at them; a project that needs
one has to bring the crate in as a declared crate or change the dependency.

Stitching. When crate B calls target crate A, Aeneas writes B's copy of A's items as axioms that
carry only a type. Publication replaces each such axiom by an alias of A's real definition with
the type B was translated against, and adds `public import <A moduleRoot>.<file>` to B's Lean.
The signature of each alias is checked in two places. The engine compares the two signatures where
it can read both and refuses a difference it can read (`textComparison` is `equal` or `undecided`;
`differ` never reaches a record). The engine cannot run Lean, so the comparison that decides is
generated into the published module: after the aliases it appends a `run_cmd` block that requires
each alias to have the same number of universe parameters as A's constant and a declared type
definitionally equal to A's type (inside `Result` for a constant). An alias alone elaborates by
instantiating what A keeps general (an implicit type argument, an instance argument, a universe),
and the block rejects exactly those. Every replaced item carries `check: pending-lean-build`, never
a finished check: the comparison has run once the published modules build with exit 0, and the
record lists each generated block (`leanChecks`: the file and its project-relative path, its module,
the block's byte length and hash, and the hash of the whole published file, which is the file's
`publication` hash; the block is the exact end of that file) so that `attempt-status` recomputes it. Functions and types become reducible aliases; a constant becomes a plain definition `Result.ok` of A's
constant, so proof automation keeps seeing the constant. Every existing name stays valid. Nothing
falls back to an axiom silently. A crate whose Charon output reaches a target crate A must have a
`stitch` entry for A, or its publication fails (declare A a non-target if the owner decides to
leave A out). An item A does not declare (for example a module excluded from A's translation) must
be named under `assume`, by a module or item path and never the whole crate; `assume` never covers
an item A declares, an entry that matches nothing is refused as stale, and the items taken as
assumed are recorded and each needs an externals record. The same holds for a definition: when B's
Lean defines an item of A itself (Aeneas translated it in B instead of leaving an axiom), the item
has two declarations if A defines it too, and A's theorems then concern the other one, so
publication refuses; if A does not define it, it has to sit under an `assume` prefix, and it is
recorded as a copy with the prefix that covers it. An item A declares but leaves opaque stays
an alias of A's own axiom: it is recorded as `providerOpaque` and needs A's externals record. After
stitching, every axiom left in the published Lean is classified by the crate its Rust path names: an
axiom for another target's item that is not a recorded assumption, or one with no readable Rust path,
fails publication. What B imports is what A published, so publication stitches only after A's
own chain is complete and consistent (every stage recorded, the published files as recorded, A's own
edits reproducing): A's inventory and the `providerDeclSha256` of each replaced item come from A's
final published Lean, substitutions and stitching included, never from the raw Aeneas output, and a
name that Lean text declares twice (in A or in B) is refused instead of bound to the last one. The
record names the hash of A's publish stage (`providerStage`, `providerStageSha256`). The generated files are edited only by these two
declared, recorded transforms; the `translation.json` Aeneas wrote is left as it is. Two caveats:
an item whose signature involves another crate's types that B and A each wrote out separately
cannot be aliased, and two crates that reach the same external Rust item each keep their own
axiom for it.

A project that pins the axioms a theorem depends on (a checked message around `#print axioms`) sees
those pinned lists change after stitching: the items stitching replaced leave them, and the axioms
the provider's own translation still rests on enter. Updating the pins is project-side work, and each
axiom that enters needs an externals record; this workflow never regenerates a pin in the project,
and its report says so as the next action.

Publication never overwrites a file it does not own. When a folder already holds committed
extraction output from an earlier layout, the owner removes it once; later runs own the folder.

Send Charon's `.llbc` file and logs outside `"$OUT/tree"` (`--dest-file` as above; without it
Charon writes into its working directory). Only cargo's `target/` directory may appear in the copy
after `prepare`; any other new, edited or deleted file there fails `verify-tree`. The copy needs a
`Cargo.lock` that matches its patched manifests, so that cargo has nothing to write in it. Keep one
in the project and current (it need not be committed, or may be ignored by git: it is not counted
as an uncommitted source, and its own hash is recorded), or let `prepare` bring it in line once: `--lock update --release
"$RELEASE_DIR"` (the release directory the spec names) runs `cargo generate-lockfile` in the copy when the project has no lock, and
`cargo update --workspace` when it has one (every version the lock pins is kept; only what the
patched manifests added or dropped changes). Either may need network access. The manifest records
the lock's hash and origin (`read`, `generated` or `updated`, and the hash it started from); the
checkout is not touched, and `verify-restore` refuses when the project's own `Cargo.lock` is no
longer the one recorded at the start, and `verify-tree` names a lock that a tool rewrote in the
copy. `attempt` refuses a copy that has no lock. A generated or updated lock pins
whatever resolved at that moment, and a later `prepare` may resolve newer versions, so the lock
(`"$OUT/tree/Cargo.lock"`) is kept as part of the whole attempt directory, in the evidence directory
above, for as long as the extraction record is. When Charon fails, still run
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

<step name="known_issues">
## Step 3a: KNOWN ISSUES FIRST -- look for an existing fix before writing a patch

This step follows the proposed change, not the layer that failed. It runs whenever the next move is a
new or changed patch to the Rust extraction inputs, whichever layer reported the blocker. Aeneas can
exit cleanly and emit Lean that does not build, so a repair in the Rust source is often prompted by
a `lean` failure: a Rust identifier that contains a middle dot, repaired by renaming it in the Rust
source, is one. That repair is a new patch like any other and takes this step and Step 4a. The
`pin_context` from Step 1c names the Aeneas and Charon revisions the answer has to hold for.

| Proposed change | Step 3a | Step 4a | Writer seat dispatches |
|-----------------|---------|---------|------------------------|
| A Category-A catalog recipe that edits the Rust extraction inputs (a source rewrite, an opacity annotation, a gated build script) | runs | runs | `fvs-extract-applier` |
| A Category-B catalog recipe (`ITER-ADAPTER`, `NO-BOTTOMS`), or an A-opacity recipe on a function inside required coverage | runs | runs, then the gate | `fvs-extract-applier`, staging only: it never installs |
| A `NOVEL` signature at any layer (`charon`, `aeneas`, `split`, `tweaks` or `lean`), before any bisecting | runs | runs when the bisector proposes a change to the Rust inputs | `fvs-extract-bisector` |
| A repair of a downstream `lean` failure that lands in the Rust source | runs | runs | the role that proposed it: the applier for a catalog match, the bisector for a `NOVEL` signature |
| A recipe that edits no Rust input: a Lean-side or project edit such as `namespace-cascade`, `refresh-manifest` or a `tweaks-substitution` | skipped | skipped | none: the applier makes the ordinary edit |

1. **Look in the tools' own trackers.** Search the Aeneas and Charon upstream repositories for the
   stripped `signature` from Step 3: open and closed issues and pull requests, and the release
   notes and changelog, at the pinned revisions and at the newest release. Search with the
   stripped signature only. For a failure a later layer reported, that is the stripped error plus
   the kind of Rust construct behind it (an identifier with a middle dot, say), never the
   construct's name. Never put a project name, a path, source text or a line of the code being
   verified in a query: a search leaves this machine.
2. **Read only.** Use the tracker's read interface, as the draft investigator does: a `gh api`
   call with an explicit read method, `gh search`, or `curl` on a public page. This step never
   posts, comments, labels, reacts or opens anything.
3. **Record one outcome for the signature.** Every outcome except the last two carries a link.

   | Outcome | Meaning | Next |
   |---------|---------|------|
   | `fix, no source change` | an option, flag or configuration the pinned tools already accept | Use it and write no patch. If it makes a coverage target opaque, the coverage-escalation guard in Step 4 still sends it to the gate |
   | `workaround that edits source` | an issue or release note gives a source-level rewrite | Take the patch route (Step 4a). The patch's `Why:` line and the gate packet cite the link. A known workaround is still a patch: it is written, reviewed and gated like any other |
   | `fix only in a newer version` | the fix landed after the pinned revisions | Report it to the owner as a pin-change option, with the link. Never change a pin on your own. The patch route (Step 4a) continues for the current pin |
   | `none found` | the search ran and found nothing relevant | Take the patch route (Step 4a) |
   | `not checked: <why>` | the tracker was unreachable or the search could not run | Take the patch route (Step 4a). The record says `not checked`, never `none found` |

**Cached record.** Keep one short record per pin pair at
`<extract_workspace>/<target>/known-issues/<aeneas-rev>-<charon-rev>.md`, using the first twelve
characters of each revision. Each entry is keyed by the stripped signature and holds the date, the
sources searched with their links, the outcome, and the option or workaround that was used. A later
cycle or run on the same pin pair reads the record instead of searching again; a new pin pair starts
a new record file; the owner can ask for a fresh search at any time. A `not checked` entry is not an
answer: it is never reused, and the search is retried the next time the signature comes up.

**When the pin changes.** After the owner has confirmed a pin change (Step 1c), find out which
patches the new tools no longer need before relying on the old series. In a throwaway copy of the
crate root outside the checkout, committed in its own git repository so `prepare` sees a clean
original, remove one patch at a time: take its name out of that copy's `series`, move its file out
of that copy's `translation-patches/`, prepare a fresh extraction copy and replay the oracle of the
layer that patch cleared (the layer in the Step 3a record for its signature and in the patch's
`Why:` line), then record whether the signature that patch cleared still appears at that layer.
A patch that cleared a Charon or Aeneas failure is replayed by running Charon and Aeneas. A patch
that repairs generated Lean (an identifier rewrite that makes a generated name valid, a closure
rewrite, any patch whose signature failed at the `lean` layer) is replayed through an isolated Lean
build as well: after Charon and Aeneas, build the Lean that copy's Aeneas output produced in a
throwaway Lean project outside the checkout, with its own build output. Publication stays disabled
throughout, so nothing is written into the project's `publishDir`, and no patch is retired during
the recheck. When the layer's oracle cannot be replayed (no isolated Lean build is available), the
patch is reported as `not checked: <why>`, never as no longer needed.
Report the patches that no longer seem needed only when the oracle of their own layer passed
without them. This only proposes. The loop never retires
a patch on its own: retirement goes through the retire step in Step 6 and, for a B patch, the gate.
</step>

<step name="dispatch">
## Step 4: DISPATCH -- route by category + coverage_impact

**Fresh child per pass:** every pass or round of this loop that delegates work dispatches a new
child of the role named here, with the current inputs and the confirmed settings; the parent never
performs that role's work itself. Wait for the child's terminal result through the runtime's normal
wait or notification; a spawn acknowledgement or progress message is not a result. If the dispatch
fails, the child cannot be confirmed, or it ends in a terminal error, stop and report the affected
pass. Valid results such as a failed build, NOVEL, REJECT, REVISE or FOLLOWUP still route as this
step describes, and parent-owned baseline, build, revert and report steps stay with the parent.

Route the classified blocker:

- **Category-A** (safe-by-construction; A-mechanical or A-opacity on a leaf you intend to
  trust) -> dispatch the applier, which applies one recipe alone and writes the reversible
  records:

  ```
  Task(subagent_type="fvs-extract-applier", model=$APPLIER_MODEL, reasoning_effort=$APPLIER_EFFORT, ...)
  ```

  The coverage-escalation guard fires here: **A-opacity applied to a function inside required
  coverage is NOT auto-applied** -- axiomatizing or excluding a verification target is a
  meaning-affecting decision, so it becomes Category-B and takes the Category-B route below.

  The dispatch prompt names `MODE`. In patch mode a change to the Rust extraction inputs is
  written as a translation patch (Step 6), never edited into the checkout, and the applier writes
  no `src-modifications.*` file for any recipe, including non-Rust repairs such as
  `namespace-cascade` and `refresh-manifest`, which stay ordinary edits; the prompt inlines the
  Step 6 header fields, the authoring recipe, the line-preserving rule and the `check` command,
  because the applier has no @-references. A recipe that edits the Rust extraction inputs, at any
  layer, starts with Step 3a, and the applier then runs as the writer seat of Step 4a.

- **NOVEL** -> whichever layer failed, run Step 3a first. Then dispatch the bisector
  to shrink/grow to a minimal failing example (MFE) under the variant-budget, emit a
  schema-conformant `candidate` (real evidence = the MFE path + observed `pin_context`) to
  `catalog-candidates/`, and a PROPOSED fix. The bisector proposes, never disposes:

  ```
  Task(subagent_type="fvs-extract-bisector", model=$BISECTOR_MODEL, reasoning_effort=$BISECTOR_EFFORT, ...)
  ```

  The bisector's isolation work runs with the `extract_bisect` settings. When it proposes a
  patch, the writing and the review of that patch follow Step 4a, and the bisector's prompt
  inlines the same Step 6 material as the applier's, line-preserving rule included. A NOVEL
  B-fix routes to the GATE after that review.

- **Forced Category-B** (a matched Category-B recipe such as `ITER-ADAPTER` or `NO-BOTTOMS`, or
  any meaning-judgment: "this branch is unreachable", "these compute the same", an ungated source
  rewrite, or A-opacity on a coverage target) -> in patch mode, Step 3a and Step 4a first, then the
  synchronous GATE (Step 5); in legacy mode, straight to the gate with the proposer's section 1.
  The proposal is written by the writer seat: the applier for a matched recipe or a coverage-guard
  escalation, in staging form (it authors the patch, writes it to `patch-review/`, and installs
  nothing, so the applier's ban on installing a Category-B change stands), and the bisector for a
  `NOVEL` signature. The gate still decides whether anything is installed.

- **Escalate conditions** (attempt-cap hit, same `{layer, signature}` recurrence, forced
  toolchain-remediation, a gate rejection, a patch the reviewer still objects to after the second
  round, or a gap no patch can fix) -> ESCALATE (Step 8).
</step>

<step name="patch_review">
## Step 4a: WRITE AND REVIEW A PATCH -- two different models, at most two rounds

This step takes over when Step 3a leaves a patch route and the change is a new or changed patch to
the Rust extraction inputs, whichever layer's failure prompted it (patch mode only; legacy mode
keeps its own steps). It reuses the proposer dispatches of Step 4 and the assessor dispatch of
Step 5 under the `WRITER` and `REVIEWER` seats from `resolve_models`. It adds no agent and no stage.
Each round dispatches a new child, or a new run of the seat's external runner when `resolve_models`
routes the seat there: the `Task` calls below show the child form, and the runner gets the same
prompt and returns the same files.

Step 3a has recorded an outcome for the signature before the first writer dispatch. A proposer can
find that the repair lands in the Rust source only after its dispatch (a `lean` failure that turns
out to need a rename in the Rust): stage its result, install nothing, run Step 3a now, and then
continue here.

1. **Write.** Dispatch the role that proposed the change (the applier for a matched recipe,
   Category A or Category B, the bisector for a NOVEL signature) with the writer seat's settings:

   ```
   Task(subagent_type="fvs-extract-applier", model=$WRITER_MODEL, reasoning_effort=$WRITER_EFFORT, ...)
   ```

   (`fvs-extract-bisector` for a NOVEL signature.) For a Category-B recipe the applier is the writer
   in staging form: the prompt says so, and it stages the proposal and installs nothing. The prompt
   inlines the Step 3a outcome with its
   link, the Step 6 header fields, the authoring recipe, the line-preserving rule with its
   zero-context line-count command (Step 6) and the observer set, because the child has no
   @-references. The writer authors the patch in a scratch directory inside the extraction workspace
   and stages it, with the Write tool, as
   `<extract_workspace>/<target>/patch-review/<change-id>.patch`. It does not touch
   `translation-patches/` or `series`, and it does not run the patch engine's `check`: that check
   reads only patches listed in `series`, so it cannot see a staged patch and runs after
   installation (Step 6).
2. **Review.** Dispatch a new `fvs-equivalence-assessor` with the reviewer seat's settings:

   ```
   Task(subagent_type="fvs-equivalence-assessor", model=$REVIEWER_MODEL, reasoning_effort=$REVIEWER_EFFORT, ...)
   ```

   The prompt gives it the staged patch, the stripped signature, the Step 3a record, the observer
   set and the gate packet template. It reads as an adversary and tries to break the patch. It runs
   the "Patch checks" in its brief (line preservation per hunk, each observer-set member against
   the change, panic occurrence and the file and line it reports); for a Category-B patch it also
   drafts sections 2-6 of the packet, which is the assessor dispatch Step 5 describes. It ends with
   one line: `Reviewer verdict: no objection` or `Reviewer verdict: objection: <observer or line>`.
   "No objection" is not a ratification: it stamps nothing and leaves the token rule of Step 5
   unchanged. The review record is kept as `patch-review/<change-id>.round-<n>.md`, outside
   `equivalence-gate/`.
3. **Round rule.** An objection goes back to a new writer dispatch together with the reviewer's
   text (round two). A second objection stops work on this patch: ESCALATE (Step 8) with both
   rounds and the staged patch. There is no third round. A patch the reviewer objects to is never
   installed and never gets a gate packet, so a review round is not a patch attempt against the
   attempt-cap (Step 7); review rounds have their own bound there. This differs from a human
   rejection at the gate (Step 5): a rejected packet is recorded as `status: rejected` and
   escalated, and the identical change is never re-submitted.
4. **After "no objection".** Category B: write the packet to `equivalence-gate/<change-id>.md` from
   the reviewer's sections 2-6, with the `Reviewer verdict:` line, hold the patch beside it as
   Step 5 describes, and go to the GATE. Category A: install the patch byte for byte as
   `translation-patches/<name>.patch`, append it to `series`, run `check`, and re-EXTRACT (Step 2)
   with a new `prepare`.
5. **A gap no patch can fix.** When the writer reports that no line-preserving patch clears the
   blocker, or the reviewer's objection is one no rewrite can meet, do not keep trying. Record the
   function as a boundary (Step 8): its reason, the roots that reach it, and the tool issue it
   waits for, or `none found` when Step 3a found none. Whether the coverage target stays
   verified, becomes an accepted assumption, or blocks the run is the owner's explicit decision.
</step>

<step name="gate">
## Step 5: GATE -- the independence invariant (orchestrator-fired, independent assessor)

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
   independence is enforced by topology, not convention.) For a new patch the reviewer dispatch
   of Step 4a is this assessor dispatch; do not dispatch a second one for the same patch bytes.
3. The orchestrator HALTS and presents the rendered 7-field packet to the owner. **Section 7
   (the stamper's own independent checklist) and the ratification token come last, and only from
   the owner or from someone the owner has explicitly delegated to.** The reviewer's verdict of
   Step 4a is an ordinary review result: it never stamps, and the packet's section 7 is not filled
   from it. Ratifying is a separate action by an authorized actor. The delegate can be a person, or
   a model or session that the owner named, and it acts only inside the scope the owner recorded
   (which changes it may decide). It is independent of the patch author: never the model or
   session that wrote the patch. If the owner named the model that reviewed the patch, that model
   may ratify, but only in its own action after the verdict, and it works section 7 itself. A
   delegation is recorded: the stamp's `Reviewed-by:` line names the delegate (a model or session
   by runtime, model and session id) and its `Delegation:` line says where the owner recorded the
   delegation and its scope (the agreement, or a dated line the owner wrote); the owner's own stamp
   reads `Delegation: owner`. The orchestrator records the stamp lines the delegate returns
   unchanged. With no delegation on record there is no stamp: neither the loop, nor the writer,
   nor an assessor dispatch stamps on its own. The loop does NOT re-extract until the token is
   present, and it waits for it synchronously.

The packet is written to `<extract_workspace>/<target>/equivalence-gate/<change-id>.md`; it is
the reversible record for the B-change (the minimized diff + the stamped token).

**Patch mode.** Section 1 is the candidate translation patch itself, authored as in Step 6 with
its complete header (`Classification: B` and an `Evidence:` line naming this packet) and held
beside the packet as `equivalence-gate/<change-id>.patch`. It is NOT in `translation-patches/` or
`series` until ratified. The packet records the patch's identity on a `patch-file:` line (its
file name) and a `patch-sha256:` line (the sha256 of those exact bytes), so the token binds to
them: a patch edited after ratification no longer matches its packet. A migrated patch (one
`migrate` produced) is already installed and its legacy approval is historical metadata only
(Step 9), so the gate is fired for it as it stands: section 1 is the installed patch, and the
packet records `patch-file:` and `patch-sha256:` of the installed bytes.

A packet is **active** unless it carries a `status: rejected`, `status: superseded` or
`status: retired` line. The record check and the ratification check (Step 9) read active packets
only; retained packets stay in `equivalence-gate/` as the audit trail and are never deleted.

- **Ratified** (`equivalence-ratified:` present) -> the change stands. Patch mode, by what the
  patch is:
  - A new proposal (staged beside its packet) is installed byte for byte as
    `translation-patches/<name>.patch` and appended to `series`; then run `check`.
  - A patch that is already installed (a migrated patch, or any patch already listed in `series`)
    is NOT installed again. Its bytes and its existing `series` entry stay exactly as they are,
    because a second entry makes `check` refuse the list; only `check` follows.

  Either way, re-EXTRACT (Step 2) with a new `prepare`. Legacy mode: apply the change in place
  and re-EXTRACT (Step 2).
- **Rejected** -> record the rejection reason and a `status: rejected` line in the packet (it is
  kept, and the checks skip it) and ESCALATE; NEVER re-submit the identical change (the loop must
  propose a smaller/different one, and that one goes through Step 4a again). When the loop later
  replaces or removes an installed patch, it retires the patch as Step 6 describes.
</step>

<step name="document">
## Step 6: DOCUMENT -- reversible records at the crate root

After any applied change, write the reversible records at the CRATE ROOT (not the workspace).

### Patch mode (translation-patches)

Patch mode never writes `src-modifications.diff`, `.json` or `.md`: those names are the legacy
ledger, and an active ledger beside a patch list is a mixed state the engine refuses. The records
are:

- `translation-patches/<name>.patch` -- one patch per function by default; a classified
  supporting patch is allowed when a change cannot stand alone (for example an existing `use`
  line that the rewrite's new path needs, changed in place). The engine requires the first four
  header lines below; the rest is the record that replaces the ledger's `.md` narrative and
  `.json` index:

  ```
  Translation patch: <item>           (or "Supporting patch: <item>")

  Change: <what is rewritten>
  Why: <the blocker it clears; the issue or release-note link from Step 3a when a known workaround applies>
  Behaviour: <what the rewrite preserves or changes>
  Classification: A-mechanical | A-opacity | B
  Assumptions: <trust assumptions it introduces; omit when none>
  Obligations: <correspondence obligations that stay open; omit when none>
  Evidence: <B only: equivalence-gate/<change-id>.md, a pointer for readers>
  Independent: yes                    (only when it applies on its own to the source snapshot)

  diff --git a/<path> b/<path>
  ...
  ```

  The same `Classification:`, `Assumptions:`, `Obligations:` and `Evidence:` lines are what
  `migrate` writes. A `Ratification:` line appears only on a patch `migrate` produced, carrying the
  legacy token verbatim as historical metadata; a patch written by this workflow keeps its
  ratification in its packet. The oracle finds a ratifying packet by `patch-file:` and
  `patch-sha256:`, never through `Evidence:` or `Ratification:`.
- `translation-patches/series` -- one patch file name per line, in application order; every
  `.patch` file listed exactly once (the engine refuses any other list).
- `src-assumptions.md` -- each entry names the patch that introduced it on a line
  `patch-file: <exact file name>` (the rest of the line is the name, so any name `series` accepts
  compares whole, and prose that merely mentions a file is not a reference); it stays at the crate
  root in both modes.

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

**Line-preserving patches.** A patch changes a function without moving any other line of the file:
the change goes on an existing line, or each hunk keeps its line count (it removes as many lines
as it adds). Line numbers the extraction reports, panic locations among them, then keep pointing
at the same lines. An import goes on an existing `use` line, or the item is written as a full path
at its use site; an attribute goes on the existing line it belongs to. This rule is always in
force, whatever the classification. Check it with a separate zero-context diff (the default-context
diff above is the patch body):

```bash
git -C "$SCRATCH" diff --cached -U0 | awk '/^@@/ { split($2, o, ","); split($3, n, ","); if ((o[2] == "" ? 1 : o[2]) != (n[2] == "" ? 1 : n[2])) bad = 1 } END { exit bad }'
```

A nonzero exit means a hunk changes its line count: rewrite the patch. The check is necessary, not
sufficient. It shows each hunk keeps its line count; it does not show that a panic still occurs on
the same line, and nothing in the patch engine enforces the rule. The reviewer in Step 4a checks the
panic occurrence and the file and line it reports. A patch that cannot be made line-preserving is
not installed: it is a gap that goes to the owner (Step 8).

Write the header followed by that diff body with the Write tool. A patch from Step 4a is staged
in `patch-review/` first and installed only after the reviewer's "no objection" (Category A) or the
ratification (Category B); installing means writing it as
`translation-patches/<name>.patch` and appending `<name>.patch` to `series`. Then run
`node "$PATCH_ENGINE" check --project-root "$CRATE_ROOT"`. A refusal (it does not apply, it does
not undo cleanly, the header is incomplete, a path is outside the extraction inputs) means remove
the patch and its `series` line and report the message; an unchecked patch is never left in the
list. Only a patch that passes `check` starts the next cycle, with a new `prepare`.

**Retiring an installed patch.** When the loop replaces or removes a patch that is already
installed, reconcile every record and keep the history:

1. Remove its name from `series`, and move the patch file to `translation-patches/retired/` (a
   subdirectory the engine does not read). The engine refuses a `.patch` file that is not listed,
   so removing only the `series` entry leaves the list unusable.
2. Mark its gate packet `status: superseded` (a replacement follows) or `status: retired`, with
   the reason. The packet stays in `equivalence-gate/`.
3. In `src-assumptions.md`, change the entry's `patch-file:` line to `retired-patch: <exact file
   name>` (and add a `patch-file:` line for the replacement when it carries the assumption). The
   entry's text stays as history, and a `retired-patch:` line is not a reference.

An active packet or a `patch-file:` line that still names the retired patch fails the record
check. Then run `check` and start the next cycle with a new `prepare`.

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
## Step 7: LOOP BOUNDS -- caps and the no-progress rule

All bounds are config-tunable; the documented defaults and rationale:

| Bound | Default | Rationale |
|-------|---------|-----------|
| Per-blocker attempt-cap | `3` | A small fixed cap: a blocker that survives three distinct fixes needs escalation, not more retries. |
| Per-run cycle hard-cap | `~25` | Bounds a whole run; on exhaustion ESCALATE with the full transcript. |
| Bisection variant-budget | `~12` | Comfortably covers the worked NO-BOTTOMS example (6 rows) with headroom; on exhaustion emit best partial isolation + ESCALATE. |
| No-progress key | `sha256(layer || signature)` | `symbol` is kept for the escalation report (the fix site), NOT the match key. |
| Patch review rounds | `2` | Step 4a: a writer and a reviewer on different models settle a patch in two rounds; a second objection goes to the owner, never a third round. Review rounds are not patch attempts, so they do not count against the attempt-cap. |

**No-progress rule:** if the same `sha256(layer || signature)` key recurs AFTER a fix was
applied for it, the fix did not work -> IMMEDIATE escalate. Do NOT consume the remaining
attempt budget on a known-stuck fix.
</step>

<step name="escalate">
## Step 8: ESCALATE -- a human decision point, never an automatic disposition

Escalation is always a HUMAN decision point and a VALID outcome -- not a failure. On any
escalate condition:

1. Persist the escalated blocker to `<extract_workspace>/<target>/escalations/<id>.md` with the
   full context: the stripped `signature`, the `symbol` (fix site), the attempt history, and the
   MFE. Two exits from Step 4a are recorded here too:
   - **A patch the reviewer still objects to after the second round.** The record holds both
     rounds, the staged patch and the Step 3a outcome. The owner decides: another writer and
     reviewer pair, a different patch, or a boundary.
   - **A gap no patch can fix.** The record is a boundary: the function (`symbol`), the reason no
     line-preserving patch clears it, the roots that reach it, and the tool issue it waits for (the
     Step 3a link, or `none found`). Add a matching entry to `src-assumptions.md`. The consequence
     for coverage is the owner's explicit decision (accept the function as an assumption, or block
     the run); a boundary is never skipped without that decision on record. Under the auto track,
     `auto-extract.md` lifts the record into the externals record.
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
4. Every Category-B patch, migrated ones included, carries a human ratification bound to its
   current bytes. Run the ratification check below with `GATE_DIR` set to
   `<extract_workspace>/<target>/equivalence-gate`. For each patch whose header says
   `Classification: B` it needs an active packet in `GATE_DIR` that carries
   `equivalence-ratified:`, names the patch on a `patch-file:` line, and records on a
   `patch-sha256:` line the sha256 the manifest records for that patch. A B patch with no such
   packet fails, and so does a patch edited after ratification, because its sha256 no longer
   matches. Refuse "complete" while the check fails.
5. The diff-to-record check holds over patch identities (file name and sha256). Run the record
   check below with the same variables. It passes only when the patches
   `translation-patches/series` lists now are exactly the manifest's patches, in its order, with
   unchanged sha256; each carries a `Classification:` line; and no active gate packet and no
   `src-assumptions.md` entry names a patch absent from the manifest on a `patch-file:` line (no
   orphan record). The
   manifest is the one `prepare` wrote for this cycle, and
   `node "$PATCH_ENGINE" status --out "$OUT"` refuses a partial one. A patch added after `prepare`
   needs a new cycle.

Both checks read **active** packets only: a packet with no `status: rejected`,
`status: superseded` or `status: retired` line (Step 5). A rejected proposal, a packet for a patch
the loop later replaced or removed, and a legacy packet the owner retired stay in
`equivalence-gate/` as the audit trail, so a rejected proposal never blocks completion after an
accepted alternative, and a retained packet never ratifies anything.

```bash
# ratification-check
node - "$CRATE_ROOT" "$OUT" "$GATE_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const [crateRoot, out, gateDir] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
if (manifest.status !== 'prepared') {
  console.error('the manifest does not record a prepared copy');
  process.exit(1);
}
const retained = /^status:[ \t]*(rejected|superseded|retired)\b/;
const packets = (fs.existsSync(gateDir) ? fs.readdirSync(gateDir).filter((name) => name.endsWith('.md')).sort() : [])
  .map((name) => ({ name, lines: fs.readFileSync(path.join(gateDir, name), 'utf8').split('\n').map((line) => line.trim()) }))
  .filter(({ lines }) => !lines.some((line) => retained.test(line)));
const unratified = manifest.patches.filter((patch) => {
  const header = fs.readFileSync(path.join(crateRoot, 'translation-patches', patch.file), 'utf8').split(/^diff --git /m)[0];
  if (!/^Classification:[ \t]*B[ \t]*$/m.test(header)) return false;
  return !packets.some(({ lines }) => lines.some((line) => line.startsWith('equivalence-ratified:'))
    && lines.includes(`patch-file: ${patch.file}`)
    && lines.includes(`patch-sha256: ${patch.sha256}`));
});
for (const patch of unratified) console.error(`no ratification bound to ${patch.file} (sha256 ${patch.sha256})`);
process.exit(unratified.length === 0 ? 0 : 1);
NODE
```

```bash
# record-check
node - "$CRATE_ROOT" "$OUT" "$GATE_DIR" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const [crateRoot, out, gateDir] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
if (manifest.status !== 'prepared') {
  console.error('the manifest does not record a prepared copy');
  process.exit(1);
}
const directory = path.join(crateRoot, 'translation-patches');
const seriesFile = path.join(directory, 'series');
const series = fs.existsSync(seriesFile)
  ? fs.readFileSync(seriesFile, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  : [];
const known = manifest.patches.map((patch) => patch.file);
const problems = [];
if (series.join('\n') !== known.join('\n')) problems.push(`series lists [${series}] but the manifest records [${known}]`);
for (const patch of manifest.patches) {
  const bytes = fs.readFileSync(path.join(directory, patch.file));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== patch.sha256) problems.push(`${patch.file} changed after prepare`);
  if (!/^Classification:[ \t]*(A-mechanical|A-opacity|B)[ \t]*$/m.test(bytes.toString('utf8').split(/^diff --git /m)[0])) problems.push(`${patch.file} has no Classification: line`);
}
const retained = /^status:[ \t]*(rejected|superseded|retired)\b/;
const packets = (fs.existsSync(gateDir) ? fs.readdirSync(gateDir).filter((name) => name.endsWith('.md')).sort() : [])
  .map((name) => ({ name, lines: fs.readFileSync(path.join(gateDir, name), 'utf8').split('\n').map((line) => line.trim()) }))
  .filter(({ lines }) => !lines.some((line) => retained.test(line)));
// A reference is a whole line `patch-file: <exact file name>` (optionally after a "- " bullet):
// the rest of the line is the name, so any name `series` accepts compares whole, and prose that
// merely mentions a file is not a reference.
const reference = /^(?:[-*][ \t]+)?patch-file:[ \t]*(\S.*)$/;
for (const { name, lines } of packets) {
  for (const line of lines) {
    const named = line.match(reference);
    if (named && !known.includes(named[1])) problems.push(`active gate packet ${name} names ${named[1]}, which is not in the manifest`);
  }
}
const assumptions = path.join(crateRoot, 'src-assumptions.md');
if (fs.existsSync(assumptions)) {
  for (const line of fs.readFileSync(assumptions, 'utf8').split('\n').map((entry) => entry.trim())) {
    const named = line.match(reference);
    if (named && !known.includes(named[1])) problems.push(`src-assumptions.md names ${named[1]}, which is not in the manifest`);
  }
}
for (const problem of problems) console.error(problem);
process.exit(problems.length === 0 ? 0 : 1);
NODE
```

The `Evidence:` and `Ratification:` lines of a migrated patch are the legacy run's approval, kept
as historical metadata. The check never reads them, and a legacy packet, which records no
`patch-file:` or `patch-sha256:`, never counts. A migrated B patch therefore needs a new gate
(Step 5) before the run can complete: when the check names it, fire the gate with the installed
patch as section 1, and the human stamps a packet that records its `patch-file:` and
`patch-sha256:`. Editing the patch afterwards makes that packet stale and needs another gate.

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
reinterprets legacy evidence as patch evidence. The classification, assumptions and obligations
`migrate` copied into patch headers are the patch's record; the copied approval (`Evidence:` and
`Ratification:`) is historical metadata and never counts toward completion. Editing a retired
ledger file makes it active again, and `check` then reports `mixed-mode`.

### Both modes

If any clause fails, the run is NOT complete -- return to the loop or HALT for the human.
</step>

<step name="run_end_summary">
## Step 10: RUN-END SUMMARY

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
</step>

</process>

<success_criteria>
- [ ] PRE-FLIGHT detects crate/folder/file, resolves clones via config -> auto-detect -> prompt -> error, runs the pin audit, and warn-and-confirms on drift recording `pin_context`.
- [ ] MODE comes from the engine's `check` verdict (its `code` field, never the exit status): `ok` -> patch mode, `legacy-mode` -> legacy mode, `mixed-mode` or any refusal -> STOP; the workflow never migrates.
- [ ] EXTRACT reads the tool's real exit status (`set -o pipefail` / `${PIPESTATUS[0]}`), never the pipe; always `LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build`.
- [ ] Patch-mode EXTRACT runs `prepare`, `verify-tree`, Charon inside `"$OUT/tree"` with its output outside the tree, `verify-tree`, Aeneas, then `verify-restore`; an engine refusal stops the run and is never classified or repaired in the copy.
- [ ] CLASSIFY reduces the log to `{layer, symbol, signature, match}`; NOVEL on a miss.
- [ ] KNOWN ISSUES (Step 3a) runs before any new or changed patch to the Rust extraction inputs, whichever layer reported the blocker: read-only search of the tools' trackers with the stripped signature only, one recorded outcome per signature (`fix, no source change`, `workaround that edits source`, `fix only in a newer version`, `none found`, `not checked`), a cached record per pin pair, and no pin change without the owner. An unreachable tracker is `not checked`, never `none found`.
- [ ] DISPATCH routes A -> applier, NOVEL -> bisector, forced-B -> gate, escalate-conditions -> escalate; the coverage-escalation guard turns A-opacity on a coverage target into B.
- [ ] WRITE AND REVIEW (Step 4a): the writer and reviewer seats resolve to different models; the reviewer is a fresh `fvs-equivalence-assessor` dispatch (or a fresh run of its brief through the seat's external runner) that returns a `Reviewer verdict:` line; a second objection escalates and there is no third round; "no objection" stamps nothing.
- [ ] GATE is fired by the orchestrator; the assessor (`fvs-equivalence-assessor`) is a distinct dispatch from the proposer (`fvs-extract-bisector`) and never writes the token; the owner, or a delegate the owner named and recorded on the stamp, stamps `equivalence-ratified:` last.
- [ ] DOCUMENT (patch mode) writes `translation-patches/<name>.patch` + `series` + `src-assumptions.md` at the crate root and never `src-modifications.*`; (legacy mode) writes `src-modifications.diff` + derived `.json` + `src-modifications.md` + `src-assumptions.md`; generated Lean never written; annotations preferred.
- [ ] LOOP BOUNDS: attempt-cap 3, cycle hard-cap ~25, variant-budget ~12, patch review rounds 2, no-progress key `sha256(layer || signature)`; same-key recurrence after a fix -> immediate escalate.
- [ ] ESCALATE persists to the workspace, surfaces to the user, offers a draft (drafting only on acceptance), and "skip" is an explicit human choice. A gap no patch can fix is recorded as a boundary with its reason, roots and the tool issue it waits for; the coverage consequence is the owner's explicit decision.
- [ ] Patches are line-preserving (the zero-context diff check plus the reviewer's panic check), and a pin change only proposes which patches the new tools no longer need; retirement goes through the retire step and the gate.
- [ ] SUCCESS ORACLE (patch mode): clean build AND `verify-tree` AND `verify-restore` AND every B patch, migrated ones included, has a ratification bound to its `patch-sha256:` (the ratification check) AND the diff-to-record check over patch identities holds; (legacy mode) clean build AND every B-change has a present token AND diff <-> record 1:1; refuses completion otherwise.
- [ ] Retired legacy records are inactive and never read as patch evidence; the run-end summary reports extraction, restored source, evidence and remaining obligations separately.
- [ ] No `gh` open/create call appears in the draft or escalation steps.
</success_criteria>
