# Same-pipeline human re-specification

<overview>

After an end/partial17 artifact the owner can request changes to chosen contracts. Preserve the
initial scope, feedback payload and original run accounting. Use the existing grounded specify,
fresh review, proof, check and serial acceptance stages; no routine human gate at each round.
The helper below validates correspondence and current observations. It creates no proof, dispatch,
human approval or publication authority, and it runs no model or proof compiler.

</overview>

```text
node <installed-scripts>/fvs-auto-respec.mjs inspect --request REQUEST.json --out NEW_INSPECTION
node <installed-scripts>/fvs-auto-respec.mjs finish --request CURRENT.json --out NEW_RESULT
node <installed-scripts>/fvs-auto-respec.mjs verify --request CURRENT.json --out EXISTING_RESULT
```

The JS operations are `runRespec({request,out})` and `verifyRespecResult({request,out})`. The consumer
provides its independently held current request. Verification creates separate bounded evidence;
it does not reuse a saved ready label. New outputs must be outside source, memory, registries,
checker evidence and the prior bundle. Preserve failed outputs and old requests/receipts.

## Exact request

Use the closed `fvs/auto-respec-request` version1 object:

| Field | Value |
|---|---|
| `schema`, `schemaVersion` | `fvs/auto-respec-request`,1 |
| `revisionId`, `attemptId`, `operation` | Original revision UUIDv4, fresh current16/20 attempt UUIDv4, `inspect` or `finish` |
| `ownerFeedback` | `{ownerReference,evidence:{file,sha256}}`; actual retained owner payload/reference, no Boolean authentication |
| `priorBundle` | `{manifest,expectedContext}`; exact17 ref and independently held original captured context |
| `current` | `{bundle,resume,memory,authorization,profile}` below |
| `requestedItems` | Complete original requested items, each `{itemId,nodes,expectedRecords,feedback,evidence,response}` |
| `inspectEvidence` | Null at inspect; `{request,result}` exact initial18 refs at finish |
| `deadlineMs` | Future absolute inspection deadline, at most600s; proof-currentness work also stops at the original run deadline |

`current.bundle` is the complete current17 build request, including actual source, agreement,
extraction/graph/plan, full scopeInventory, registry/store heads, baseline/runtime and explicit absence
reasons. Its deadline is no later than18's. `current.resume` is `{request,result,committedHeadSha256}`:
the exact current16 request/result refs and independently expected committed head.16 phase is `resume`;
the current request can be an ordinary reconciliation or a typed22 before/after observation. The fixed
existing consumer verifies it. `current.memory` is `{request,result}` for that same attempt and16's
actual consumed bootstrap output. `authorization` and `profile` are existing22 exact refs, resolved
against current canonical agreement. No fallback model or new role setting.

Each item has a unique `itemId`, explicit sorted node IDs, and `expectedRecords` entries
`{node,recordSha256,candidateSha256}` for those original node versions. `feedback` and nonempty evidence
refs record the workflow's owner-request correspondence. They are not a language classifier.
For an item with no registered version, use `{node,unestablished:"actual reason"}` instead of invented
hashes. Selected unregistered and unsupported/unmapped IDs remain visible in the whole request and
node inventory as non-executable partial facts. A known version still needs exact current hashes;
an unestablished flag cannot hide an existing record. A response cannot clear this original unknown
version. Once a prerequisite is established, prepare a fresh inspect frame from actual versions,
preserving the owner payload, original scope and accounting without another routine owner gate.
`response` is null until there is an actual prepared response. A response ref names the closed
`fvs/auto-respec-response` version1 object with `revisionId,itemId,ownerFeedbackSha256,priorCandidates,
contracts,correspondenceEvidence` (plus schema/version). The candidates equal the original item versions;
contracts use the same node-version shape but must name actual current14 records. Correspondence refs
retain the specification/review rationale. The workflow must independently read the feedback and assess
that rationale against the revised contracts; a byte-bound response does not establish human approval.

## Guard the existing pipeline

1. Inspect the prior17 captured bytes using `readReviewSnapshot`; captured integrity is independent of
   live currentness and never launches a compiler/backend/AO call. Separately supply current12 applicability,
   fresh20 prime and16 Git/AO/accounting reconciliation. Maintain one primary project store. Missing,
   stale, unsupported, uncertain or expired context stays partial; never infer zero prior spending.
