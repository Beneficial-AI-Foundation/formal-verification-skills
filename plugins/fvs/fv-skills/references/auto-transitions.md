# Bounded auto controller route

For v2 actions, worker packets, cancellation and handoffs, read `auto-execution.md` first. It defines the explicit execution policy, optional memory and current lifecycle. The version1 field tables and finite bounds below describe retained legacy records; apply them only to v1.

<purpose>
Bind the existing AO/FVS stage loop to current agreement, memory, source and checker evidence.
Keep uncertain effects partial and preserve whole-scope gaps for the17 handoff.
</purpose>

## Production driver: authorized v2 continuation

Use `scripts/fvs-auto-driver.mjs` from the **one fixed trusted engine** in the controller context.
Per-worktree workflow installation does not make each copied script a separately trusted checker.
This source supplies the adapter; an installable preview still requires its exact source and real
qualification. Existing receipts remain bound to their original engine bytes.

The actual AO orchestrator reads the current canonical agreement and applies its semantic scope,
claims, trust and execution grants. V2 alone, a source-review PASS or a saved ready label grants
nothing. Keep the legacy/read-only reporting route when this context is absent. Current live actor
execution needs the concrete19 capability/profile/permission setup; fixture tests supply no grant.
Initial setup and final human review remain the human gates; routine source-grounded iterations
continue under the existing grant. A missing capability is a precise partial result.

### Requests and paired effects

Resolve the engine's actual absolute root from the held context; quote every path. Import its
`fvs-auto-driver.mjs` for awaited JS calls, or use `node "$DRIVER" OP --input "$INPUT"`.
The CLI operations are `prepare`, `advance`, `effect`, `after`, `prepare-review`, `import-review`.
Write actual JSON inputs to exclusive caller-owned files; JSON values never become shell text.

The closed JS/CLI inputs are:

| Export / operation | Exact fields |
|---|---|
| `prepareCurrentRequest` / `prepare` | `{projectRoot,context,phase,transition}`. `context` is exactly `{runId,ao,source,inputs,associations,priorAccounting}` with the existing16 nested schemas; `phase` is `start` only for a genuinely new run, otherwise `resume`. `transition` is null or the existing exact before/after envelope. |
| `recordCheckpoint` (JS) | `{projectRoot,request,out}`; returns `{request:ref,result:ref,out,value,verification}` after the actual16 producer and independent consumer. |
| `advanceOnce` / `advance` | `{projectRoot,currentRequest,out}`, with existing closed `currentRequest:{resume,registry,authorization,profile}`. Ordinary `resume.transition:null` calls22's strict proposal. A concrete before request takes the action-specific path directly; it records/verifies that action, without an unconditional strict proposal first. |
| `runPairedEffect` / `effect` | `{projectRoot,request,out}` with an exact v2 before request. Creates exclusive `out/before`, `out/producer`, `out/effect`; awaits16 verification and22 execution. Returns command evidence, before and status, **not** an invented after-state. |
| `recordAfter` / `after` | `{projectRoot,request,out}` with the fresh actual after request, original intent/before hash and real completion/effect evidence. Independently verifies16; returns checkpoint and a v2basis template only for `facts-recorded-partial`. |

Choose one before-producing route per action. `runPairedEffect` records its own before; call it
directly with the concrete request. `advanceOnce`'s concrete-before route is for the existing
externally managed construction/composition/resolution procedures. If that route has already
recorded a before, use its retained checkpoint with the existing producer procedure (or
`executeTransition` with that `beforeOut`), then `recordAfter`. A second before is a replay, not
the next step.

Construct `context` from actual AO/controller identity, current integration Git commit/tree,
canonical stage input references, association receipts and original accounting. Use the original
run ID on resume. The preparer allocates fresh attempt/resume IDs, reads the real current runtime
head and prepares the current Beads request when enabled; disabled memory stays null. It neither
discovers source nor resets policy. Re-read actual input/store heads at every boundary.

