# External Rust Modeling Contract

<purpose>
Use this contract only for `/fvs:model-external`. It does not authorize ordinary extraction repair,
FC proof work, or crypto formalisation to edit external models.
</purpose>

## Source authority

Every modeled closure member must have one resolver record from
`scripts/fvs-model-external.mjs resolve`:

- Cargo registry: one exact `Cargo.lock` package/version/source/checksum and a matching local Cargo
  registry source.
- Cargo git: one exact `Cargo.lock` git source ending in a full commit and a matching local checkout
  at that commit.
- Vendor: the configured Cargo vendor directory, package identity, `.cargo-checksum.json`, and no
  disagreement with an available Cargo cache copy.
- Rust standard library: the active `rustc --print sysroot`, an inspectable `rustc -vV` commit hash,
  and source under that pinned sysroot.

Each record includes the canonical file, inclusive line range, full-file SHA-256, range SHA-256, and
immutable version/commit. Missing, ambiguous, escaped, generated-only, macro-only, or disagreeing
source is `BLOCKED`. Web pages and remembered implementations are not source authority.

## Semantic stop classes

All safe deterministic Rust is eligible for an attempted model. The following stop before adoption:

- any `unsafe` function/body/dependency;
- raw-pointer or FFI semantics;
- IO or environment observation;
- time, randomness, concurrency, atomics, or scheduling;
- target/platform/ABI behavior or optimizer intrinsics;
- panic, overflow, allocation, or nondeterminism whose abstraction changes observable behavior.

Unsafe Rust is `BLOCKED`. A safe but effectful/nondeterministic/platform abstraction requires an
explicit `HUMAN_RULING` that records the exact source range, alternatives, chosen abstraction, and
trust consequence. The ruling applies to one run and is never persisted as a global default.

## Writable surface

Generated `Funs.lean`, `Types.lean`, and generated templates are immutable in every mode. A legacy
generated `FunsExternal.lean` is also immutable; stop and migrate to generated-template plus
hand-written external layering.

The confirmed manifest may name only hand-written model, representation-map,
contract/specification, bridge, correctness, `_toModel`, or `FunsExternal.lean` files. Project
markers do not grant authority. One command owns one root stub plus the minimal external-stub
closure required for it; unrelated stubs are out of scope.

## Candidate transaction

Before any candidate write, `begin` stores:

- source resolver records and copied source evidence;
- root stub and bounded closure;
- exact target list;
- target existence and SHA-256;
- byte-identical target baselines.

`restore` creates `candidate.patch` before restoring existing targets and deleting newly-created
ones, then verifies all baseline hashes. Evidence is append-only. Never delete a failed run.

`finalize` accepts only separately approved model/specification evidence, proof PASS, build PASS,
trust CLEAN, no sorry/new axiom/uninspectable dependency, and a recorded allow ruling plus
justification for every pre-existing custom axiom.

## Independent review modes

Both modes use immutable packets, fresh read-only reviewers, exact runtime/model/effort evidence,
and at most three rounds. Prefer an authenticated opposite provider. Same-runtime or manually
external review follows `review-policy.md` and must not claim stronger independence.

### Model mode

The packet contains complete authoritative Rust ranges and resolver hashes, the full bounded closure,
all candidate Lean model files and hashes, representation maps/imports, and every human ruling.
The reviewer checks:

- branch/result/error correspondence;
- integer widths, casts, overflow and panic behavior;
- recursion/termination and dependency-model fidelity;
- omitted unsafe/effect/platform/nondeterministic behavior;
- preservation of `@[rust_fun]` identity and source coverage;
- whether any abstraction or trust assumption is hidden.

A green build is not model-fidelity evidence. `PASS` binds exact model hashes. Any later model edit
invalidates approval.

### Specification mode

The packet contains the approved model receipt/hashes, complete theorem statements and tags,
authoritative source contract evidence, representation maps, and rulings. The reviewer checks:

- the theorem states the intended contract over the approved model;
- every relevant success/error outcome is covered;
- preconditions and postconditions are neither silently strengthened nor weakened;
- conversion and representation relations are explicit;
- the bounded closure is sufficient and no unrelated claim is added.

Proof success is not specification-fidelity evidence. `PASS` binds the reviewed theorem surface. Any
later theorem-surface edit invalidates specification approval; a model edit invalidates both gates.
Proof-body edits alone do not alter the approved theorem surface.

## Review response format

Model review begins with `# FVS External Model Review`; specification review begins with
`# FVS External Specification Review`. Each contains these ordered sections:

1. `## Findings`
2. `## Source coverage`
3. `## Evidence`

Findings use `### F-N — BLOCKER|MAJOR|MINOR`, then `Class: CONTENT|PROCESS`, `Claim:`, `Evidence:`,
and `Minimal suggested edit:`. End with exactly one final line:

`VERDICT: PASS | REVISE | BLOCKED`

`PASS` contradicts BLOCKER/MAJOR findings. `REVISE` requires at least one finding. `BLOCKED` stops
and restores unless the user supplies the exact missing source/ruling through a new confirmed run.

## Completion

After both reviews, close every proof, run the guarded build, and invoke `/fvs:trust-audit` over the
root dependency closure. Success introduces no `sorry`, `admit`, custom axiom, unsafe shortcut, or
uninspectable dependency. Standard Lean classical axioms retain their existing treatment.
