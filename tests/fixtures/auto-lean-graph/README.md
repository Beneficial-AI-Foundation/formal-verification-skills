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
| `positive-theorem` | adds `M1demo/Spec.lean` (commit eef73c8f) | none | 0 |
| `neg-default-targets` | `defaultTargets = ["Other"]`, stale `M1demo` build cache kept | none | 0 |
| `neg-default-targets-fresh` | as above, `.lake/build` removed | none | 0 |
| `neg-module-filter` | as positive | `--module M1demo.Spec` | 0 |
| `neg-empty-library` | `defaultTargets = ["Other"]`, `Other.lean` has no declarations | none | 0 |
| `neg-unknown-library` | as positive | `--library NoSuchLib` | 1, no output |
| `neg-missing-aeneas-package` | `.lake/packages/aeneas` removed | none | 1, no output |

`project/` holds the demo's real `aeneas-config.yml`, `lake-manifest.json`, `lean-toolchain` and
`M1demo/translation.json` (sha256 `bb20ee96...`), shared by every run.

Derived cases (truncated extract, truncated log, dropped declarations, unqualified versions) are edits of the
recorded positive made inside `tests/auto-lean-graph.test.cjs`; there are no derived fixture files.
