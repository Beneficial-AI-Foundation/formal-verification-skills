# Local verification review bundle

<overview>

Use the installed `fvs-auto-bundle.mjs` script to collect an immutable local contract/recall/evidence
artifact. It creates no proof, dispatch or publication authority. It runs no provider, compiler,
bootstrap or memory update. The original initial roadmap agreement remains the human setup gate;
human review of this artifact is pending until an actual later response.

</overview>

```text
node <installed-scripts>/fvs-auto-bundle.mjs build --request REQUEST.json --out NEW_BUNDLE
node <installed-scripts>/fvs-auto-bundle.mjs verify --request VERIFY.json --out NEW_INSPECTION
```

Both outputs must be new canonical directories outside source, generated libraries, registry,
runtime, memory, checker evidence and the bundle being verified. Preserve diagnostic staging after
failure; only `manifest.json` publication establishes a complete artifact. Never overwrite a prior
bundle or rewrite nested checker paths to make copied evidence look like a new execution.

## Build request

The closed `fvs/auto-bundle-request` version1 object has these fields:

| Field | Bound value |
|---|---|
| `schema`, `schemaVersion`, `bundleId` | `fvs/auto-bundle-request`,1, caller-created UUIDv4 |
| `projectRoot` | Existing canonical primary project directory |
| `source` | `{kind:"git",root,commit,expectedTree}`; immutable clean source in the same actual Git common directory |
| `agreement` | `{state,roadmap,contextSha256,choicesGeneration,approvedPayloadSha256}`; state/roadmap are exact `{file,sha256}` refs at `.formalising/auto-fv/state.json` and `ROADMAP.md` |
| `extraction`, `graph`, `plan` | Exact extraction-identity and bound13 graph/plan refs |
| `scopeInventory` | Required versioned correspondence inventory ref below |
| `registry` | `{root,expectedHeadSha256}`; null head explicitly means no committed head |
| `baseline` |15 frozen expectation ref or null |
| `acceptedStore` | `{root,expectedHeadSha256}` or null |
| `runtime` | `{root:projectRoot,state:ref-or-null,absenceReason:null-or-text}` or null; a promised committed snapshot must exist |
| `handoff` | Optional retained22 reference handoff ref; it is non-executable and not full scope authority |
| `absenceReasons` | `{baseline,acceptedStore,runtime,handoff}`; each is text when its corresponding input is null, otherwise null |
| `deadlineMs` | Future absolute read-only inspection deadline, at most600s; does not reset the factory run clock |

Prepare agreement identity from the current `readState({projectRoot,requireAgreement:true})` result,
not old ready/status text. Preserve the exact existing source, original Rust/extraction identity,
frozen context, policy/toolchain, registry and store versions. Source/proof-fixture and extraction
commits can be distinct; retain their recorded correspondence rather than conflating them.

`scopeInventory` has the closed fields `schema:"fvs/auto-bundle-scope-inventory"`, `schemaVersion:1`,
`agreement` (the same bound agreement object), `plan` (the same ref), `requestedRoots`, `failed`, and
`applicability`. The two ID arrays exactly match13 selection; failed helper IDs need not be roots.
Each applicability entry is `{scopeItemId,roots,disposition,reason,evidence}`: a unique stable item ID,
sorted root IDs from the selection, `mapped|unmapped|omitted`, null reason for a nonempty mapped set
or an explicit reason for an empty unmapped/omitted set, and nonempty local source-evidence refs.
Every requested root must be mapped. This records the workflow's scope correspondence; it is not
a natural-language classifier or a new human approval. Missing/conflicting inventory is refusal.

## Pending and diagnostic facts

Inadmissible13 inputs retain requested/failed IDs, raw roots/nodes/blockers and unknown null closure,
owners and dependencies. A missing validated union is never an empty successful union. Ownership
from a valid13 plan is bookkeeping, not live actor ownership.

Strict pending14/16 results remain pending. Only a stable lock-only committed prefix can use the
existing original-path `ignoreLock` historical reader. Temporary records still prevent validation;
raw committed bytes are labelled unvalidated. Missing spending/reservations stay unknown, with
agreed limits shown separately. Corrupt required committed evidence refuses a valid manifest.
The collector clears no marker and copies no registry into a substitute execution context.

