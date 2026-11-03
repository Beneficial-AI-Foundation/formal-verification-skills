# V2 execution, cancellation and progress

<overview>
Use this reference for a v2 project, checker request, work packet, progress observation or replacement.
Read the actual recorded version first. New projects use v2; existing v1 projects keep their recorded
choices, runtime, finite deadlines and receipt semantics. Reads do not migrate or rewrite them.
</overview>

## Start and resume

New choices contain `limits:{workers:3}`, `budget:{kind:"none"}` and an explicit
`memory:{mode:"disabled"}` or `memory:{mode:"beads"}` alongside the agreed source and scope.
Three is the existing worker default, not a proof deadline. An explicitly selected wall budget uses
`budget:{kind:"wall-clock",hours:<selected number>}`. Record only the owner's actual choice.
The initial roadmap agreement is the setup human gate; later provisional work runs autonomously
within its grants, and final review remains human.

The agreement, state, runtime, resume request/result, action, packet/start marker and checker wrapper
use version 2 where their shapes change. Contract-registry records, accepted events and enabled
memory-bootstrap requests retain their existing version. Reject unknown or mixed wrappers.

The runtime resolves the chosen budget once to `{kind:"none"}` or
`{kind:"deadline",deadlineMs:<original absolute deadline>}`. Use `runControl(runtime.state.run)` from
installed `scripts/fvs-execution.mjs` to obtain the closed `execution` object, including its run and
policy identity. V2 checker/build/kernel requests replace `deadlineMs` with that object; they do not
carry both. A proof invocation is `{schema:"fvs/auto-proof-invocation",schemaVersion:2,runId,
invocationId,execution}`. Resume and replacement retain the original policy and task history.

With no selected budget, continue until completion, user/orchestrator cancellation or a genuine
blocker. Elapsed age does not establish stale proof. Current source, tools, statements, semantic
closure, dependencies, axioms, registry/store heads and CAS still must match. Administrative AO client RPCs, Git metadata reads and
memory I/O have separately named finite limits; long build/proof work is not administrative.

For disabled memory, the v2 coordinator request has `memoryRequest:null`, the runtime records the
explicit disabled disposition, and workers use `fvs/auto-memory-disabled-request` version2. There is
no backend prime or substitute20 receipt. With Beads enabled, follow `auto-memory.md`: the caller's
fresh request, canonical primary store/Git identity and actual prime/result checks remain mandatory.
Local FVS-development memory is separate from a target project's chosen backend.

## Work and cancellation

Use the normal startup acknowledgement, exact preparation, published delivery-after and exclusive
work-start guard from `auto-transitions.md`. A start marker's v2 activation time records worker-entry
acknowledgement, not a fabricated OS process start. Honor `mayStart` only from that fresh call.

Run concrete compiler/checker work through `node "$AUTO" run-owned --input "$REQUEST"`.
Its closed `fvs/owned-command-request` version1 has `packet`, `marker`, a fresh UUID `invocationId`,
`tool:{file,sha256}`, full `argv`, canonical assigned `cwd` and explicit allowlisted `env`.
Use binaries pinned in the issued frozen context, including concrete Lean/Lake paths rather than
installation proxies. The installed gate rechecks the active assignment, agreement, actual integration
source/common Git/branch, semantic generation, memory when enabled and final expected runtime head.
It records intent before spawn and actual start/terminal/output facts in this packet's owned scope.

The process adapter propagates cancellation to its retained live child/group and waits for terminal
facts. A caller retaining this process can send SIGINT/SIGTERM, or a newline JSON
`{kind:"cancel",invocationId:<this invocation>}` to its stdin. AO session status does not expose a job
stdin API or a universal descendant ledger. Use documented AO lifecycle controls and concrete FVS
handles that actually exist; qualify the installed integration before promising automatic replacement.
An exited parent with unsupported child pipes returns uncertain cleanup. Never signal a PID copied
from evidence. Incomplete/changed/interrupted checks produce no new accepted proof; an event already
atomically accepted before an observed stop remains part of history.

## Periodic progress

During active work, `next-transition` returns `observe-existing` scheduling facts without rechecking
the complete proof store. It is not dispatch permission. The existing AO coordinator loop reads actual
session status and records useful progress through `record-progress`; use `observe-progress` for a
fresh assigned AO/Git/source observation and `read-progress` for retained historical facts.

