<purpose>
Extract the revision and configuration recorded by auto-init through the shared aeneas-extract in
translation-patch mode, then record the result, the externals record and the regeneration
instructions. `scripts/fvs-auto.mjs record-extraction` derives the extraction status itself: a
caller cannot state success, so a failed extraction is never recorded as success.
`record-externals` validates every boundary record and refuses to drop one. Extraction success is
not a proof.
</purpose>

<process>

## Step 1: Require Agent Orchestrator and recorded setup state

```bash
AUTO="${CLAUDE_PLUGIN_ROOT}/scripts/fvs-auto.mjs"
PATCH_ENGINE="${CLAUDE_PLUGIN_ROOT}/scripts/fvs-extract-patches.mjs"
command -v ao >/dev/null 2>&1 || {
  echo "FVS >> ERROR: the auto track requires the Agent Orchestrator ao CLI on PATH." >&2
  echo "Install Agent Orchestrator and put its ao CLI on PATH (see auto-setup.md), then rerun /fvs:auto-extract." >&2
  exit 1
}
node "$AUTO" read-state --project-root .
```

Read the `code` field: `no-state` -> stop and point to `/fvs:auto-init`; `malformed-state` or
`malformed-externals` -> print `message` and `nextStep` verbatim and stop. On `ok`, take the
recorded `state.choices.source` (revision and configuration) and `state.choices.scope`.

## Step 2: Check the checkout and the mode

Resolve the crate root (`CRATE_ROOT`) from the argument, or ask for it. Quote every path and refuse
one with shell metacharacters. Then:

```bash
REVISION="<state.choices.source.revision>"
[ "$(git -C "$CRATE_ROOT" rev-parse HEAD)" = "$(git -C "$CRATE_ROOT" rev-parse --verify --quiet "$REVISION^{commit}")" ] \
  || echo "FVS >> the checkout is not at the recorded revision $REVISION"
node "$PATCH_ENGINE" check --project-root "$CRATE_ROOT" --format json
```

- Not at the recorded revision: stop and ask the owner to check it out (or to change the revision
  through `/fvs:auto-init`). Never check out, reset or stash anything yourself.
- `check` code `ok`: translation-patch mode; continue.
- `legacy-mode`: stop. The auto track extracts through translation patches only; the owner
  migrates explicitly as `extraction-patch-migration.md` describes. Never migrate here.
- `mixed-mode` or any other code: print the result's `message` verbatim and stop.

### The crates of the repository, and the lock

List the crates of the repository before extracting (read-only, nothing is written):

```bash
RELEASE_DIR="<the release directory of the recorded Aeneas/Charon setup>"
node "$PATCH_ENGINE" crates --project-root "$CRATE_ROOT" --release "$RELEASE_DIR"
```

With more than one crate that has a library, the extraction covers several crates. Every one is a
target unless the agreement (`targets`, recorded by `/fvs:auto-init`) lists it as a non-target, which
only the owner decides; the answer's `order` gives the crates with providers first. The same result
names the `inputs` a copy needs and any symbolic link under them (a copy refuses links, so a
workspace with links needs a translation patch that trims its member list). When the project has no
`Cargo.lock`, or its lock does not match the patched manifests, the owner agrees to
`--lock update --release "$RELEASE_DIR"` for the copy: the lock is made inside the copy, never in the
checkout, and its hash and origin are recorded. Keep a copy of `"$OUT/tree/Cargo.lock"` with the
extraction record.

## Step 3: Hand off to the shared extractor

Run `/fvs:aeneas-extract "$CRATE_ROOT"` with the recorded configuration (features, target and
extraction options) and scope. It keeps all of its own pre-flight, gates, human ratification and
success oracle; nothing here relaxes them. Take three facts from its run-end summary: from the `Copy:`
line, `OUT`, the copy of the last cycle, and `BUILD_STATUS`, that cycle's real exit status (`255` when
the run stopped before the build); from the `Oracle:` line, `ORACLE`, the final success-oracle verdict
(`complete`, `refused` or `unknown`), and its reason. A green build is not a complete extraction: an
oracle refusal after a clean build (an unratified Category-B patch, a failed diff-to-record check) is
`refused`. When the summary has no `Oracle:` line, or the run stopped before the oracle ran, pass
`unknown`; never pass `complete` unless the summary says so.

