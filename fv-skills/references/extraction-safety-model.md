# Extraction Source-Change Safety Model (REF-08)

<overview>
When you extract Rust to Lean 4 through Charon and Aeneas, a clean `lake build` proves only
that the generated Lean *typechecks* — it never proves the generated Lean *means* the same
thing as the Rust. There is no independent semantic oracle in the pipeline, and the agent that
proposes a source change to get past a blocker also writes its own justification for that
change. So the build cannot catch a bad call, and the project's own records cannot either: the
proposer grades its own homework. This is the green-build trap.

The safety model exists to inject the one thing the pipeline is missing: an **independent human
judgment at exactly the points where meaning is at stake, and nowhere else**. Those points are
Category B. Everything else is safe by construction and proceeds without a human.

The model has **2 safety categories (A / B)**. **A** has **2 sub-kinds — A-mechanical and
A-opacity**; **B is flat** (no subtiers). There are **3 total outcomes**: **auto** (the outcome
of an A change), **human-gate** (the outcome of a B change), and **toolchain-remediation** (a
third outcome that is not a safety category — it covers an upstream tool defect, not an edit to
the crate you are verifying).

**You are the reader of this file if you are a classifier/applier subagent in the extraction
loop.** It tells you how to decide A vs B, when A escalates to B, which fixes you may apply
alone, when to propose toolchain-remediation, and how to turn a failed run into a routable
signature — without re-deriving any of it.
</overview>

<patterns>

## The safe-by-construction A/B test

A change is **Category A iff its safety follows from the *form* of the change, not from a
judgment about the code's meaning.** Ask only: "does the safety follow from the shape of the
edit alone?" — never "is this edit correct given what the code means?".

Any reasoning of the shape **"this branch is unreachable" / "this error never fires" / "these
two computations are equal"** is a semantic judgment. It disqualifies the change from A. Route
it to **B** (the human gate). When in doubt, it is B: A is the narrow, provable-from-form case.

A splits into two sub-kinds: **A-mechanical** (form-only changes that cannot touch meaning) and
**A-opacity** (relocating the trust boundary on a leaf you intend to trust).

## A-mechanical recipes

These touch config, setup, hand-authored files, or the tool's own malformed output — never the
meaning of the verified Rust:

- **`refresh-manifest`** — after a backend/toolchain pin bump, refresh the dependency
  lock/manifest so it resolves the configured pin, re-fetch the backend at that revision,
  confirm the resolved revision equals the pin, rebuild. Pure setup reconciliation; no source,
  no semantics.
- **`namespace-cascade`** — when the generated outer-wrap namespace changes (it is derived
  from the crate name / extraction scope), rename the `open`/`namespace` references in the
  **hand-authored** files (external axiom files, hand-written specs). Never edit generated
  files — they already carry the new wrap.
- **axiom-signature port** — port an axiom signature into the hand-authored external file when
  a signature is now required by an opacity decision.
- **`install-protoc` / build-script gating** — when a crate's `build.rs` runs a protobuf
  compiler that is absent, either install a pinned compiler (environment change, no source
  semantics) or gate the codegen call out of the extraction feature and supply hand-written
  stubs. Either way, what is ultimately trusted is recorded as an assumption.
- **`tweaks-substitution` (GUARDED)** — when the tool emits *generated Lean* that is malformed
  only because of a known codegen defect (a phantom tuple element, a duplicated field name),
  add a text substitution that rewrites the malformed generated text to the shape the backend
  intended. This repairs the tool's output, asserts no property of the user's code.

  **The substitution is Category A ONLY because of mandatory guards. The first guard:** the
  substitution must match **≥ 1** time on the next run. **A 0-match is pattern drift and is a
  HARD failure, never a silent no-op** — it means the codegen changed and the workaround is
  stale, so it must fail loudly rather than silently mis-editing. The substitution must also
  correspond to a catalog entry whose trigger is a *codegen defect* (never an arbitrary edit to
  generated Lean) and be reversible to a no-op once the upstream defect is fixed. A
  substitution that touched user semantics, or that lacked the 0-match guard, would not be A.