For one concrete effect, build the existing closed22 action and intent from that fresh snapshot,
with its exact authorization/profile and existing target schema. Run `effect`. Preserve the returned
command receipt and its actual stdout/stderr/result; build the existing
`fvs/auto-transition-completion` v2 from that exact command, action hash and recorded before hash.
Observe actual post-Git/AO/14/15 inputs; prepare the new after request and call `after`.
Launch completion joins the real association; do not list that same association twice in the after
request. Construct/composition and reservation resolution keep their existing procedures and checked
command/evidence paths; `effect` does not execute arbitrary worker shell text for them.
The adapter awaits v2 work and forwards SIGINT/SIGTERM or stdin
`{"kind":"cancel","invocationId":"<this action transitionId>"}` through the existing owned-process
adapter. An uncertain result retains its marker/reservation; it does not publish a successful after.

`command-recorded-partial` is a typed producer outcome requiring its actual completion/after checks.
`facts-recorded-partial` is explained delta evidence with `executable:false`. Neither means PASS or
dispatch permission. Use the returned exact basis
`{version:2,beforeEventSha256,afterEventSha256,completion,workCompletion:null}` for a candidate
successor. Only an exact published release's conclusive typed actor result may supply a nonnull
`workCompletion`. The existing finite validators below admit or refuse a fresh action-specific
before. During ordinary revisions, stale accepted receipts need this explained route; a strict
transition:null proposal can refuse them. Keep the store/history intact. Unknown effects retain
capacity; final whole-scope15 currentness stays strict.

### Bootstrap: agreement to first dispatch

This is the order a real rc1 controller used. It needs no further driver. `prepareCurrentRequest`,
`recordCheckpoint`, `advanceOnce`, `runPairedEffect` and `recordAfter` are `fvs-auto-driver.mjs`
exports, with the CLI operation in brackets. `redactAOProfile` and `transitionSnapshot` come from
`fvs-auto-transitions.mjs`; `readState`, `verifyWorkerStartup` and `acknowledgeWorkPacket` come from
`fvs-auto.mjs`. Write each JSON input to a new owned file, run one operation per command, and keep
every output.

1. **Agreement.** `/fvs:auto-init` records the agreement and v2 choices; `prepareCurrentRequest`
   refuses without them.
2. **Run context.** For a new run, write `{runId,ao,source,inputs,associations:[],priorAccounting:null}`:
   - a new run UUID;
   - `ao:{tool:{file,sha256},stateHome,projectId,coordinatorSessionId}`;
   - `source`: the integration Git root, commit and expected tree;
   - `inputs`: the bound extraction, graph and plan references, with null `baseline` and
     `acceptedStore` for a new run.
   `runId` and `ao` stay fixed for the run, including the coordinator session, and the original
   accounting and policy are kept. Refresh `source`, `inputs` and `associations` from validated
   effects before each request: after a launch, `associations` lists the recorded associations, and
   `source`, `baseline` and `acceptedStore` change when their effects are recorded. Never reuse a
   stale copy. Prepare every request fresh, with its own current head and memory request.
3. **Start reconciliation.** `prepareCurrentRequest({projectRoot,context,phase:'start',transition:null})`
   [`prepare`], then `recordCheckpoint({projectRoot,request,out})`, which records and independently
   consumes it. A CLI controller records it with `fvs-auto.mjs state`, then still consumes the result
   with `verifyReconciliation` against its held request (`auto-resume.md`). `start` is valid once
   only; later requests use `resume`.
4. **Profile and authorization.**
   - Read `ao project get PROJECT --json` once, and pass its bytes to `redactAOProfile` for the
     profile's `controller`.
   - Build the stage profile from the persisted FVS stage selection (Controller loop, step 2).
   - Build the action authorization from `readState({projectRoot,requireAgreement:true})`: agreement
     context hash, approved payload hash, `payload.execution` and one correspondence row per action
     kind (step 1).
5. **First proposal.** Prepare a `resume` request with `transition:null`. Then call
   `advanceOnce({projectRoot,currentRequest:{resume,registry:{root,headSha256},authorization,profile},out})`
   [`advance`]; a new run's registry head is null. The result is one proposal or named partial
   reasons, always `executable:false`.
6. **Launch.**
   - Build the closed `launch` action for the proposed nodes, with new transition, reservation,
     assignment, challenge and startup IDs, and `basis:null`.
   - Take its `before` from `transitionSnapshot` over a fresh `resume` request whose head is the
     current runtime head.
   - Prepare the `ao-launch` before request (`sessionId:null`, intended branch, assignment) and run
     `runPairedEffect` [`effect`].
   - Observe the actual session and worktree, and write their association. Build the v2 completion
     from the command receipt, then call `recordAfter` [`after`] with that association.
