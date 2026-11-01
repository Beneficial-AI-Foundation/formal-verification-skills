# Coordinator checkpoints and resume

<purpose>
Use this reference from auto-init/auto-execute when continuing an agreed nonpublic project. The
coordinator reconciles before any later transition; workers use the separate read-only memory route
in `auto-memory.md`. This adapter records observations and effects. Ticket22 owns dispatch and stage
ordering. A `reconciled` result is neither execution permission nor a proof receipt.

</purpose>

## Prepare the current request

Read the actual owner response and current canonical scope, claims, trust, conventions and reserved
decisions. Apply12's workflow applicability check as well as `read-state --require-agreement`.
Preserve current grants; null execution/publication remains ungranted. Public-API mode stays held11.

The caller prepares and retains this closed JSON, using actual selected context. Schema examples are
not answers, grants, identities or evidence. Missing context is an explicit partial condition.

| Field | Current caller value |
|---|---|
| `schema`, `schemaVersion` | `fvs/auto-resume-request`, `1` |
| `attemptId` | New UUID for each observation |
| `runId` | Existing runtime run UUID; a new UUID only for a genuinely new run |
| `phase`, `resumeId` | `start` and null, or `resume` and a fresh UUID |
| `ao` | `{tool:{file,sha256},stateHome,projectId,coordinatorSessionId}`; existing canonical AO executable, existing canonical HOME containing `.ao`, and stable selected ids |
| `expectedHeadSha256` | `readRuntimeState({projectRoot:primary}).headSha256`; null only before runtime creation |
| `source` | `{kind:"git",root,commit,expectedTree}` for the actual integration worktree, full exact ids |
| `inputs` | `{extraction,graph,plan,baseline,acceptedStore}`; unavailable stages null, other files `{file,sha256}`; extraction is the identity-record reference; store is `{root,expectedHeadSha256}` |
| `associations` | Controller association file references described below |
| `priorAccounting` | Null for established runtime or verified no-prior-execution start; otherwise an existing bound accounting record |
| `memoryRequest` | Independently prepared20 request for this same attempt/phase/project/coordinator/resume, operation `coordinator-refresh` |
| `transition` | Null for reconciliation; paired intent/effect for a checkpoint |

AO requires its existing HOME controller-state locator. `stateHome` is explicit invocation context,
not a worktree-derived path, identity attestation or setup permission. It stays bound to the run.
The local AO metadata command environment carries only that required HOME plus the recorded allowlist;
provider credentials/URL overrides are not forwarded. Missing profiles stop before any query or init.

Use `prepareMemoryRequest` from the same installed `fvs-auto.mjs` before invocation. Its expected
binding/context comes from current canonical data. Keep that caller object/file independently of
the result. Retain exact request, script/tool, argv, output and prime bytes in exclusive directories
outside the project. Source/extraction Rust commit, pristine Lean commit, candidate and integration
commit are distinct identities; preserve each. An initial pristine tree has no accepted proof baseline.

```bash
node "$AUTO" state --project-root "$PRIMARY" --request "$CURRENT_REQUEST" --out "$EXCLUSIVE_OUT"
```

The coordinator route refreshes/consumes its configured20 primary memory and reads actual local AO/Git
and checker evidence. It initializes no store and launches no session. On `partial`, preserve the
reasons and unfinished scope. Missing prior accounting creates no new start time or runtime. Pending
runtime markers remain evidence requiring reconciliation, not permission to delete/reset them.

Consume the result against the caller's independently held request:

```javascript
const observation = verifyReconciliation({ projectRoot: primary, request, out });
// Read observation; separately check current workflow applicability and delegated actions.
```

The result binds the requested predecessor and the newly committed head separately. Consumption
checks the committed head, current physical Git/AO identities, actual fresh memory bytes, current
checker/contract/import/source identities and original limits again. A later checkpoint stales the
earlier result. Worker reports, AO completion and Beads context establish no acceptance.

## Controller session association

AO ls returns `role`/string activity; get returns `kind`/object activity. Neither supplies a worktree
path. Use an explicit retained controller association, separately from fresh AO lifecycle and Git
observations. Matching display names, directory conventions and branch hints establish no association.