## A-opacity recipe

Relocating the trust boundary by axiomatizing or excluding a leaf you intend to trust:

- `#[cfg_attr(feature = "extraction", charon::opaque)]` — keep the body, translate the
  signature only, treat the item as an axiom.
- `#[charon::exclude]` — drop the item entirely (e.g. a trait and its blanket impl).
- fill an `*External*_Template` (`FunsExternal_Template.lean` / `TypesExternal_Template.lean`)
  on a leaf you intend to trust rather than verify.

The production binary is byte-identical (the `#[cfg(not(feature = "extraction"))]` path that
actually ships is untouched); the only effect is what the extraction tool sees, and the
resulting axiom is recorded in `src-assumptions.md`.

**Charon opacity precision — ground the recipe in the four opacity levels.** Charon assigns
every item one of four levels, ordered `Transparent < Foreign < Opaque < Invisible`:

1. **Transparent** — fully translated.
2. **Foreign** — default for items outside the current crate; for types it translates fully if
   the struct has all-public fields or is an enum, otherwise it behaves like Opaque.
3. **Opaque** — only name and signature translated; bodies/fields/variants are not.
4. **Invisible** — nothing translated, no map entry; useful when even the signature errors.

Source annotations and CLI flags both set opacity, and the **more opaque of the two wins** (so
`--include` cannot override `#[charon::opaque]`); annotations can only make an item *more*
opaque, never less.

**Source-level `#[charon::exclude]` vs CLI `--exclude`:**

- **Source-level `#[charon::exclude]`** acts at MIR-emission time. It is the only mechanism
  that stops a PrePass from visiting an excluded trait's impls — a CLI exclusion runs too late
  to prevent the pre-pass from re-surfacing the construct.
- **CLI `--exclude <pattern>`** maps the matched items to **Invisible** (prefix matching).

So **when you exclude a trait, exclude its impls too, at the source level.** Otherwise a
pre-pass can re-surface the excluded construct even though the trait itself is gone. (This is
the pre-pass-on-impls gotcha.)

## Coverage-escalation guard

**A-opacity escalates to B when applied to a function inside required coverage.** Axiomatizing
or excluding a target you are supposed to *verify* silently shrinks the verified deliverable or
changes a target's proof obligation — a meaning-affecting decision. This is driven by the
catalog `coverage_impact` flag (`shrinks-coverage-if-target`): when the offending item is
inside required coverage, do NOT auto-apply the opacity recipe — the body must be made
extractable instead (usually Category-B work) and a human ratifies the obligation change.
Opacity on a leaf you intend to trust stays A; opacity on a coverage target becomes B.

## toolchain-remediation outcome

When the blocker is an **upstream tool defect already fixed past the pinned revision**, the
right move is not an edit to the crate you are verifying — it is **toolchain-remediation**.
Propose either a **pin bump** (advance the pinned Charon to one carrying the fix) OR a
**temporary local patch + a side PR draft** so work continues while the fix lands upstream.

**PR drafts are never auto-opened** — produce the draft and stop; opening it is a human action.

"Fixed in upstream main" is NOT "fixed for us": reconcile every such claim against the *pinned*
revision before retiring a workaround. Until the pin is diffed against the fix, a pin-dependent
entry ships `needs-manual-check`, never `retired`.

## The layer-first classifier procedure

Extraction is a chain of tools, each failing in its own vocabulary. Classify by the **earliest
failing layer** — a downstream symptom must be attributed to its upstream cause. The layers, in
execution order, are `charon → aeneas → split → tweaks → lean`:

| Layer | Phase | Failure looks like |
|---|---|---|
| **charon** | Rust source → LLBC (MIR analysis) | a panic/abort *before* any Lean is produced; a hang or "not supported yet" |
| **aeneas** | LLBC → Lean (symbolic interpretation) | an Aeneas error / internal exception referencing an interpreter phase |
| **split** | partition generated Lean into its layered files | items fail to partition; missing/duplicated declarations |
| **tweaks** | post-extraction text substitutions on generated Lean | a substitution matches **0** times (pattern drift) or over-matches |
| **lean** | `lake build` | a Lean elaboration/typecheck error in generated or hand-authored files |

