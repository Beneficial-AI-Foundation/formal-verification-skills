<purpose>
Model one requested external Rust stub and its bounded external-stub dependency closure as one
reversible, source-grounded operation. Canonical Lean changes survive only when both independent
reviews pass, proofs close, the guarded build is green, and trust audit reports CLEAN.
</purpose>

<process>

## 0. Resolve the installed FVS root

Resolve the current runtime's installed FVS package/plugin root from its runtime header and set
`FVS_ROOT` to that absolute path for every helper invocation below. Verify both
`$FVS_ROOT/scripts/fvs-model-external.mjs` and `$FVS_ROOT/scripts/fvs-model-review.mjs` exist before
continuing. Do not infer the root from the user's project cwd and do not edit the installed package.

## 1. Resolve the requested unit

Require one existing external stub. Discover only other external stubs transitively required to
model that root; this is the bounded external-stub dependency closure. Record the root and every
closure edge. Do not include unrelated project stubs, convenient neighbours, or ordinary extracted
functions.

Inspect the real project layout before choosing targets:

- `Funs.lean`, `Types.lean`, and generated templates are immutable.
- A hand-written `FunsExternal.lean` or exact plan-named hand-written model, representation-map,
  contract/specification, bridge, correctness, or `_toModel` file may be a candidate target.
- If `FunsExternal.lean` is generated or legacy-generated, HALT and require migration to generated
  template plus hand-written external layering. Never patch it in place.

## 2. Resolve immutable Rust source

Use `node "$FVS_ROOT/scripts/fvs-model-external.mjs" resolve <request.json>` for each closure member.
Accept only Cargo.lock-resolved registry/git source, configured vendored source, or the pinned rustc
sysroot. Record crate/toolchain identity, immutable version/revision, canonical file, exact inclusive
line range, full-file SHA-256, and range SHA-256.

HALT on missing source, ambiguous package identity, disagreement between locally available
authoritative copies, path escape, generated-only source, macro-only source, or an unpinned rustc
commit. Do not substitute web search, package documentation, remembered semantics, or a guessed
implementation.

Unsafe Rust is `BLOCKED`. Safe Rust involving IO, environment access, concurrency, randomness,
time, platform behaviour, panic/overflow assumptions, FFI, optimizer intrinsics, or another
observable semantic abstraction requires `HUMAN_RULING` before any model is adopted. Record the
ruling and exact abstraction; it never becomes a saved global default.

## 3. Confirm one execution manifest

Resolve runtime/model/effort settings through `model-profiles.md`: work stage for the external
modeler and authority/review settings for both independent reviewers. Prefer a fresh authenticated
opposite-provider reviewer. Same-runtime or external review follows `review-policy.md`; never claim
independence without a fresh read-only child and a validated receipt.

Show and confirm one manifest containing:

- root stub and bounded closure with edges;
- every source provenance/range/hash record;
- exact hand-written model and specification targets;
- executor runtime/model/effort;
- separate model-fidelity and specification reviewer runtime/model/effort;
- guarded build and trust-audit targets;
- unsafe/effect stop conditions and restoration policy.

Notes rebuild the manifest and require reconfirmation. Unsupported noninteractive settings fail
before mutation.

## 4. Begin the candidate transaction

Before the first target write, run
`node "$FVS_ROOT/scripts/fvs-model-external.mjs" begin <request.json>`. The transaction records
pre-write existence and SHA-256 for every exact target and stores byte-identical baselines under
`.formalising/model-external/<run>/`. Refuse an existing run directory or any immutable/generated
target.

From this point until finalization, every `BLOCKED`, `HUMAN_RULING`, cancelled selection, exhausted
review cap, proof/build/trust failure, interruption, or unexpected error must run
`node "$FVS_ROOT/scripts/fvs-model-external.mjs" restore <run-directory>`. Restoration first writes
`candidate.patch`, then restores/deletes targets and verifies every baseline hash. Keep all run
evidence; never delete or overwrite it.

## 5. Produce and review the Lean model

Dispatch `fvs-external-modeler` with the confirmed manifest, complete source records and source
text, exact bounded closure, project style, transaction directory, and mode `model`. It owns the
whole bounded unit but may write only the exact confirmed hand-written targets. It must preserve
`@[rust_fun]` signatures/namespaces and produce transparent, unfoldable definitions without `sorry`,
`axiom`, `partial`, unsafe assumptions, or unrelated cleanup.

Create an immutable model-review packet containing the full Rust ranges and hashes, complete Lean
model files and hashes, closure, abstraction rulings, imports, and prior round evidence. Run
`node "$FVS_ROOT/scripts/fvs-model-review.mjs" run <request.json>` in `model` mode with a fresh
read-only reviewer. The reviewer checks semantic
correspondence, integer/panic behaviour, omitted branches/effects, dependency models, and source
coverage; compilation is not model evidence.

`PASS` approves the exact model hashes. `REVISE` returns findings to the external modeler and creates
a new immutable packet. `BLOCKED` restores and stops. Run at most three model-review rounds. Any
post-approval model edit invalidates model approval and requires a fresh round within the same cap.

## 6. Produce and review the specification

Dispatch the same dedicated executor in mode `specification` with the approved model hashes. Produce
step-tagged specifications for the root and only required closure members, preserving exact project
conventions. No theorem body may retain `sorry` at the completion gate.

Run a separate immutable `specification` review through
`node "$FVS_ROOT/scripts/fvs-model-review.mjs" run <request.json>`. The fresh reviewer
checks that each theorem states the intended external contract over the approved model, covers all
source-relevant outcomes, and does not strengthen/weaken behavior without a recorded ruling. Model
approval is evidence, not a substitute for this gate.

Run at most three specification-review rounds. `BLOCKED` or cap exhaustion restores and stops. Any
post-approval specification edit invalidates specification approval and requires a fresh round.
Specification edits that also change the model invalidate both gates.

## 7. Complete proofs and build

Dispatch `fvs-external-modeler` in mode `proof` for the whole bounded unit. It must close every proof,
using live diagnostics between meaningful edits. `sorry`, `admit`, placeholder axioms, and
`implemented_by` trust shortcuts are forbidden.

Run the authoritative build exactly once after current executor evidence, or use the existing one
guarded fallback only when the project policy permits it. Never run a bare `lake build`; preserve
`set -o pipefail`, `${PIPESTATUS[0]}`, positive-safe-integer `LEAN_NUM_THREADS`, and `nice -n 19`.
A red build restores and stops.

## 8. Audit trust

Run the existing `/fvs:trust-audit` over the root and bounded dependency closure. Success requires
CLEAN with no `sorryAx`, no uninspectable dependency, and no new custom axiom. Standard Lean
classical axioms retain existing treatment. Every pre-existing custom axiom in the closure requires
`HUMAN_RULING` plus a recorded justification before finalization; rejection restores and stops.

## 9. Finalize or restore

Before finalization, verify that current model/spec hashes still equal the separately approved hashes,
proofs are closed, build evidence is green, and trust evidence is CLEAN. Run
`node "$FVS_ROOT/scripts/fvs-model-external.mjs" finalize <run-directory> <result.json>` to seal the
result without rewriting prior evidence.

Return `COMPLETE` only with source records, closure, exact target hashes, both review packets and
receipts, proof/build evidence, trust report, and run directory. Otherwise return `BLOCKED` or
`HUMAN_RULING` only after verified restoration, with the preserved candidate patch and exact resume
command.

</process>