### Extracting several crates

For several crates, give the extractor one spec with a `crates` list (`aeneas-extract.md`, "Several
crates"): one entry for each target crate with its own `publishDir` and `moduleRoot`, `nonTargets` for the
crates the agreement excludes, and, for each target that calls another target, a `stitch` entry naming
that target. Stitching makes the caller's Lean use the other crate's real translation; without it the
calls would be axioms in the caller's Lean, so publication of a crate that calls a target without a
stitch entry fails and the extraction is not recorded as succeeded. Use a
`substitutions` entry only to rename a name Lean cannot read (Aeneas writes a shadowed local as `len·`);
any other change to the translation is a patch of the Rust source, and a substitution never touches an
axiom, the name or type of a definition, or a Trusted file. The extractor runs the chain of each crate in
the `order` the attempt records, and the run-end summary still names one copy, `OUT`. A crate whose chain
fails fails the whole extraction; the others stay on disk as evidence.

## Step 4: Record the extraction

Record every attempt, success or failure:

```bash
node "$AUTO" record-extraction --project-root . --out "$OUT" --build-exit-code "$BUILD_STATUS" --oracle "$ORACLE"
```

Add `--oracle-reason "<reason>"` only when the summary gives a reason for a `refused` or `unknown`
verdict; leave the flag out otherwise. A blank reason is recorded as no reason.

- `recorded`: the script found a zero build exit, a `complete` oracle verdict, a prepared copy whose
  tree and restored source pass the engine's checks, the recorded revision and no uncommitted input
  changes. The two declared inputs (build exit and oracle verdict) can only block success, never
  create it.
- `extraction-failed`: the attempt is recorded as failed with its `reasons`. Report them as the
  state; never retry by editing the record.
- `no-state` or `malformed-state`: print `message` and `nextStep` and stop.

On a failure, skip Step 6 (the instructions describe a successful extraction) and still run Step 5
when boundaries are known, so no boundary is lost.

## Step 5: Write the externals record

Read the current record first (`.formalising/auto-fv/externals.json`, absent on a first run) and
resubmit every recorded boundary. Add one record for each new boundary:

| Kind | Where it comes from |
|---|---|
| `opaque` | functions the extraction leaves opaque (extraction options, A-opacity patches) |
| `external` | declarations Aeneas emits as external stubs (`*External*.lean` templates) |
| `handwritten-model` | models written by `/fvs:model-external` |
| `semantic-patch` | every translation patch classified Category B: a semantic change to an otherwise extracted function |

After a stitched extraction, these also need a record, each `open` until the owner decides:

- every item the stitching left as an axiom on purpose (`stitch[].assumed` in the run);
- every axiom that stitching made visible in a crate's statements and that is not Lean's standard: the
  provider crate's own opaque items (one Charon or Aeneas cannot translate, or the run declares
  `--opaque`), the standard-library and helper-crate axioms its translation still rests on, and the same
  external item when two crates each carry an axiom for it (both copies in one record);
- the items of a crate the owner chose not to verify.

An opaque item of a verified crate may be listed through its accepted externals record: that is a
disclosed assumption, not a black box. What is not allowed is a hand-written axiom that stands in for a
function the stitching translated, or a stale copy of one (for example the caller's own copy of a
provider function that stitching replaced): replace it with the provider's accepted theorem, or delete
it.