Procedure (read logs in execution order, stop at the earliest failing layer):

1. Did the tool produce LLBC at all? No → `charon` (capture the panic + the last
   "translating `<path>`" line). Yes → continue.
2. Did Aeneas produce Lean? No → `aeneas` (capture the error + the interpreter phase + the
   function). Yes → continue.
3. Did the item-split complete with no missing/dup declarations? No → `split` (capture the
   offending declaration name). Yes → continue.
4. Did every substitution match ≥ 1 time? No → `tweaks` (capture the zero-match or over-match
   pattern). Yes → continue.
5. Did `lake build` succeed? No → `lean` (capture the first elaboration error + declaration +
   file). Yes → not a failure; proceed to the success oracle.

Two gotchas that corrupt classification: **(a)** a pipe masks the real exit code — a build
piped into a filter reports the *filter's* exit status (0), so read the tool's own exit status
(`set -o pipefail`, capture and check `$?`, or test for the build artifact directly), never the
tail of a piped log; **(b)** a stale dependency manifest hides the real layer — after a pin
bump, an un-refreshed lock can make the build silently use the old backend and produce
kernel-mismatch errors that look like a `lean` defect but are setup drift. Confirm the resolved
backend revision matches the pin before classifying a baffling `lean` error.

</patterns>

## Classifier output schema

Reduce the raw log to a stable signature and emit exactly this:

```
{ layer:    charon | aeneas | split | tweaks | lean,
  symbol:   "<offending user item — fix site, NOT match key>",
  signature:"<stripped, stable diagnostic — the match key>",
  match:    <catalog-id> | NOVEL }
```

- **`symbol`** is the offending user item, kept for the *fix site*, NOT for matching.
- **`signature`** is the stripped, stable diagnostic used as the match key: keep the diagnostic
  string ("Dynamic trait types are not supported yet", "There should be no bottoms in the
  value", "Field has already been declared"), the failing phase/file:line of the *tool* (not of
  the user source), and the *kind* of the offending item (a trait, an enum variant, a closure).
  Strip concrete crate/module/function names, user-source line numbers, and temporary paths —
  they vary per project and must not be part of the match key.

**Aeneas-facing-signature rule.** The signature is the **Aeneas-facing condition**, not the raw
Rust construct. A generic associated type, for example, extracts fine plain but hard-errors
under `--lift-associated-types` (implied by `--preset=aeneas`) — so its signature is
"fails under `--preset=aeneas`", not "GAT". Express the match key in terms of the condition the
tool reports, so it matches across crates that use different cfg names and attribute namespaces.

**NOVEL-on-miss rule.** A classifier miss returns **`NOVEL`**, never a forced match. No catalog
entry exists without evidence (a doc path, an issue/PR number, a commit, or a test output);
confidence is explicit via the entry `status` (`candidate` / `needs-manual-check`); never steer
on a guess or drive a conclusion early. A `NOVEL` result routes to bisection, not to the
nearest-looking recipe.

<quick_reference>

| Outcome | Who decides | Example |
|---|---|---|
| **auto** (A-mechanical) | the applier subagent, alone | refresh a stale manifest; rename the namespace wrap in hand-authored files; a guarded `tweaks-substitution` repairing a known codegen defect |
| **auto** (A-opacity) | the applier subagent, alone — unless the coverage guard fires | `charon::opaque` / `charon::exclude` on a leaf you intend to trust; fill an `*External*_Template` |
| **human-gate** (B) | an independent reviewer ratifies | any meaning-judgment ("these compute the same"); A-opacity applied to a function inside required coverage |
| **toolchain-remediation** | propose a pin bump or local patch + side-PR DRAFT (never auto-open) | an upstream tool defect already fixed past the pinned revision |

**One-line decisions:** form-only → A. Any meaning-judgment → B. Opacity on a coverage target →
B. Upstream defect fixed past the pin → toolchain-remediation. Classifier miss → NOVEL.

</quick_reference>