2. Keep the initial feedback, prior bundle, whole selected/applicability ledger, run identity and limits
   fixed. Prepare new caller requests at each boundary; retain initial inspect refs. Existing22 paired
   effects/reservations/current heads explain source, registry, frozen and accepted-store advances.
   Partial facts are not permission to dispatch. Actual stock-AO/provider execution still needs19's setup.
3. Specify and obtain fresh independent review where14's actual candidate/definition/type context changes.
   Revisions invalidate the changed node plus consumers; stale unused review packets cannot clear semantic
   review. Proof-only changes recheck and do not waive an existing semantic requirement. Preserve shared
   ownership and the full13 scope; never replace it with only an affected subplan.
4. For a later freeze, a prior overlay can become protected only when its exact whole-file bytes/Git
   tree match the previously current integrated15 proof, its descriptor is added to the applicable contract,
   and14 records a fresh semantic review/candidate with actual invalidation. Explicitly build that module.
   The new overlay remains absent from the current integration context; the old one is no longer mutable.
   Original extraction files stay unchanged. Expected terms still come from their fixed reviewed context,
   whose compiled import closure excludes prior and mutable proof modules. Promotion is no kernel-replay
   exemption. Use the approved versioned sequence, not source deletion, reset or a different freeze root.
5. Reuse unchanged proof text as candidate bytes, then obtain every current15 receipt required by the
   new global frozen/registry/source/helper tuple. Accept bottom-up and serially. Historical receipts and
   worker/model/provisional verdicts are not current acceptance. Never clear an old store or reset clocks.
6. Finish and independently verify over all original requested roots, failed items, helpers and scope
   applicability. An unfinished feedback item stays pending even if some proofs pass. Every required
   current proof and response must be present before `ready-for-final-human-review`. That status remains
   machine readiness only, with actual human review pending. On exhaustion keep explicit full-scope partial
   reasons; a separate bounded17 diagnostic snapshot may be written without starting new proof work.

Build a NEW17 review artifact from the complete current context and retain all prior artifacts. Human
approval must reference the exact resulting contracts/bundle and actual response. Another requested
revision uses the same path. Changed scope/limits/context that16 cannot reconcile stays partial rather
than silently rebinding the original run. No PR is created, published or merged by this helper.

Final clock/rollback checks follow all slow fence reads and output publication. Successful output has
`result-clock.json` binding the exact result/request and publication time; the independent consumer
requires it. A late or failed output, including a staged result beside `failure.json`, supplies no
readiness. Keep the successful CLI/API envelope (including its publication ref) as the17 handoff evidence,
so the review bundle retains that clock receipt as well as the result. Verification records its own
separate clock evidence; original run start/deadline never changes.

The original inspect implementation pair `6593d0f4` / `340a0278` is a finite
historical compatibility case. Both exact sources are retained as non-executable
data, with the original inspect/request/publication/frame unchanged. The current
helper and bundle keep their own executable identities.17 derives a versioned
`fvs/auto-bundle-historical-code` mapping from that inspect pair and copies both
the original path/digest identity and its exact archive body. Its captured-only
verifier derives the same required mapping from the raw inspect, rather than
trusting a caller-selected retention list. Missing, conflicting or changed
archive bytes refuse; this grants no proof/currentness authority.

Controller termination is a separate recovery type, never an ordinary producer
exit. `captureControllerProcessObservation` records one bounded, complete fixed
`ps -axo pid=,ppid=,pgid=,command=` observation in exclusive evidence. It does not
close a reservation. Observer failure, truncation, empty/incomplete inventory,
visible owned detached work or a surviving controller group cannot establish
quiescence. The initial supported profile is only
`configured-git-local-accept-finalization-v1`: the exact assessed controller,
wrapper, driver and builder sources, a complete verified Git export and terminal
configured-build child sequence ending in the environment query, before build
snapshot/kernel publication. The three controller sources are non-executable
reference data; the helper does not execute them.

