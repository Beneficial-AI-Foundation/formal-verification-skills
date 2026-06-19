# Aeneas Extraction Blocker Catalog (REF-09)

<overview>
This catalog is the classifier's lookup store: the data a classifier subagent
matches a stripped failure signature against, and the data the applier executes a
recipe from. It is a **first-class shipped artifact** -- a seed of general
Aeneas/Charon facts ships with the bundle (any project hitting the same construct
hits the same blocker), and each project grows its own local entries on top. The
bisection sub-agent writes new entries with `status: candidate`; a human promotes
a candidate to `workaround` / `upstream-filed` / `needs-manual-check` after
reviewing both the fix and (for a meaning-bearing change) its equivalence
argument.

## Schema

Every entry is a YAML mapping with this field set. The first three fields are the
**match key**; the rest drive the fix and its safety handling. Field semantics
(`category`, `outcome_kinds`, `coverage_impact`) are the extraction safety model
-- see the safety-model reference (REF-08) for the A/B test, the coverage guard,
and the toolchain-remediation outcome.

```yaml
id:              <stable descriptive slug, e.g. DYN-TRAIT>
layer:           charon | aeneas | split | tweaks | lean | env | project
signature:       <the Aeneas-FACING condition, project names stripped -- the match key>
trigger:         <the Rust or config construct that causes it>
category:        A | B
recipe:          <the fix recipe, OR "diagnose+gate">
coverage_impact: none | shrinks-coverage-if-target
outcome_kinds:   [auto | gate | toolchain-remediation]   # a LIST; selection is pin-dependent
evidence:        <MANDATORY -- a doc path | issue/PR number | commit | test .out>
pin_context:     <the charon-pin / aeneas rev the blocker or fix was observed against>
status:          known-stable | workaround | candidate | needs-manual-check | upstream-filed | retired
provenance:      <where first observed>
```

**Delta from the original draft schema:** ADDED `evidence`, `pin_context`, and
`outcome_kinds`; REMOVED the explicit `tier` field and the `risk` field. There is
no `tier`: a change's handling is carried by `category` + `coverage_impact` +
`recipe`, and the gate packet's obligation field carries what the old tier label
used to convey.

## Evidence and pin discipline (structural, not advisory)

- **No entry without `evidence`.** Every entry cites a real doc path, issue/PR
  number, commit, or test output. An entry with an empty `evidence` field is
  malformed. A classifier that cannot match a failure returns **NOVEL** -- never a
  forced match to the nearest-looking entry, and never a fabricated issue number
  to make an entry look filed.
- **Confidence is explicit via `status`.** A bisection-proposed fix is `candidate`
  until a human reviews it; a pin-dependent claim is `needs-manual-check` until
  the pin is diffed against the fix. Agents never steer on a guess.
- **"Fixed in upstream main" is NOT "fixed for us."** A blocker fixed in an
  upstream branch *later* than the resolved pin is still live for a project on that
  pin. Such an entry ships `needs-manual-check` with a `pin_context` recording the
  observed revision -- **never `retired`**. Only reconciling the entry against the
  resolved pin (confirming the pin carries the fix) may retire it.
</overview>

<provenance>
## Seed pin snapshot

The seed entries below were observed against these revisions. The pin discipline
above is anchored on this snapshot: an entry's `pin_context` is read relative to
it.

```yaml
charon_main:      e9b10cc3
aeneas_main:      8dd8bfb3
aeneas_charon_pin: 6f058254   # what Aeneas's charon-pin resolves to (the extractor's pin)
```

The resolved `charon-pin` (`6f058254`) is **older** than the Charon vtable /
lifetime-struct fixes that landed on `charon_main`. So for a project on this pin,
the DYN-TRAIT and LIFETIME-STRUCT entries are NOT known-fixed -- they ship
`needs-manual-check`, with `toolchain-remediation` (a pin bump) as the alternative
to the local workaround. Re-resolve the pin and reconcile before retiring either.
</provenance>

<seed>
The seed entries are one YAML list below. The first seven are tooling-defect
blockers surfaced by the libsignal PQXDH extraction (Aeneas / Charon defects). The
last four are classes surfaced by the curve25519-dalek extraction diff: that diff
carries no Aeneas/Charon pin header (only the dalek upstream tag), so their pin
context cannot be confirmed against the seed snapshot -- they ship
`needs-manual-check` until reconciled. The dalek crate uses a different cfg name
(`verify`) and a different attribute namespace (`aeneas::*`) than the libsignal
entries; their signatures are stated Aeneas-facing so they match across both.

