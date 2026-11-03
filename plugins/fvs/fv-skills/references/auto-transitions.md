# Bounded auto controller route

For v2 actions, worker packets, cancellation and handoffs, read `auto-execution.md` first. It defines the explicit execution policy, optional memory and current lifecycle. The version1 field tables and finite bounds below describe retained legacy records; apply them only to v1.

<purpose>
Bind the existing AO/FVS stage loop to current agreement, memory, source and checker evidence.
Keep uncertain effects partial and preserve whole-scope gaps for the17 handoff.
</purpose>

Use this route only for an AO orchestrator continuing the current applicable nonpublic
agreement with a concrete execution grant, complete persisted/explicit selections, primary
project memory, actual controller invocation and original run accounting. It is the opt-in
continuation of auto-init, not a new runtime or queue. Stock AO owns actors/worktrees. The
orchestrator interprets each proposal, runs the existing FVS procedure and recomputes.
Ordinary standalone commands retain their own interactive routes.

The initial roadmap agreement is the setup human gate. Reuse existing answers and grants.
Later author/review/revise/proof cycles are autonomous within them; final PR acceptance stays
human. Missing operational context, unsupported shape, profile or capability is a named partial
condition, not another scope interview. Public-API mode remains unsupported pending11; this
nonpublic route does not waive that hold. Worktrees and instruction acknowledgements are not
OS security or suspension boundaries.

## Controller loop

1. Follow the installed `fv-skills/references/auto-memory.md` and `auto-resume.md`. Read the actual current canonical agreement,
   including semantic applicability of the whole payload, scope/claims/trust and delegated actions.
   Store12's current result alone does not establish applicability. Bind each concrete action to
   the existing execution grant with `fvs/auto-action-authorization` version1: exact agreement
   context and approved-payload hashes, actual `execution`, and finite `{kind, action, reference}`
   correspondence rows. Null execution is ungranted. No natural-language classifier supplies it.
2. Retain one `fvs/auto-stage-profile` version1 manifest with `source`, `controller` and `stages`.
   `controller` is the current redacted AO configuration fingerprint returned by
   `redactAOProfile` (project id/path, config hash, honest observation description). Each applicable
   stage has explicit `{harness,model,effort,provenance}` from the already resolved FVS selection.
   Record requested/resolved/observed provenance separately in the stage evidence. CLI config
   omits effort; that and effective child identity stay unknown unless actually observed. Fixed
   launch overrides are session-only. No profile fallback, project-settings write or guessed slug.
   Model launches name the applicable FVS key in `target.selectionStage`: specification uses
   `research` or `fc_spec`, review `spec_review`, and proof `fc_proof_plan` or `fc_proof_execution`.
   Differently configured research/execution run in separate sequential AO stages with bound
   artifact handoff and owned retirement. Combined direct procedures require exactly equal tuples.
3. Prepare the fresh caller-owned16 request. `nextTransition({projectRoot,currentRequest,out})`
   accepts closed `currentRequest:{resume,registry:{root,headSha256},authorization,profile}`.
   It reconciles and independently consumes its own fresh result, reads13/14/current15 facts and
   returns one proposal or explicit partial reasons, always `executable:false`. A request with a
   transition is refused here. Proposal computation does not reserve or execute work.
4. For that one action, retain an immutable `fvs/auto-transition-request` version1 file. Required
   fields: `runId,transitionId,reservationId,kind,stage,nodes,owner,expectedHeadSha256,before,target,
   authorization,profile,basis` plus schema/version. `before` is the exact observed fixed/source/
   worker/registry/baseline/store snapshot; nullable inputs mean no current proof. `basis` is null
   or the exact prior before/after hashes and completion reference that explain expected staleness.
   The implementation's closed targets are the schema; use existing actual paths, never examples
   as execution inputs. Add its `{file,sha256}` as16 `intent.request`; old16 histories stay valid.
