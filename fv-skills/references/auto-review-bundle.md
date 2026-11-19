# Local verification review bundle

For v2 review-bundle requests and consumers, read `auto-execution.md` first. It defines the explicit execution policy, optional memory and current lifecycle. The version1 field tables and finite bounds below describe retained legacy records; apply them only to v1.

## V2 bundle operations

Use `schemaVersion:2` with the same complete source/agreement/scope inventory, replacing
`deadlineMs` by the original run's `execution` control. `buildReviewBundle(request,out)` is awaited
for v2. Verification uses `{manifest,expectedContext,version:2,execution,out}`; immutable snapshot
reading uses `{manifest,version:2,execution}`. Keep the caller's independent expected context.
An integrity-only v2 inspection may read retained v1 bytes; fresh-currentness consumers use their
matching wrapper version. It does not migrate or renew the original run.

A completed v2 manifest retains an exact `publication` reference whose immutable content identity
binds the complete manifest body. A staged manifest or failed/cancelled output cannot supply that
completion. Downstream bundles traverse and copy the publication bytes as ordinary required evidence.
Preserve historical runtime versions using the existing explicit `historicalCaptures` mapping:
original path+SHA, exact non-executable archive+sameSHA, and original mode. Capture current bytes
before a later checkpoint changes the live path. Prior bundles already retain their historical copies.
Current canonical inputs are never replaced by that mapping. All scope/completeness/alias/byte limits
and independent checker currentness checks below remain in force.


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
| `extraction`, `graph`, `plan` | Exact extraction-identity and bound graph/plan refs |
| `scopeInventory` | Required versioned correspondence inventory ref below |
| `registry` | `{root,expectedHeadSha256}`; null head explicitly means no committed head |
| `baseline` |15 frozen expectation ref or null |
| `acceptedStore` | `{root,expectedHeadSha256}` or null |
| `runtime` | `{root:projectRoot,state:ref-or-null,absenceReason:null-or-text}` or null; a promised committed snapshot must exist |
| `handoff` | Optional retained reference handoff ref; it is non-executable and not full scope authority |
| `absenceReasons` | `{baseline,acceptedStore,runtime,handoff}`; each is text when its corresponding input is null, otherwise null |
| `deadlineMs` | Future absolute read-only inspection deadline, at most600s; does not reset the factory run clock |

Prepare agreement identity from the current `readState({projectRoot,requireAgreement:true})` result,
not old ready/status text. Preserve the exact existing source, original Rust/extraction identity,
frozen context, policy/toolchain, registry and store versions. Source/proof-fixture and extraction
commits can be distinct; retain their recorded correspondence rather than conflating them.

`scopeInventory` has the closed fields `schema:"fvs/auto-bundle-scope-inventory"`, `schemaVersion:1`,
`agreement` (the same bound agreement object), `plan` (the same ref), `requestedRoots`, `failed`, and
`applicability`. The two ID arrays exactly match the closure selection; failed helper IDs need not be roots.
Each applicability entry is `{scopeItemId,roots,disposition,reason,evidence}`: a unique stable item ID,
sorted root IDs from the selection, `mapped|unmapped|omitted`, null reason for a nonempty mapped set
or an explicit reason for an empty unmapped/omitted set, and nonempty local source-evidence refs.
Every requested root must be mapped. This records the workflow's scope correspondence; it is not
a natural-language classifier or a new human approval. Missing/conflicting inventory is refusal.

## Pending and diagnostic facts

Inadmissible closure inputs retain requested/failed IDs, raw roots/nodes/blockers and unknown null closure,
owners and dependencies. A missing validated union is never an empty successful union. Ownership
from a valid closure plan is bookkeeping, not live actor ownership.

Strict pending registry and resume results remain pending. Only a stable lock-only committed prefix can use the
existing original-path `ignoreLock` historical reader. Temporary records still prevent validation;
raw committed bytes are labelled unvalidated. Missing spending/reservations stay unknown, with
agreed limits shown separately. Corrupt required committed evidence refuses a valid manifest.
The collector clears no marker and copies no registry into a substitute execution context.

`readAcceptedStore` gives historical chain/bound-evidence validation. Frozen-artifact validation
is expectations-only. Only the checker's full fresh current inspector establishes present accepted proof
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
creating output or attempting live currentness; the re-spec helper uses it before its separate current-context guards.

Committed registry and checker inventories are linked from captured bytes, sequence and predecessor hashes to the
request's exact expected heads; saved record lists cannot omit a head or middle event. This is
inventory integrity, not a second proof checker. Raw temporary-state inventories retain their
weaker validation label. Source versions and views are derived from anchored records and the fixed
reached-source copy policy, rather than trusting matching saved lists.

The finite identity policy includes checker kernel-attempt inputs/runtimes/snapshots and pristine-context
dependency maps. Kernel-attempt version1 records retain their producer input-map order
(request, Lean, Node, runner, helper, compiled/runtime inputs); an unsupported layout refuses.
The request and bounded source/code/context evidence are required copies; compiled and tool bodies
are indexed. Known request/check metadata recurses by semantic position even without a JSON suffix.
Removing a required request or compiled identity from its index fails integrity.

Fresh currentness is evaluated independently against actual original paths and existing checker readers,
and is returned outside the bundle as current/stale/pending/unverified. Original-only indexed
compiled/import/dependency bodies may be unavailable while their retained index stays intact;
index integrity never proves availability or current acceptance. A matching stored tuple, accepted
history or valid rendered artifact alone never supplies current proof or human approval.

