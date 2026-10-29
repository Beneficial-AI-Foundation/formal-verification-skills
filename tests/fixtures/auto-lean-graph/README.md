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

Derived cases are edits of `positive-bound` made inside `tests/auto-lean-graph.test.cjs`; there are no
derived fixture files.
