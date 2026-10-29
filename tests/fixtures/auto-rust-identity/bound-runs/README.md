# Recorded fixture: bound extraction attempts

Recorded outputs, copied byte for byte (LLBC files gzipped with `gzip -9 -n`), of five offline runs on one
fixture crate (`lib.rs.txt`, commit `8d4406a8`): a trait impl, two `From` impls, two `helper` functions, a
`while` loop and `mode()`, whose body alone depends on the `alt` feature. The runs were made with the patch
engine, auto state operations and parser of commit `815d5879` (each run's script hashes are kept with its
receipts). Each run went through the patch engine's recorded attempt (prepare, attempt, charon, aeneas, publish) under the deny-network sandbox with
only `HOME`, `RUSTUP_HOME`, `CARGO_HOME` and `PATH` set, then `lake build`, `record-extraction` (whose state
is `state.json`) and the pinned probes. `npm test` reads these files; it does not run any tool.

| Run | Configuration | What it shows |
|---|---|---|
| `positive-a` | `--sysroot default`, `--locked` | bound, every function exact: complete |
| `positive-b` | the same, a second fresh attempt | the same configuration hash, translation.json and Lean bytes; its LLBC differs from `positive-a` only in `options.dest_file` |
| `feature-alt` | adds `--features alt` | body-only change: translation.json is byte-identical to `positive-a` (same def_ids and spans), the Lean output and LLBC differ, and the configuration hash differs |
| `option-opaque` | adds `--opaque m1demo::left::helper` | a different configuration hash and translation.json |
| `cargo-config` | as `positive-a`, with an ancestor `.cargo/config.toml` | outputs identical to `positive-a`, but the attempt is unsupported (the config file is a residual), so the record is unbound |

Probe outputs are kept for `positive-a` and `option-opaque`. The other runs' translation.json is
byte-identical to `positive-a`'s, so the tests reuse its probes. Raw receipts for every step are kept outside
the repository with the qualification evidence. Absolute paths inside the files are those of the runs.