Human review remains pending. Partial scope/proof results retain every unfinished node/reason,
original limits and uncertainty. A complete artifact is not complete proof coverage, human re-specification,
actual stock-AO execution, a target-project proof promotion, a PR mutation or a completed pilot.

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
snapshot. Nested old versions remain distinct path/digest identities. Re-spec callers
retain each inspect-time runtime body before later checkpoints, and may reuse
exact already-captured bodies from a prior bundle. Missing historical bytes
refuse rather than changing an old reference or substituting current contents.

The exact original inspect pair `6593d0f4` / `340a0278` also derives two versioned
`fvs/auto-bundle-historical-code` mappings to digest-pinned, non-executable source
data. Original paths/digests, raw inspect/request/publication/frame and current
executable identities all remain separate required copies. Captured-only
verification rederives this finite mapping from the retained inspect; a mapping
or archive cannot be dropped or changed coherently to evade required traversal.

## Pull request trust section

The same script writes the trust section of a proof pull request body from the run records. It is
text for people. It reads only, writes nothing, never calls GitHub and carries no proof, acceptance
or dispatch authority. It does not use the bundle formats above.

```text
node <installed-scripts>/fvs-auto-bundle.mjs trust --project-root DIR --commit SHA [--notes FILE] [--format markdown|json]
```

Run it after the build check has written its receipt for `SHA`, and paste the markdown into the body
unchanged. Do not write the trust text by hand: the counts and labels in a hand-written section have
been wrong. An exit status other than 0 means no section was written; the refusal is JSON with a
`code`. A refusal is not a warning to paste around.

Inputs, all under `.formalising/auto-fv/`:

| Record | What the section takes from it |
|---|---|
| `build-check/SHA.json` | The commit, the verdict label and each statement's `#print axioms` list. The receipt must be the one for exactly `SHA`. A statement that was not built adds nothing to the counts and is named. |
| `externals.json` | Every boundary record with its kind, status and decision. A missing file is refused when a statement rests on an axiom beyond Lean's three. |
| `specs.json` | The current review verdict per spec file, whether the file changed since the review, and the recorded proof pull request head. |

The section holds:

- the commit, the verdict label and the recorded proof pull request head. The section never reads
  the published head: it says so, so compare the three (accepted, recorded, published) yourself;
- counts that come from one pass over the records: statements built, records by status, and the
  distinct axioms split into Lean's standard three, axioms an externals record names and axioms no
  record names;
- a reviews table with each spec file's verdict, and beside it the open owner questions and the
  changes to the reviewer's brief. A statement of what a pass means sits above it: the statement
  was reviewed and approved, which is not a proof and not acceptance;
- a records table with each record's layer, status and decision and the number of statements whose
  axiom list it is in;
- the axioms no record names, listed in full, and a per-statement table.

How the join works. A record's model symbol is matched against each axiom name. It may hold several
Lean names, a `*` glob, a brace group such as `impl_hacl.{Sha256, Sha384}` and remarks in
parentheses. A receipt axiom name has no Lean project root segment, so a symbol also matches with
its first segment removed. An axiom that no record matches stays in the "no record names" list. That
list is expected to hold hand-written axioms, because the registry records the boundary they
describe, not each axiom. The section never says that a proof does not use an axiom: an axiom list
shows what a statement can reach through the extracted code, not what its proof uses.

Layers come from the record's kind and, for an external function, from the crate its source symbol
names. They never come from the record's id:

| Layer in the section | Record |
|---|---|
| accepted translation patch | kind `semantic-patch` |
| hand-written model | kind `handwritten-model` |
| project function left opaque | kind `opaque` |
| standard-library function without a model | kind `external`, source crate `core`, `alloc` or `std` |
| dependency crate assumed correct | kind `external`, any other source crate |

A project's agreement may call some layers by its own labels (for example A1 for the translation
and A2 for assumed-correct dependency crates). The section uses the plain names above. The
translation (Aeneas, Charon and the Lean backend) is trusted by every statement and is stated once.
A patch changes generated code and is not an axiom, so the records table shows no per-statement link
for it. An open or blocked record is shown next to every spec file whose statements reach it.

For the spec pull request, `rulings` prints the claims that need a ruling before any proof starts:

```text
node <installed-scripts>/fvs-auto-bundle.mjs rulings --project-root DIR [--notes FILE] [--format markdown|json]
```

It needs only `externals.json`. Each open record is listed with its layer, the behaviour it
assumes, why it has no model, the claims the caller names for it and the owner's four choices (accept
it as a named assumption, have it modelled, narrow the claim, block it). A record with no claim named
reads `NOT STATED`. The list is as complete as the records are: a function that no record names is
not in it, so the reviewers confirm that each external function a statement reaches has a record
before the pull request opens. The list records no ruling. After the owner rules, the orchestrator
records the decision with `record-externals`.

The notes file holds what no run record does. The reviewers' briefs and the owner's questions live
in the orchestrator's conversation, so the orchestrator states them:

```json
{
  "schema": "fvs/auto-pr-notes",
  "schemaVersion": 1,
  "reviews": {
    "formal/specs/Specs/Hmac.lean": {
      "ownerQuestions": ["Should a cumulative-limit overflow panic or return an error?"],
      "briefChanges": ["Round 2: the reviewer was told not to fail the file for the open question above."]
    }
  },
  "claims": { "record-id": ["the exact claim in plain words"] }
}
```

An empty list is the caller's statement that there is none. A spec file with no entry reads
`NOT STATED` and its pass is shown as `PASS, qualifications NOT STATED`, never as a plain `PASS`.
Every pass the brief changed, and every pass an open question qualifies, shows as
`PASS, qualified`. A notes file that names a spec file with no recorded review, or a record that
`externals.json` does not hold, is refused. The `claims` entries are used by the ruling list, not by
the trust section, and the `reviews` entries are used by the trust section, not by the ruling list.