5. Record the16 before under current expected head/CAS and original capacity. Immediately before
   an effect, independently consume with `verifyTransition` against the same held request/output.
   `executeTransition({projectRoot,request,beforeOut,producerOut,evidenceDir})` supports fixed argv
   for stock AO spawn/send/kill, exact owned FF,14 register/revise and15 freeze/check/accept.
   It durably creates exclusive effect evidence under that before **before** invocation. Replay
   cannot run it again; unknown outcome retains the marker/reservation. No worker shell command
   is accepted. Construction and sibling composition use their existing controller procedures;
   retain real command receipts and independently checked allowed-path/content commits.
6. Retain `fvs/auto-transition-completion` version1 with run/transition/reservation, semantic
   action hash, actual before hash, bound command receipt and bound producer result. Command
   receipts bind actual argv/cwd/allowlisted environment/tool/input-output hashes, wall times,
   exit/signal/error and complete stdout/stderr. Metadata is trusted controller evidence, not OS
   attestation. Record after with its own fresh20 request, actual post-Git/14/15 observations and
   current runtime predecessor. No success from an uncertain command or worker verdict.
7. `facts-recorded-partial` explains only the finite permitted delta and names a possible next row;
   it grants nothing. A new `next-action-eligible` result requires a matching retained successful
   before/completion/after explanation, exact current identities, fresh memory/profile/actor,
   remaining original budget and a new before CAS. Unknown drift, old head, missing receipt,
   replay, corrupted output and changed scope/grants refuse. After expiry, retain facts as
   unverified; no next action can execute. A provisional check unblocks no consumer.

The runtime keeps its existing1MiB byte limit and every historical field/event. Compact JSON
encoding removes whitespace only; it neither resets history nor changes event hashes. Reaching
the bound remains partial. New22 events additionally set `observation:null` and retain an
`observationInput:{file,sha256}` for their immutable owned observation file. Updated consumers use
`readRuntimeObservation(event)` from the installed transition helper; legacy inline observations
remain unchanged and readable without writes. Replay validates each reference/closed body under
the same1MiB per-observation limit, with no cross-run cache. The recorded event hash binds the wire
reference; full results/receipts remain separate retained evidence. Missing/altered/oversized/aliased
observations refuse before effects. Keep these files just like the already required request/tool
receipts; no frozen M1 record, logical history or old evidence is removed.14 exit6 with a verified actual `recorded` event is a conclusive
unready/recheck result, not a failed command to retry or a review/proof PASS. Other unfamiliar
exit/result combinations remain unverified.

CLI forms use the installed `scripts/fvs-auto.mjs`: `next-transition`, `verify-transition`,
`execute-transition`, `verify-startup`, and `ack-work` take `--input` with the corresponding API
options and `--project-root PRIMARY`. Output paths are fresh owned canonical directories outside
the protected project. Preserve failures; never reset history or rebind old evidence.

## Actor startup, preparation and release

Reserve a node/slot with16's ao-launch discriminator, null future session and exact branch/assignment.
Allocate the startup challenge and worker20 attempt/phase/resume IDs in the action before launching.
The launch prompt says prime/acknowledge/wait before source or task work. This is a trusted prompt
contract; idle activity and clean Git do not establish suspension. Serialize launch correlation:
retain actual spawn output plus fresh AO ls/get and Git worktree porcelain. Use an identified
returned session or one unambiguous inventory delta with exact branch/project. Neither AO ls nor
get supplies a worktree path. Unknown/conflicting correlation stays uncertain and holds capacity.

The worker uses its actual session/worktree and independently retains the allocated20 request,
primes through worker-readonly, and returns a `fvs/auto-startup-ack` version1 with run/action/before
hash, challenge, exact actor, own memory request/output and `waiting:true`. The controller reconstructs
its expected request from its allocated IDs and current canonical binding; it does not adopt the ack's
expectations. `verifyWorkerStartup` validates those bytes and current AO/Git. Missing/wrong/stale ack
or unsolicited source write stops preparation. The current startup actor binds clean W0, path,
branch/commonGit, reservation/assignment and profile provenance, never an AO path guess.
Both startup acknowledgement and execution-start marker bind `memoryEvidence:{out,result,
requestInput,prime}` with actual file/hash references checked against the worker's own request.
Join the actor to its original reservation/session/path/branch/profile, rather than any same-project
worker or registered worktree. Memory readiness is not actor authentication.