The closed `fvs/auto-controller-termination-context` v2 binds caller-owned exact
run/before/action/reservation/job/output/marker/source/tool identities, actual
outer launch/kill/wait and clocks, all child/output identities, complete canonical
before/after observations and an independently captured process inventory. The
inner producer's start/end/exit/signal/error remain null with status `unknown`.
The original execution-uncertain marker, SIGKILL, missing terminal command and
history remain unchanged. The trust claim is current quiescence of the known
managed lifecycle on the trusted host, without retrospective full PID lineage
or an inferred producer result. An unresolved possibility of surviving work
refuses; it must not be replaced by an empty observer result.

This initial profile is the exact retained A122 controller case at
`/private/tmp/fvs45-ticket18-native-episode-0c4c1ino`, step
`122-e1-accept-20-continuous`, node20, originalrun386 and original40h deadline.
The pinned wrapper's ROOT45 cwd,226 source tuple and complete snapshot identity
are fixed. This is not a generic parameterization of that case-specific program.
Context v2 adds required `controllerBefore`, `caseContext`,
`candidateCheckOrigin` and `recoveryBefore` refs. Its actual durable before
envelope must bind the action, before request/result/out/manifest and prepared
ref. Prepared source, baseline, store, full snapshot, predecessor/raw runtime,
prior110 successful basis, check100 result and A121-specific consumed closure
must correspond, including the recorded preparation/before/job ordering.
The earlier closure establishes the starting predecessor only; it never closes
A122 or renews proof. No missing timing or producer outcome is reconstructed.

Executable refs are SHA-256 identities, separate from JSON/source documents.
They use the existing builder's bounded fd-stream/stat-drift pattern, adapted
inside18 because that engine routine is private. No executable is loaded as a
whole buffer or copied as metadata. The finite142769104B ceiling is exactly the
largest executable in the supported pinned cohort (Beads1.3.1); Node24.21,
Lean/Lake4.31, systemPS and systemGit are smaller. There is no headroom for an
unqualified tool upgrade. The32MiB document/source and512MiB copied-artifact
limits are unchanged. Every call rehashes bytes under its caller deadline;
canonical component paths, regular/executable mode, aliases, fd/path identity,
size/EOF, byte/stat drift, rollback and deadline checks remain mandatory.
Only the pinned root-owned `/usr/bin/git` system dispatcher may retain its
known hardlinks (exact path/hash/size/mode and at most78); arbitrary hardlinks
and all symlink aliases refuse. No caller-supplied alias or size override exists.

`assertKnownControllerPreparation` is only a correspondence assertion, returning
no receipt or permission. The public verifier always uses its real bound reader.
Separate tests check that exact assertion against copied retained metadata;
generic failure-algorithm tests explicitly double the profile assertion and are
not applicability positives. An unmocked consumer refuses their generic profile.
When retaining prior closure implementation33965088 in17, supply the existing
exact historical-capture mapping to its preserved non-executable source body.
Both the original logical code identity and archive body remain required copies;
keep the new executable identity separate. The6593/340a inspect pair is unchanged.

Only a future actual16 paired **failed after** can close its reservation. Its
exact request/result and committed head join the independently supplied complete
context in `fvs/auto-respec-controller-termination-request` v1, with a fresh
attempt and bounded deadline. `verifyControllerTermination` and the independent
`consumeControllerTermination` repeat current process/full16 canonical checks,
complete registry/store-prefix/head/byte checks and original clock fences. They
never append an after or mutate canonical state. No pending publication, dirty
source, changed grant/profile/memory/scope/accounting, stale head, incomplete
chain, clock rollback or exhausted deadline is admissible. These checks may
refuse within the original600s bound; no validation cache or larger cap is
implied. Successful evidence is `conclusive-known-lifecycle-termination`, with
`execution-closure-only`, `effectExecutable:false` and `proofAuthority:none`.
Historical18 trace retains that distinct failure without advancing its tuple or
allowing a successor. Source review alone does not authorize a live failed-after
or any further attempt.

For either failure type, a17 handoff may reference both unchanged successful
envelopes, for example `{finish, executionClosure:
closure.evidence}`. Supply exact original-path/digest historical runtime captures
when needed.17 must build **and verify** the copied original request, result,
publication, marker, controller and closure evidence. Neither that immutable
bundle integrity nor the closure certificate grants proof/currentness authority.
