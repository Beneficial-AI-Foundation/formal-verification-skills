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
AUTO=~/.claude/scripts/fvs-auto.mjs
PATCH_ENGINE=~/.claude/scripts/fvs-extract-patches.mjs
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

## Step 3: Hand off to the shared extractor

Run `/fvs:aeneas-extract "$CRATE_ROOT"` with the recorded configuration (features, target and
extraction options) and scope. It keeps all of its own pre-flight, gates, human ratification and
success oracle; nothing here relaxes them. Take two facts from its run-end summary's `Copy:` line:
`OUT`, the copy of the last cycle, and `BUILD_STATUS`, that cycle's real exit status (`255` when the
run stopped before the build).

## Step 4: Record the extraction

Record every attempt, success or failure:

```bash
node "$AUTO" record-extraction --project-root . --out "$OUT" --build-exit-code "$BUILD_STATUS"
```

- `recorded`: the script found a zero build exit, a prepared copy whose tree and restored source
  pass the engine's checks, the recorded revision and no uncommitted input changes.
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

Each record holds `id` (stable across reruns), `kind`, `source` (`symbol`, and `commit`: the
recorded revision's commit), `model` (`symbol`, and `sha256` of the Lean file holding it),
`claimedBehaviour` (the exact behaviour assumed), `reason`, `affectedRoots` (`[]` until roots exist
in milestone 2), `evidence` (paths to the gate packet, the patch file or the model), `status` and
`decision`. A new boundary is `open` with `decision: null`.

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

## Step 6: Write the regeneration instructions

After a recorded success, write `.formalising/auto-fv/regenerate.md` from `read-state`: the crate
root, the recorded revision and its commit (`state.extraction.inputs.sourceCommit`), the
configuration, the ordered patches with their sha256 (`state.extraction.inputs.patches`), the
manifest sha256, and the steps: check out that commit with a clean extraction input set, rerun
`/fvs:auto-extract`, and compare the new record's patch list and source commit with these.

## Step 7: Report

```
FVS >> AUTO-EXTRACT

Extraction:            {succeeded | failed: <reasons>} for revision {revision} ({K} patches)
Restored source:       {verify-restore ok | refused}
Evidence:              tree check {ok | refused}; B patches ratified as aeneas-extract reported
Obligations remaining: {open externals by kind, and the patches' open Obligations: lines}
Note:                  Extraction success is not a proof; no specification has been stated or proved.

State:            extraction {status}; externals {total} ({open} open, {assumption-accepted} accepted assumptions, {blocked} blocked)
Next action:      {nextAction from read-state}
Pending decision: {pendingDecisions, plus any boundary awaiting an owner decision, or none}
```

</process>
