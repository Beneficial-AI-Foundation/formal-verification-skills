# Lean graph fixtures

These are fixtures, not proof or qualification evidence. `npm test` reads them; it never runs Lean, Lake or
probe-lean.

`recorded/<run>/` holds real, unmodified probe-lean 0.14.0 output (`lean.json`) and its captured
stdout/stderr (`probe.log`; the trailing `EXIT=<n>` line was appended by the capture). Every run used
`probe-lean extract <project> -o <out>/lean.json [flags]` (binary sha256
`fd31d965a9d12cd5a95080c810d3441a8d38e380f25eee37c85b9444ceec283d`, the Lean 4.31.0 build) under a
deny-network sandbox with an `env -i` allowlist, on macOS arm64 with the host's `~/.elan`. The projects were
throwaway copies of the milestone 1 demo extraction (`m1demo`, Aeneas nightly-2026.09.30-0855ce1, Charon
0.1.274) with one added module, `M1demo/Spec.lean`, holding a proved theorem `double_spec` over the extracted
`double`:

| Run | Project change | Flags | Tool exit |
|---|---|---|---|
| `positive-bound` | adds `M1demo/Spec.lean` (commit eef73c8f); `lake build M1demo` first | `--library M1demo` | 0 |
| `neg-default-targets-cache-hit` | `defaultTargets = ["Other"]`, warm stale `M1demo` cache; `lake build` first | none | 0 |
| `positive-theorem` | as `positive-bound`, no receipt | none | 0 |
| `neg-default-targets` | `defaultTargets = ["Other"]`, stale `M1demo` build cache kept | none | 0 |
| `neg-default-targets-fresh` | as above, `.lake/build` removed | none | 0 |
| `neg-module-filter` | as positive | `--module M1demo.Spec` | 0 |
| `neg-empty-library` | `defaultTargets = ["Other"]`, `Other.lean` has no declarations | none | 0 |
| `neg-unknown-library` | as positive | `--library NoSuchLib` | 1, no output |
| `neg-missing-aeneas-package` | `.lake/packages/aeneas` removed | none | 1, no output |

The first two runs also have `receipt.json` (`fvs/lean-probe-run` version 1), written by the capture at run
time: both argv vectors, exit codes, probe binary hash and version, the Lean project commit, the sha256 of
every project input (Lean sources, Lake configuration, `translation.json` and the project's `.ilean` files,
taken after the probe finished) and of the extract and log.

`project/` is the `positive-bound` project's bound inputs, byte-identical to its receipt (Lean sources,
`lakefile.toml`, `lake-manifest.json`, `lean-toolchain`, `M1demo/translation.json` sha256 `bb20ee96...`, and
the three `.lake/build/lib/lean/**/*.ilean` files), plus the demo's `aeneas-config.yml`, which locates
`translation.json`. `extraction/manifest.json` is the real `fvs-extract-patches/manifest` of the demo's
recorded extraction (sha256 `02b41307...`, source commit 8c8955e1, no patches).

## Bound to a recorded extraction attempt

`bound-project/` is a second throwaway copy of the demo (commit 8c8955e1), extracted afresh through the patch
engine's recorded attempt (prepare, attempt, charon, aeneas, publish, `lake build`, `record-extraction`) with the
demo's local Aeneas nightly-2026.09.30-0855ce1 / Charon 0.1.274 release, under the deny-network sandbox. A
separate `Specs` library (`Specs.lean`, `Specs/Double.lean`: the same proved `double_spec`) lies outside the
publish directory `M1demo/` and is uncommitted, so the Lean project commit equals the Rust source commit. The
directory holds the files the run receipt binds, byte-identical: the published `M1demo/M1demo.lean` and
`M1demo/translation.json`, the Lean sources, Lake configuration and four `.ilean` files, plus
`aeneas-config.yml`. The run's `.formalising/auto-fv/state.json` (whose `extraction.run` records the attempt) is
kept as `recorded/bound-positive/state.json`, because `.formalising/` paths are excluded from the repository;
the tests copy the project to a temporary directory and put the state back in place.
`extraction/attempt-manifest.json` is that attempt's patch manifest.

| Run | Project | Flags | Tool exit |
|---|---|---|---|
| `bound-positive` | `bound-project`; `lake build M1demo Specs` first | `--library M1demo,Specs` | 0 |
| `bound-mutated-body` | as above with the published `clamp` body hand-edited (`recorded/bound-mutated-body/M1demo.lean`) | `--library M1demo,Specs` | 0 |

## Omitted external lists, structures and projections

`kinds-project/` is `bound-project` with a third spec module, `Specs/Kinds.lean`: a def and a theorem with no
external constant, defs and a theorem with external constants, structures with external and only-local fields
(one holding an Aeneas `U32`), a class with two instances, and theorems whose statements reach structures only
through projections. It holds run A's receipt-bound files (the state is again `recorded/bound-positive/state.json`).

| Run | Project | Flags | Tool exit |
|---|---|---|---|
| `sparse-structures` (run A) | `kinds-project`; `lake build M1demo Specs` first | `--library M1demo,Specs` | 0 |
| `sparse-kinds` (run B) | the same project with an inductive `Color` and a match on it instead of the two structure theorems (`recorded/sparse-kinds/Kinds.lean` and its `Kinds.ilean`) | `--library M1demo,Specs` | 0 |

Each run's `lean-constants.json` is Lean's own record of the project declarations, captured from the built project
with `lake env lean` on a small metaprogram (in the qualification evidence): every declaration's kind and the
constants its type and value (theorem proofs included) mention. It is the ground truth the omitted-list contract is
checked against.

`seeded/feature-alt-M1demo.lean` is a mutation seed, not output of this project: the published `M1demo.lean`
(sha256 `3f55027e...`) of a separately recorded `--features alt` attempt on another fixture crate, whose
`translation.json` equals that attempt's positive. A test places it over `bound-project`'s published file to show
that different Lean bytes under this attempt's state block.

Derived cases are edits of `positive-bound` or `bound-positive` made inside `tests/auto-lean-graph.test.cjs`; there are no
derived fixture files.