Prepare through an exact clean FF to candidate C. Recheck ack and W0 immediately before; re-read
Git/AO immediately after and require C/tree, same branch/path/commonGit and clean status. Retain the
updated controller association. This changes only W/association source, never integration S/R/B/A.
No force/reset/clean repair. Sibling composition is separate: candidate assignments/owners and
explicit path/content hashes, exact expected S0 parent, independently verified resulting commit/diff.

Release is its own paired effect. First persist the exact `fvs/auto-work-packet` version1 and one
stable `deliveryHandle`; bind its reference/handle in the release action/before. The packet binds its
launch/action/before, actual actor/prepared source, new challenge, **new separately allocated** worker20
request, direct procedure, bound input refs, nullable explicit resume link and canonical start-marker
path. Then use stock `ao send --steer --client-message-id`. Unknown delivery recovers **that handle**
with `--recover-only`; delivery proves no execution. Never send/spawn again under a different handle.
First release always derives its exact successful preparation/startup chain from16 history, even
with a current cache or `basis:null`. A no-op FF still records this barrier. Worker consumption
independently restores the same prerequisite; resume also retains that original chain and its
separate conclusive source/artifact link.

The coordinator publishes the successful delivery after-event before worker start permission.
`transition-release-not-published` means wait/read-only recheck of this exact packet and original
handle within the remaining deadline, not another send or an owner question. A publication crash
leaves pending evidence and no start. After start is granted, legitimate worker progress cannot
race an unfinished delivery publication; its source/artifacts use the subsequent work outcome.

The worker independently primes its new request, validates the exact packet, current release/context
and actor/source, then calls `acknowledgeWorkPacket`. This atomically publishes a durable actor/packet/
memory-bound execution-start marker before any work. Only this fresh call's `mayStart:true` permits
the assigned procedure; a saved result is not reusable permission. Duplicate packet/restart returns
the existing acknowledgement with `mayStart:false`. A crash/competing marker leaves uncertainty;
there is no inferred nonexecution. Continue only from a conclusive terminal/PARTIAL result with a new
explicitly linked resume within remaining budget. Uncertain prior execution cannot be resumed twice.
Every role rechecks the original run deadline and latest recorded wall-clock floor after expensive
reads and at marker publication/permission return. Proof-invocation limits are additional. Expiry or
rollback after marker allocation preserves uncertainty and grants no work; an existing marker is
never evidence of nonexecution.

A later release for that assignment requires `resumeOf` pointing to a conclusive
`fvs/auto-work-completion` version1 already retained in a succeeded16 after-event: exact run,
old packet/start-marker references, actual recorded `sourceAfter:{commit,tree}`, finite
completed/partial/failed outcome, nonempty bound artifacts and the controller session. Match the
recorded actor/reservation/assignment and original marker path. An unrecorded declaration or a
new handle alone cannot release work. This closes execution only, with no proof authority.

After validating immutable candidate artifacts, retire only the exact owned stage session with stock
`session kill`. A fresh same-project/session get.isTerminated:true plus16 resolution releases its
capacity; idle/exited never does. Preserve every worktree/branch/uncommitted file. Local effects recover
through16's typed conclusive completion, not a second effect.

## Existing procedures, without hidden child workers

Start without owner-supplied specs. Run existing auto-extract/repair and10/21/13 producers with exact
source/configuration. Initial construction may establish previously null extraction/graph/plan refs
only from reproduced producer receipts; it invents no accepted baseline. Unsupported groups remain
explicit while independent families continue. Bind the agreed nonpublic scope to selected obligations
through the mandatory canonical applicability check, not graph-root naming or a fake public classifier.