Each record holds `id` (stable across reruns), `kind`, `source` (`symbol`, and `commit`: the
recorded revision's commit), `model` (`symbol`, and `sha256` of the Lean file holding it),
`claimedBehaviour` (the exact behaviour assumed), `reason`, `affectedRoots` (`[]` until roots exist
in milestone 2), `evidence` (paths to the gate packet, the patch file or the model), `status` and
`decision`. A new boundary is `open` with `decision: null`.

A function the extraction loop could not patch is recorded as an `opaque` boundary, lifted from its
escalation record (`<extract_workspace>/<target>/escalations/<id>.md`), once the function is left
opaque and the extraction emits an external stub or axiom for it. `model` then names that Lean
declaration (`symbol`) and the `sha256` of the Lean file that holds it. A function with no such
declaration cannot be recorded here: it stays in its escalation record, and the run stays blocked
until the owner decides. The `reason` names the tool issue the function waits for, with the link, or
says `none found` (or `not checked` when the tracker could not be reached); the roots that reach it
stay in the escalation record, because `affectedRoots` is `[]` for now. `evidence` points to that
escalation record and to the known-issues record in the same workspace. The record stays `open`
until the owner decides: `assumption-accepted` (a limitation, never proof) or `blocked`.

Status changes only on a decision: `assumption-accepted` or `blocked` names who decided, when and
on what evidence (`decision: {by, at, evidence}`); accepting an assumption is labelled as a
limitation, never as proof. `correspondence-proved` is refused in this milestone: it needs checked
correspondence evidence, and checked correspondence receipt validation is not implemented yet. No
file path, hash, ratification packet or review link stands in for it, so keep such a boundary
`open`, `assumption-accepted` or `blocked`. A replacement model never closes an open obligation.

```bash
RECORDS="$(mktemp)"
# write the JSON array of every record to "$RECORDS", then:
node "$AUTO" record-externals --project-root . --input "$RECORDS"
```

- `recorded`: written.
- `record-loss`: the list dropped the boundaries in `lost`; add them back and rerun. A boundary is
  never deleted.
- `invalid-input`: fix the records named in `errors` and rerun.

## What the project does after stitching

Stitching changes which axioms the project's theorems rest on: the items it replaced leave the lists,
and the axioms the provider's own translation still rests on enter them. A project that pins those
lists (a checked message around `#print axioms`) must regenerate the pinned lists in its own Lean
project, as an ordinary change that is reviewed; this workflow never rewrites a pin in the project.
Each axiom that newly appears needs the externals record above. Hand-written Trusted axioms about a
function that is now translated are replaced by the provider's theorems or removed. Report these as the
next action; they are the project's work, not part of the extraction.

## Step 6: Write the regeneration instructions

First make sure the project root has an `aeneas-config.yml` recording `aeneas.commit` (the pinned Aeneas
commit), `crate.dir` (the crate root, relative to the project) and `aeneas_args.dest` (the directory Aeneas
wrote `translation.json` to). The resolver and probe-aeneas read those three keys; without them the profile
reports the extraction's provenance as unknown even though `translation.json` exists. Create or update
it only with the owner's agreement, and rerun the profile afterwards.

After a recorded success, write `.formalising/auto-fv/regenerate.md` from `read-state`: the crate
root, the recorded revision and its commit (`state.extraction.inputs.sourceCommit`), the
configuration, the ordered patches with their sha256 (`state.extraction.inputs.patches`), the
manifest sha256, and the steps: check out that commit with a clean extraction input set, rerun
`/fvs:auto-extract`, and compare the new record's patch list and source commit with these. For several
crates add the extraction spec (each crate's package, directory, `publishDir`, `moduleRoot`, `stitch`,
`substitutions`, and the non-targets), and the lock's origin and hash (`state.extraction.run.lock`):
a lock that was generated or updated is not in the checkout, so say where its copy is kept.

## Step 7: Report

```
FVS >> AUTO-EXTRACT

Extraction:            {succeeded | failed: <reasons>} for revision {revision} ({K} patches)
Restored source:       {verify-restore ok | refused}
Crates:                {one crate | each crate with its status; stitched to which providers; non-targets and who decided}
Lock:                  {read | generated | updated} {sha256 prefix}; copy kept at {path}
Evidence:              tree check {ok | refused}; B patches ratified as aeneas-extract reported
Obligations remaining: {open externals by kind, and the patches' open Obligations: lines}
Note:                  Extraction success is not a proof; no specification has been stated or proved.

State:            extraction {status}; externals {total} ({open} open, {assumption-accepted} accepted assumptions, {blocked} blocked)
Next action:      {nextAction from read-state}
Pending decision: {pendingDecisions, plus any boundary awaiting an owner decision, or none}
Project work:     {after stitching: regenerate the pinned axiom lists and add the externals records; or none}
```

</process>