- id: DYN-TRAIT
  layer: charon
  signature: "Dynamic trait types are not supported yet"
  trigger: "a &dyn Trait / Box<dyn Trait> param, field, or return; vtable dispatch"
  category: A
  recipe: "exclude the trait + its blanket impl at the source level, then monomorphize dispatch sites to a match-on-enum tag (the concrete impls stay verified)"
  coverage_impact: none
  outcome_kinds: [auto, toolchain-remediation]
  evidence: "libsignal kem.rs (M05 exclude + M07 match-on-enum + M08 cfg-gate variant); charon#856 (open: support dyn Trait with --monomorphize) carries the use case"
  pin_context: "observed unfixed at charon-pin 6f058254; addressed on charon main e9b10cc3 (TyKind::DynTrait + vtables); narrow limits remain (multi-method-predicate dyn; assoc-type-bearing traits skip vtable)"
  status: needs-manual-check
  provenance: "libsignal-lite-verify PQXDH extraction (KEM parameter vtable)"

- id: LIFETIME-STRUCT
  layer: charon
  signature: "get_adt_field_types failure on a lifetime-parameterized ADT (PureTypeCheck)"
  trigger: "a struct with a type-level lifetime parameter in a field type (even a PhantomData lifetime) reaching field-type resolution"
  category: B
  recipe: "diagnose+gate -- drop the lifetime by owning the borrowed data; the equivalence to argue is owned-view === borrowed-view on observable behaviour"
  coverage_impact: none
  outcome_kinds: [gate, toolchain-remediation]
  evidence: "libsignal recipient params + ciphertext owned their data (M04 own-the-data + M06 rewrite; equivalence argued in src-assumptions A02); aeneas#75 (closed: add support for ADTs with lifetimes) -- so this is a regression or uncovered case; aeneas#1102 (open) is the same exception class at a different site"
  pin_context: "observed unfixed at charon-pin 6f058254; only genuinely-invalid Rust fails on charon main e9b10cc3"
  status: needs-manual-check
  provenance: "libsignal-lite-verify PQXDH extraction (recipient parameters)"

- id: GAT
  layer: charon
  signature: "cannot extract trait associated types with parameters -- fails under --preset=aeneas (implies --lift-associated-types)"
  trigger: "a trait associated type that takes generic or lifetime parameters (a GAT); extracts fine plain, hard-errors once associated types are lifted"
  category: A
  recipe: "exclude the trait at the source level if it is thin glue over the free functions that are the real targets; else verify the trait via the coverage ladder"
  coverage_impact: none
  outcome_kinds: [auto]
  evidence: "libsignal handshake trait (M02 charon::exclude); charon#477 (closed: Charon-side GAT support landed) -- the residual gap is Aeneas-side under --lift-associated-types; aeneas#396 (open) is the related docs gap"
  pin_context: "observed under --preset=aeneas at charon-pin 6f058254; signature is the Aeneas-facing condition, not the raw Rust GAT"
  status: workaround
  provenance: "libsignal-lite-verify PQXDH extraction (handshake trait)"

- id: NO-BOTTOMS
  layer: aeneas
  signature: "There should be no bottoms in the value"
  trigger: "an early-return Err whose variant carries a &'static str literal payload; the symbolic interpreter mis-tracks the projection"
  category: B
  recipe: "diagnose+gate -- bisect to the minimal trigger, then propose the smallest semantics-preserving error-variant rewrite and route it through the equivalence gate"
  coverage_impact: shrinks-coverage-if-target
  outcome_kinds: [gate]
  evidence: "live [%cassert] in the Aeneas interpreter (Interp.ml around line 550 / InterpExpressions.ml) -- UNDOCUMENTED upstream, OCaml-only; this catalog entry is the sole record. aeneas#392 (open: improve error message about bottoms) is the diagnostics side; aeneas#838 (open: failure on a function operating on strings) may share the root cause -- read before filing. Minimal failing example: early-return Err(&'static str). Applied rewrite recorded in src-modifications M10 / src-assumptions A05"
  pin_context: "live and unchanged at aeneas charon-pin 6f058254 and aeneas main 8dd8bfb3"
  status: workaround
  provenance: "libsignal-lite-verify PQXDH extraction (recipient entry function pqxdh_accept)"