For each owner, launch one specification actor with `lean-specify/controller-direct`. In that seat,
execute the existing research and executor instructions sequentially under the supplied applicable
manifest: full source/type/body/dependency/RFC/version/assumption context, style and build checks. For v2, use configured network-enabled research and pinned acquisition under the existing grants;
freeze stable source/tool/dependency inputs for checking. V1 retains its recorded offline check
conditions. Acquisition does not silently upgrade pins or authorize provider allocation. Return immutable candidate/artifact hashes to the controller; do not launch a nested reviewer.

The controller composes allowed spec/context changes, then prepares `lean-spec-review` with runtime
`other` using the existing preflight/export. It launches a fresh read-only AO review actor, gives it
the complete exported prompt/context and imports its response through the existing `import` validator.
Preserve actual session/model/effort evidence and honest Other/unverified labels; a packet export is
not review. Distinct reviewer run/session and exact candidate/global14 head are mandatory. Only fresh
PASS reaches14; rejection/APPROVE-WITH-EDITS revises, never weakens intent or marks human approval.
Serialize review preparation/publication because any14 append stales unused review. Three rounds
become a resumable checkpoint under the original global budget, not a mid-run owner gate.

When14 contexts are ready,15 freezes pristine context with overlays absent. Changed node and all
consumers invalidate/review/reprove/recheck; proof-only edits recheck without semantic re-review. Never
refresh expectations from a candidate. For bottom-up proof actors use `lean-verify/controller-direct`:
research and execute in that actor, fixed frozen statement/definitions, ordinary style/build/audit
requirements, no nested provider. V2 follows the original optional execution budget and small-proof progress policy in
`auto-execution.md`; legacy v1 retains its finite invocation bound. Chosen resources/spending stay sticky. A failed audit stops readiness. Preserve
all controller evidence rather than running standalone cleanup. Worker VERIFIED is candidate evidence
only; this route uses the existing auto frozen B instead of creating standalone acceptance authority.
Distinct roles use `lean-specify/research-direct` then `author-direct`, or `lean-verify/plan-direct`
then `prove-direct`, consuming the prior role's bounded artifacts. Proof launches carry
`target.invocation` (null otherwise): immutable `fvs/auto-proof-invocation` version1 with run and
invocation IDs, original `startedAtMs`, whole-minute `budgetMs` up to four hours, and
`deadlineMs=min(start+budget, original run deadline)`. Retain the same reference in each split-role
packet's inputs. Expiry checkpoints; only a conclusive linked outcome permits another invocation
within the unchanged project budget. The helper and existing proof loop use this same deadline.

The controller runs15 provisional check, composes one ready proof frontier into fixed integration S,
then serially checks/refreshes helpers and publishes consumers bottom-up at that same tree. No source
change mid-batch. Older node/tree/helper-generation heads remain stale until actually rechecked;
standalone/worker verdicts and14 provisional/declared-independence records unblock nothing. Once whole
selected-scope currentness is recomputed, return only the typed authoritative-reference handoff to17,
including every unfinished/unsupported reason.17 materializes the bundle;18 handles human re-spec;
19 qualifies actual stock-AO end-to-end behavior. This protocol does not open a PR or complete them.

Before any live provider tracer, bind its concrete owned project/source/scope, actual complete
capability/profile/standing-override manifest, execution/resource limits, memory/paths and evidence
matrix under19's separately authorized gate. Component doubles, simulation and real15/16 qualification
are distinct; none silently grants live provider execution, publication or target proof promotion.

## Retained-store revision continuations

Legacy three-key `basis` and both closed v1 work/start formats remain unchanged.
The optional closed basis `{version:2,beforeEventSha256,afterEventSha256,completion,workCompletion}`
revalidates the actual successful before/completion against its recorded after snapshot,
then compares fresh canonical source, registry, baseline, accepted store and every fixed
run/scope/grant/profile/memory/stage/accounting field. Pending or unexplained drift refuses.
Only an exact published release may set `workCompletion`; other rows require null.