7. **Actor readiness.**
   - Install the actor permissions and send the permission-ready notice (Actors and permissions).
   - Verify the worker's startup acknowledgement with `verifyWorkerStartup`.
   - Run `prepare-input` (the exact FF) as a paired effect, and record its after.
8. **First dispatch.**
   - Write the work packet to an owned file outside the worker worktree, source root and canonical
     root.
   - Set `startMarker` to a not-yet-existing file in the same directory as the packet. Release
     preparation refuses any other placement (`transition-marker-invalid`) before anything is sent,
     because the worker could never acknowledge such a packet.
   - Run the `release` paired effect and record its after.
   - The worker starts only when its own `acknowledgeWorkPacket` returns `mayStart:true`.

After a recorded effect, `recordAfter` normally returns a verified `facts-recorded-partial` with a
basis. That is not a failure: carry the basis into the next action, which is admitted only by its own
validation and a fresh before. Stop instead at a refusal or a blocking partial result, such as named
partial reasons, `facts-unverified`, an uncertain effect or a missing prerequisite. Keep its output,
re-read state and never rerun the same before.

### Actors and permissions

Resolve each FVS role through the current stage manifest, preserving requested/resolved/observed
model and effort separately. Differing roles run sequentially with artifact handoff; matching tuples
may use the existing combined direct procedure. No fixed model, silent substitution or nested role.

After the paired launch, bind the actual same-project session/worktree association. The worker's
launch instruction waits before its first gate call. For an explicitly granted Claude gate profile,
run the trusted `fvs-auto-actor-permissions.py --input REQUEST.json` once for that actor. Its closed
request is `{schema:"fvs/auto-actor-permissions",schemaVersion:1,projectRoot,association,grant,node,gate,out}`;
all four references are actual `{file,sha256}` inputs. The held grant body is
`{schema:"fvs/auto-actor-permission-grant",schemaVersion:1,runId,projectId,controllerSessionId,gate,node,ownerReference}`.
Its reference records the actual approval of these tools/rules; do not invent approval from null
execution or permission mode. Node/gate name the fixed trusted executables, not consumer scripts.
Use an already installed recorded Python3; a missing executable is a named capability gap, not an
implicit tool installation.

The merger preserves hooks and unrelated keys and retains before/after bytes. Existing permissions,
drift, aliases or uncertain installation hold the actor. Compare then atomic replace assumes a
trusted/supervised writer; it is not OS atomic CAS or actor authentication. The plain `node` rule
uses PATH and is not executable-hash enforcement. Matching quoted rules and actual native-runtime
permission handling require their own qualification. Other harnesses need their real qualified
permission route; Claude settings are not portable authorization.
Literal wildcard/pattern characters (`*`, `?`, or line breaks) in node/gate paths are refused
before output or settings writes. Shell quoting does not make a permission wildcard literal.

Only after verified association/profile/install readback, send one permission-ready notice naming
the launch, actor/worktree and retained installation receipt. This is trusted instruction coordination,
not OS suspension. Then obtain the fresh startup ack, prepare-input FF and published exact work
release/start marker through the existing protocol. Missing evidence remains held; use the agreed
auto mode/profile, never a global bypass or new admin credential. The notice itself grants no task
edits; only the original work-start guard does. Same-handle delivery recovery remains mandatory.
This permission-ready instruction is a v2 extension. Legacy v1 launches retain their original
startup instructions.

### Actual specification review bridge

Use10/21/13 to bind the agreed nonpublic targets and entire closure, with one helper owner. Keep
unsupported/missing/failed targets in the separate full scope inventory. A name/graph root is not
scope approval or public-API discovery. Author through `lean-specify/controller-direct`, or split
research/author roles, using full actual source/type/body/dependency/standard context. Compose only
the allowed exact candidate bytes before review.