Its closed record is `fvs/auto-session-association` version1, with `runId`, `assignmentId`,
`reservationId`, `projectId`, actual `sessionId`, `scopeRelation` (`run-assignment|unrelated-work`),
`nodes`, `owner`, `controllerSessionId`, `worktree`, `provenance` and `rulesProfile`.
`worktree` contains canonical `path`, actual `gitDir`, `gitCommonDir`, full `branchRef`, `commit`, `tree`.
`provenance` contains `kind` (`controller-launch|controller-existing-assignment`), `beforeEventSha256`
(null for existing assignment) and nonempty bound JSON `evidence` references. A launch includes the
controller's retained launch request/result and explicit observed path statement; an existing
assignment cites its controller assignment/checkpoint evidence. A launch association must match the
exact intent's node/owner/reservation/assignment/branch. Unrelated-work records have empty node ids.

These are declared controller workflow records, not AO/OS attestation. `rulesProfile` is null for
unknown, or `{provenance:"retained-controller-observation",evidence:[...]}`. AO ls/get does not freshly
attest effective model settings. Missing association, changed/redirected Git identity or unclassified
same-project sessions prevent launch eligibility. Preserve the discrepancy instead of guessing paths.

## Paired effect checkpoints

```bash
node "$AUTO" checkpoint --project-root "$PRIMARY" --request "$CURRENT_REQUEST" --out "$EXCLUSIVE_OUT"
```

Set `transition` to `{position,intent,beforeEventSha256,outcome,effect}`. The stable `intent` is
`{transitionId,reservationId,stage,nodes,owner,effect}`. Nodes are sorted unique ids. Stages are
extraction/specification/review/proof/check/integration/acceptance/reconcile. Intent effects are:

- `{kind:"ao-launch",projectId,intendedBranchRef,assignmentId,sessionId:null}`.
- `{kind:"local",operation}` where operation equals stage.
- `{kind:"reservation-resolution",targetReservationId}` at reconcile stage.

Before uses null beforeEventSha256/outcome/actual effect. After references its exact before event and
retains the identical intent, outcome `succeeded|failed|uncertain`, and actual effect
`{sessionId,association,evidence,resolution}`. A successful launch supplies its actual sessionId and
bound association; other unused fields are null and evidence is an array. Local actions cannot claim
launch effects. An orphan or changed/conflicting after refuses.

Only a before newly committed by this invocation can precede that invocation's later22 effect.
Replay returns `already-recorded`/`uncertain`, no committed head and no execution opportunity.
An unfinished/failed/unknown launch retains capacity, including when AO shows no row, idle or exited.
Pending/active/uncertain reservations and live unreserved associated workers count conservatively
under the same lock/CAS as publication. Node ownership remains reserved through uncertainty.

Explicit resolution names the target reservation. Its successful after uses
`resolution:{reason,evidence}`: `not-invoked` cites a closed controller JSON record with schema
`fvs/auto-effect-not-invoked`, schemaVersion1, exact run/reservation/controller ids and
`effectInvoked:false`; `session-terminated` cites actual current matched AO get JSON and fresh
`isTerminated:true`. Missing AO rows or a failed command alone release no capacity. These records
retain workflow provenance rather than authenticating a host. Uncertain local effects also remain
blocked until resolved.16 performs no launch or termination.

## Runtime and limits

`.formalising/auto-fv/resume/state.json` retains one run and its hash-linked history. Routine
checkpoints leave the proof-bound M1 `state.json` unchanged. Keep runtime/backend metadata outside
the tracked proof source snapshot through the project's established layout; the adapter does not
rewrite Git ignore rules to hide a dirty source. It rejects noncanonical/symlink runtime paths,
malformed/corrupt history, stale heads and pending lock/temp markers without repair.

Original scope, limits, run start/deadline and monotonic observations survive interruptions and restarts.
`nodeHours` is inactive metadata. Unknown prior execution/accounting remains partial; it cannot be
assigned zero. The supported accounting record is `fvs/auto-runtime-accounting` version1 with exact
runId, startedAtMs, lastObservedAtMs and original limits. Preserve additional spending restrictions
through workflow checks; unavailable accounting cannot authorize further spending. Exhaustion stops
continuation with a resumable partial result, never a larger/reset cap or reduced scope. Local metadata
command caps bound observation I/O, not per-node proof duration.