- id: PREPASS-EXCLUDED
  layer: charon
  signature: "a pre-pass re-surfaces an already-excluded construct by descending into its impl"
  trigger: "a charon pre-pass descends into an impl of a trait that was excluded, re-surfacing the excluded construct"
  category: A
  recipe: "exclude the trait AND its impls, at the source level (charon::exclude at MIR-emission time, NOT just the CLI --exclude which runs too late to stop the pre-pass)"
  coverage_impact: none
  outcome_kinds: [auto]
  evidence: "libsignal impl of an excluded trait (M03 charon::exclude on the impl); upstreamable-issues Kit 5 (AENEAS-004 + CHARON-003, combined filing) documents the pre-pass-on-impls hygiene bug; charon docs what_charon_translates.md describes the four opacity levels and the source-vs-CLI distinction"
  pin_context: "observed at charon-pin 6f058254; CLI --exclude maps to Invisible but runs after MIR emission, so source-level exclusion is required"
  status: workaround
  provenance: "libsignal-lite-verify PQXDH extraction (impl of an excluded trait)"

- id: CODEGEN-ARITY
  layer: lean
  signature: "expected a product type, got an N+1 tuple where the def emits an N-tuple"
  trigger: "a def emits an N-tuple but a call site reached through a &mut R DerefMut blanket emits an (N+1)-tuple destructure (a phantom back-continuation slot)"
  category: A
  recipe: "tweaks-substitution -- drop the phantom element at the call site; GUARDED: the substitution must match at least once on the next run (a 0-match is pattern drift and a HARD failure), correspond to this codegen-defect entry, and be reversible to a no-op once the upstream defect is fixed"
  coverage_impact: none
  outcome_kinds: [auto, toolchain-remediation]
  evidence: "libsignal KEM encapsulate via a CryptoRng DerefMut blanket; recorded in src-assumptions A-012; upstreamable-issues Kit 2 (AENEAS-012) -- appears NOVEL upstream (no DerefMut/arity/trait-object hits), to be filed as a new Aeneas issue"
  pin_context: "observed at aeneas charon-pin 6f058254; substitution is FRAGILE -- keyed to emitted variable names, so the 0-match guard is load-bearing"
  status: needs-manual-check
  provenance: "libsignal-lite-verify PQXDH extraction (KEM encapsulate)"

- id: DUP-PARENT-CLAUSE
  layer: lean
  signature: "Field has already been declared (duplicate parent-clause field in trait codegen)"
  trigger: "trait codegen emits a parent-clause field name twice when two supertraits are the same trait (e.g. two Copy parent clauses)"
  category: A
  recipe: "tweaks-substitution -- rename the second occurrence and its assignment sites; GUARDED (at least one match required, reversible to a no-op once fixed upstream)"
  coverage_impact: none
  outcome_kinds: [auto, toolchain-remediation]
  evidence: "libsignal NonZero inner Copy parent clauses; recorded in src-assumptions A-011; aeneas#1051 (open: ZeroablePrimitive duplicate parentClauses name when two supertraits are the same trait) -- comment with the workaround, do NOT file a duplicate"
  pin_context: "observed at aeneas charon-pin 6f058254; targeted upstream fix tracked in aeneas#1051"
  status: needs-manual-check
  provenance: "libsignal-lite-verify PQXDH extraction (NonZero parent clauses)"

- id: ITER-ADAPTER
  layer: charon
  signature: "cannot extract the Iterator trait machinery for a chained adapter (rev / zip / skip / iter_mut)"
  trigger: "a loop or expression built from iterator adapters (rev, zip, skip, iter_mut) whose trait machinery Charon/Aeneas cannot extract"
  category: B
  recipe: "diagnose+gate -- inline the adapter chain as an explicit while loop; the equivalence to argue is iterator-form === while-form on observable behaviour"
  coverage_impact: none
  outcome_kinds: [gate]
  evidence: "curve25519-dalek src-modifications.diff: montgomery.rs Mul (rev/skip inlined to while, with an in-source comment naming the cause), scalar.rs batch_invert, read_le_u64_into; the diff annotates the rewrites as Charon/Aeneas iterator-trait limitations"
  pin_context: "dalek diff carries no Aeneas/Charon pin header (dalek upstream tag only); pin-stability unconfirmed -- reconcile before relying on it"
  status: needs-manual-check
  provenance: "curve25519-dalek-lean-verify extraction"

