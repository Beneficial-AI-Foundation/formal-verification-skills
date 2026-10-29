# Recorded fixture: Rust identity qualification run 1

These files are recorded outputs, copied byte-for-byte, of one offline run of the pinned tools on a small
crate written for this test (`lib.rs.txt`: a trait impl, two `From` impls, two `helper` functions in
different modules, a `while` loop and a recursive function). `npm test` reads them; it does not run Charon,
Aeneas, Lean or the probes.

| File | Produced by |
|---|---|
| `manifest.json` | `fvs-extract-patches.mjs prepare` (translation-patch mode, no patches; source commit `fac7cf2c`) |
| `translation.json` | Aeneas `nightly-2026.09.30-0855ce1` (`-backend lean -emit-json`) on the Charon 0.1.274 LLBC |
| `rust.json` | probe-rust 0.11.0 (source commit `1d2a7c5`) `extract --translation translation.json` |
| `lean.json` | probe-lean 0.14.0 (Lean v4.31.0) `extract` |
| `functions.json` | probe-aeneas 0.20.0 (tag commit `70cbb9b`) `extract`, which writes it into the Lean project |
| `translations.json` | probe-aeneas 0.20.0 `translate --rust --lean --functions --translation` |

Every step ran under a deny-network sandbox and has a raw receipt (exact command, numeric exit, expanded
environment, binary and input/output hashes) kept outside the repository with the qualification evidence.
The absolute paths inside `manifest.json` are those of that run and are kept unmodified.