The finite successors are: current-source freeze to a protected-target recheck or
dependency-ready proof launch; fresh accept to another accept, protected recheck or
dependency-ready proof/review launch; actual registry revision to a fresh qualified
publication, needed specification/review launch or freeze when all14 nodes are ready.
A protected recheck requires prior integrated proof evidence with the same target/module,
exact frozen protected source bytes and current accepted helper dependencies. Mutable or
future overlay targets do not qualify. All other successors retain the legacy restrictions.
Unrelated stale heads stay historical: neither a continuation nor provisional check makes
them current, and the full15 currentness inspector is unchanged.

A release successor to candidate composition/materialization or review publication needs
the unchanged closed nine-key `fvs/auto-work-completion` v1 envelope, outcome completed,
with exactly one separate `fvs/auto-work-result` v1 artifact among its bound artifacts.
The result's closed fields are `schema,schemaVersion,runId,packet,marker,actionSha256,actor,
kind,prepared,result,controllerObservedAtMs,controllerSessionId`. Actor is the exact issued
packet actor; prepared is its `{commit,tree}`. Candidate result is
`{commit,tree,files,assignment}`; review result is `{contract,review}`. The completion's
sourceAfter is the exact resulting `{commit,tree}`. Unknown versions, mixed formats,
missing/multiple typed results or another actor/packet/result refuse.

The controller independently observes the assigned actor's clean Git identity and candidate
FF ancestry/allowed paths, or unchanged reviewer source plus exact candidate/head-bound
independent unused14 packet. Its new before binds the completion; its succeeded after must
retain that same completion in effect evidence, including the observed association. This
retention supports the existing legacy linked-resume reader; it grants no automatic resend
or retry. The issued packet/start marker identifies the reserved consumer; copying or freshly observing
the same result cannot create another consumer.

The execution-start v1 marker has no timestamp. Its hashes establish causal identity,
not measured worker start/runtime. The published release-after observation and original
invocation/run/last controller observation supply the lower bound for the newly retained
controllerObservedAtMs, which must be no later than the current observation and inside
the original limits. A fresh clock fence after all reads refuses rollback or exhaustion.
All before-CAS, capacity, fresh20/16, proof-dependency and strict final-inspection gates remain.
These files are trusted controller evidence, not process isolation or proof receipts.

### Exact review input and stale-store retirement

Specification/review launch nodes must belong to the supported selected13 union. A known
selected node without a contract is distinct from an unknown/out-of-scope ID. Local
controller actions can retain empty control-node reservations; no second actor owns a node.
For a v2 review-result continuation, put exactly one typed `fvs/auto-review-input` v1
in the existing packet.inputs. Its closed fields are schema, schemaVersion, node, contract,
candidateSha256, registryHeadSha256. The immutable contract reference, node and exact
candidate/head must match the issued work and returned review. The node must be in that
launch's assignment. A valid review for another node or a newly chosen candidate does not
qualify; issue a separately linked fresh packet instead. Legacy work envelopes stay readable.
Registry invocation shape/schema/version and referenced input bytes are checked before intent/command creation as well
as after execution, through one shared reader; unknown keys/versions cannot append14 first.

After an actor's completed materialization/composition/review publication, v2 may retire
only that exact issued actor, preserving S/R/B/store and the original clocks. Use the normal
terminate action with empty control nodes, exact association and completed output basis.
A terminated session alone still holds its original reservation. Resolve it using the same
terminate kind with closed target `{sessionId,association,operation:resolve-terminated-reservation}`
(the operation is a JSON string), and the existing16 reconcile-stage reservation-resolution intent targeting
that exact original reservation. This operation has no executable command. Its paired after
uses reason session-terminated and the real terminated observation reference both in
resolution.evidence and effect.evidence. For this explicit operation only, that reference is
the basis completion; no external command or legacy completion is fabricated.

An already conclusively terminated issued actor can resolve directly from its completed
output basis; otherwise retain the successful terminate before/completion/after first.
Unknown/uncertain effects, unrelated actors/reservations, idle sessions, drift or exhausted
limits grant nothing. The fresh AO observation must match the project/session and actual
owned association before capacity is freed. A completed resolution permits only the original
output row's finite frontier, with its canonical projection unchanged; the strict15 inspector
continues to refuse stale proof. No store clearing, current-cache flag, new run or new queue.