Export the existing grounded Other packet through `fvs-spec-review.mjs preflight` then `run` with
runtime `other`; export invokes no reviewer. `prepareReviewBinding` / `prepare-review` takes exactly
`{projectRoot,source,plan,graph,registry,contract,packet,prompt,out}`. `projectRoot` is the canonical
primary runtime/agreement/memory root. `source` is the actual existing16 Git source identity
`{kind:"git",root,commit,expectedTree}`; its root is the integration/spec root, not a guessed cwd.
Export the Other packet in that source root and keep new specDefinitions there. The binding checks
the common Git store, actual clean commit/tree/branch and the issued/prepared source before review
publication. Keep distinct worktrees distinct; do not copy specs into the primary to satisfy a check.
It computes the actual14 candidate
fingerprint/current global head and freezes the contract/context, author, exported packet/prompt and
source hashes. It returns `{binding,input}` references. Include **both** in the new review work packet;
the reviewer reads the full binding/contract and exported prompt. `input` is the existing six-field
`fvs/auto-review-input` v1. Never bind an old PASS to a new candidate/head after review.

Launch a fresh read-only reviewer under `spec_review` with `procedure:"lean-spec-review/Other"`
through the actor protocol above. Retain the
actual returned Markdown and its association with the issued work packet. `importReviewedContract`
/ `import-review` takes exactly `{projectRoot,binding,workPacket,marker,response,session,settings,out}`.
`response` references a controller-held record exactly
`{workPacket,marker,binding,response:<raw Markdown ref>,reviewerInvocation:<actual launch transitionId>}`.
`session` and `settings` reference actual retained AO session-get and config-options JSON, not requested
settings copied into observed fields. Missing model/effort evidence stays unknown and holds the
settings-dependent route. This is trusted controller evidence, not provider authentication.

The bridge independently observes the active assigned actor/Git, checks the published release/start,
original policy/current memory and held candidate/head, then seals the exact returned Markdown into
an exclusive response snapshot and calls the actual Other importer on that snapshot in the bound
integration/spec root. Retain the importer's actual raw, normalized, transformation and review
artifacts. Revalidate the sealed bytes through the existing normalizer, compare the imported outputs
and rehash relevant inputs before publication. The14 verdict comes from the validated normalized
import, never a cached read of a path the child later reopens. Substituted/tampered responses hold
the route; supported normalization keeps its raw and normalized hashes distinct.
It constructs14's existing review envelope from the prior binding and fresh invocation/provenance:
clean PASS → `pass`; APPROVE-WITH-EDITS/REVISE → `changes-requested`; BLOCKED/malformed/unavailable
evidence → held/no PASS. Other stays externally supplied/unverified;14 independence stays declared
distinct session/run, `verified:false`. Submit the actual resulting envelope through the paired
registry-revise action. Any append or semantic/context edit needs a fresh bound review. Serialize
review preparation/publication. Three rounds checkpoint under the original run; do not add a
routine human approval or weaken a statement to obtain PASS.

### Proof and final handoff

After current14 readiness, freeze15 with mutable overlays absent. Use22's ready frontier for actual
`lean-verify/controller-direct` work (or separate plan/prove roles), original budgets and meaningful
progress. Integrate only allowed exact candidate bytes and retain the actual typed work completion.
Check independently through15, then accept dependency-first and serially at the fixed tree. During
revisions use the finite basis route above. Worker VERIFIED and driver command success accept nothing.

At complete or precise partial status, inspect the entire original selected scope, reconcile current
state and build/verify17 using the actual current request and historical captures. The artifact keeps
integrity, live currentness, unavailable inputs, each root's PASS/partial reason and pending human
review separate. A draft PR requires its separately recorded publication grant/trusted publisher.
Human feedback revising reviewed contracts is unsupported in rc1; stop before revision effects or
provider dispatch, preserving whole-scope partial reasons. Internal18 diagnostics grant no continuation.
An all-fail run is not a successful pilot.
No public-API/whole-crate/platform/side-channel claim follows from this bounded route.

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
capacity; idle/exited never does. FVS itself deletes no worktree, branch or file, but AO's `session kill` may
remove the worker's worktree, so commit or bind anything still needed before the stop. When it does, the
stop's after and its resolution record the retained last-known worktree with `absent:true`. This is admitted
only for that owned stop, with AO reporting the session terminated and the path gone and no longer registered;
any other absence, or a present but changed worktree, still refuses. A controller building the resolution's
before uses the exported `absentWorktree` shape. Local effects recover through16's typed conclusive
completion, not a second effect.

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
including every unfinished/unsupported reason.17 materializes the bundle; human re-spec is unsupported in rc1;
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