`readAcceptedStore` gives historical chain/bound-evidence validation. Frozen-artifact validation
is expectations-only. Only15's full fresh current inspector establishes present accepted proof
facts for its exact source/head/helper/contract tuple. Worker reports, provisional review/checks
and standalone audits remain separate. Frozen and registered statements and assumptions are
shown separately when they differ.

## Verify request and interpretation

The verify JSON contains exactly `{manifest,expectedContext,deadlineMs}`; the CLI supplies `out`.
The JS API is `verifyReviewBundle({manifest,expectedContext,deadlineMs,out})`. Use the consumer's own
current context, not a saved bundle verdict. `bundleExpectedContext(freshBuildRequest)` produces
the closed context tuple; it grants no authority and does not refresh the project.

Verification first resolves the immutable content-addressed captured bytes and re-renders the
saved facts, `contract.lean` comments, `recall.md` and per-context/core source copies. This integrity
evaluation uses no live inputs. A historical artifact remains integrity-valid after a real HEAD,
registry or context change. Changed captured bytes, missing required copies or changed views fail.
The JS `readReviewSnapshot({manifest,deadlineMs})` performs this captured-only evaluation without
creating output or attempting live currentness;18 uses it before its separate current-context guards.

Committed14/15 inventories are linked from captured bytes, sequence and predecessor hashes to the
request's exact expected heads; saved record lists cannot omit a head or middle event. This is
inventory integrity, not a second proof checker. Raw temporary-state inventories retain their
weaker validation label. Source versions and views are derived from anchored records and the fixed
reached-source copy policy, rather than trusting matching saved lists.

The finite identity policy includes15 kernel-attempt inputs/runtimes/snapshots and pristine-context
dependency maps. Kernel-attempt version1 records retain their producer input-map order
(request, Lean, Node, runner, helper, compiled/runtime inputs); an unsupported layout refuses.
The request and bounded source/code/context evidence are required copies; compiled and tool bodies
are indexed. Known request/check metadata recurses by semantic position even without a JSON suffix.
Removing a required request or compiled identity from its index fails integrity.

Fresh currentness is evaluated independently against actual original paths and existing15 readers,
and is returned outside the bundle as current/stale/pending/unverified. Original-only indexed
compiled/import/dependency bodies may be unavailable while their retained index stays intact;
index integrity never proves availability or current acceptance. A matching stored tuple, accepted
history or valid rendered artifact alone never supplies current proof or human approval.

Human review remains pending. Partial scope/proof results retain every unfinished node/reason,
original limits and uncertainty. A complete artifact is not complete proof coverage,18 re-specification,
19 actual stock-AO execution, a target-project proof promotion, a PR mutation or a completed pilot.

For a reached historical input whose live path has advanced, version1 accepts an
optional `historicalCaptures` list. Each closed entry is
`{schema:"fvs/auto-bundle-historical-input",schemaVersion:1,original,archive,mode}`:
both refs have the SAME SHA256, `archive` names separately retained non-executable
bytes, and `mode` retains the historical mode metadata. Keep these bytes before
advancing mutable state; absent bytes cannot be replaced by a same-meaning hash.
The list is part of the consumer's exact expected context. Duplicate, chained,
conflicting, unused or unavailable captures refuse. It supplies bytes only to
required-copy traversal and captured integrity, never to live currentness checks.
It cannot replace the current agreement, stage inputs, frozen baseline or runtime
snapshot. Nested old versions remain distinct path/digest identities.18 callers
retain each inspect-time runtime body before later checkpoints, and may reuse
exact already-captured bodies from a prior17 bundle. Missing historical bytes
refuse rather than changing an old reference or substituting current contents.

The exact old18 inspect pair `6593d0f4` / `340a0278` also derives two versioned
`fvs/auto-bundle-historical-code` mappings to digest-pinned, non-executable source
data. Original paths/digests, raw inspect/request/publication/frame and current
executable identities all remain separate required copies. Captured-only
verification rederives this finite mapping from the retained inspect; a mapping
or archive cannot be dropped or changed coherently to evade required traversal.