- id: USIZE-MATCH-ARM
  layer: aeneas
  signature: "dependent elimination fails on a usize match with range arms (Usize match-arm lowering)"
  trigger: "a match on a usize value using range arms (e.g. 4..=7, then 8) that fails Lean's dependent elimination for Usize"
  category: B
  recipe: "diagnose+gate -- rewrite the usize match to if/else; the equivalence to argue is if-else-form === match-form on observable behaviour"
  coverage_impact: none
  outcome_kinds: [gate]
  evidence: "curve25519-dalek src-modifications.diff: scalar.rs to_radix_2w / to_radix_2w_size_hint rewritten match to if/else; references a FIXME in the Aeneas Lean backend Notations.lean (Std/Scalar/Notations.lean) for Usize match lowering"
  pin_context: "dalek diff carries no Aeneas/Charon pin header; pin-stability unconfirmed -- reconcile before relying on it"
  status: needs-manual-check
  provenance: "curve25519-dalek-lean-verify extraction"

- id: COND-NEGATE-HIERARCHY
  layer: charon
  signature: "MIR analysis defeated by a subtle ConditionallyNegatable trait hierarchy (Copy + Neg)"
  trigger: "a call to conditional_negate (via subtle::ConditionallyNegatable, whose bound resolves to Copy + Neg) whose trait hierarchy defeats MIR analysis"
  category: B
  recipe: "diagnose+gate -- replace conditional_negate(flag) with conditional_assign(neg, flag); the equivalence to argue is the rewritten negate-then-conditionally-assign === the original conditional negate"
  coverage_impact: none
  outcome_kinds: [gate]
  evidence: "curve25519-dalek src-modifications.diff: window.rs, edwards.rs, field.rs, ristretto.rs conditional_negate to conditional_assign; maps to upstreamable-issues CHARON-001 (HKDF/SHA-2 closures, trait-hierarchy class, marked do-not-file / known research-grade limitation)"
  pin_context: "dalek diff carries no Aeneas/Charon pin header; CHARON-001 is a known limitation, not a pending fix"
  status: needs-manual-check
  provenance: "curve25519-dalek-lean-verify extraction"

- id: VERIFY-CFG-GATE
  layer: project
  signature: "alloc / Vec-using code reaches the extraction scope and must be gated out"
  trigger: "alloc-dependent or batch functions (Vec-using) that should be kept out of the extraction feature"
  category: A
  recipe: "cfg-gate the function out of extraction (cfg not verify); production untouched, so this is A-mechanical -- record the gated-out item as an assumption"
  coverage_impact: none
  outcome_kinds: [auto]
  evidence: "curve25519-dalek src-modifications.diff: cfg(not(verify)) on to_montgomery_batch, mul_bits_be, batch alloc functions across files; the dalek crate uses cfg name verify (vs libsignal extraction) -- signature stated cfg-name-agnostic"
  pin_context: "dalek diff carries no Aeneas/Charon pin header; mechanical (cfg-gated, production byte-identical) so pin-independent"
  status: workaround
  provenance: "curve25519-dalek-lean-verify extraction"
</seed>

<quick_reference>

| id | layer | category | status |
|---|---|---|---|
| DYN-TRAIT | charon | A | needs-manual-check |
| LIFETIME-STRUCT | charon | B | needs-manual-check |
| GAT | charon | A | workaround |
| NO-BOTTOMS | aeneas | B | workaround |
| PREPASS-EXCLUDED | charon | A | workaround |
| CODEGEN-ARITY | lean | A | needs-manual-check |
| DUP-PARENT-CLAUSE | lean | A | needs-manual-check |
| ITER-ADAPTER | charon | B | needs-manual-check |
| USIZE-MATCH-ARM | aeneas | B | needs-manual-check |
| COND-NEGATE-HIERARCHY | charon | B | needs-manual-check |
| VERIFY-CFG-GATE | project | A | needs-manual-check |

**How the catalog is used:** the classifier matches a stripped `signature`
against this set (a hit returns the `id`, a miss returns NOVEL); the orchestrator
reads `category` / `coverage_impact` / `outcome_kinds` against the project's
coverage policy to pick a route (A -> applier, B -> gate, pin-dependent ->
toolchain-remediation); the applier executes `recipe` for A-entries; bisection
writes new `candidate` entries a human later promotes. An entry whose
`outcome_kinds` lists `toolchain-remediation` selects that outcome when bumping
the pin to a revision carrying the upstream fix is the better move than the local
workaround -- a pin-dependent choice, never made automatically while the entry is
`needs-manual-check`.

</quick_reference>