`record-progress --input` takes the exact `packet`, `marker`, `previous` reference or null, `currentGoal`,
`failedApproaches:[{hypothesis,evidence}]`, `lastMeaningfulProgress:{observedAtMs,description,evidence}`,
`blocker` or null, `nextStep` or null, `blockerResolution` or null, and a new exclusive `out` directory.
A blocker has `{kind,description,evidence}`; kinds are missing-lemma, specification, tooling or unknown.
A grounded blocker resolution has `{route,evidence,nextStep}`; routes are decomposition, helper-lemma
or independent-specification-review. Evidence is immutable `{file,sha256}` data; a heartbeat alone is
not meaningful progress. `observe-progress` takes `{packet,marker,progress,out}`. `read-progress` takes
`{progress}`. These operations establish scheduling facts, never proof or effect permission.

For a small proof unit from the roadmap, roughly1h unresolved prompts diagnosis: inspect the exact
goal, last meaningful progress and failed approaches. Useful progress may justify continuation.
A concrete missing lemma, bad specification or other blocker may justify earlier intervention.
This threshold is neither an automatic kill nor a build/total-proof deadline. Keep the original task
start distinct from the current attempt start; a replacement cannot erase either history or budget.

## Stop, reconcile and hand off

1. Checkpoint the exact goal and source/contract/dependency identities, failed approaches, useful
   patches/untracked files and valid evidence. Preserve the worker worktree and uncommitted changes.
2. Prepare the existing paired v2 `terminate` action with its exact `sessionId`, `association`,
   `operation:"terminate-session"` and retained `progress` reference. The producer seals that packet
   against new commands, then uses stock `ao session kill`. Cleanup may run after a selected proof
   budget expires; it cannot start more proof work. Actual AO termination and fresh known-work
   quiescence are required for a successful stop record. Missing/unsupported scope stays unresolved.
3. Resolve the old reservation through `operation:"resolve-terminated-reservation"` with the same
   handoff. Its session-terminated evidence is the closed
   `{schema:"fvs/auto-owned-session-termination",schemaVersion:1,session,progress,terminationCompletion}`.
   Bind the actual successful stop completion and session response. Independently consume the after.
   A never-released startup may use `progress:null` only with no retained release attempt; uncertain
   delivery cannot be treated as no work.
4. Only after the old reservation closes and the known command scope is freshly quiescent, prepare
   a new launch with `resumeOf` referencing that progress artifact. Use a fresh actor, assignment,
   startup challenge, memory context and packet. Keep the original task/context/budget/history.
   Preserve local changes as handoff evidence; integrate only through the ordinary reviewed pipeline.

A persistent same blocker requires grounded decomposition/helper/specification review before another
same-context replacement. The workflow compares the actual blocker and evidence; there is no language
classifier or blind restart loop. The strict15 inspector and dependency-ready proof-launch guards
remain unchanged. Stop-only snapshots leave proof heads/nodes unknown and cannot authorize work.
If actual supported AO observations cannot establish the known scope, report the precise missing
capability and use cooperative checkpoint/cancel/handoff assistance; retain uncertainty and capacity.

## Network and runner support

Use stock AO on the user's local or cloud host. Research, lemma/docs search and dependency acquisition
are network-enabled through configured tools/providers, permissions and selected budgets. Retain pins,
origins and privacy; freeze the exact inputs used by checking. A stable-snapshot check's anti-fetch and
mutation checks do not forbid networking for the full project run. Offline Dalek/qualification cases
are versioned test conditions.

V2 records the actual host/architecture and pinned tools; the compiler runs with ordinary trusted-host
permissions, without nested macOS Seatbelt policy. This is not host/tenant/credential isolation
attestation. A dedicated host/container may supply that boundary. No cloud deployment is implicit.
The earlier macOS arm64/Lean4.31 lane is historical evidence for its exact engine. The new v2 engine,
actual AO stop/replacement and full flow still require fresh qualification. Linux probe/tool inventory
is not full factory qualification; incidental probe/distribution constraints remain per tool. Windows
and other tuples gain no supported-runner claim. Report actual installed/missing tools rather than
selecting Linux-first or silently downloading/upgrading a toolchain.
