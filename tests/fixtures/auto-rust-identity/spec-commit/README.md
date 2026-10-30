# Recorded fixture: a Lean project commit that differs from the Rust source commit

Recorded outputs, copied byte for byte (the LLBC gzipped with `gzip -9 -n`), of one offline run on the
binding fixture crate. A recorded extraction attempt (prepare, attempt, charon, aeneas, publish, lake build,
record-extraction: `state.json`) and probe-rust (`rust.json`) ran at the Rust source commit `8d4406a8`. Then a
specification library, `M1demoSpec.lean.txt` (outside the publish directory `M1demo/`, with its own
`lean_lib`), was committed, moving the Lean project to `9640d99b`. lake build and probe-lean (`--library
M1demo,M1demoSpec`, giving `lean.json`, whose source.commit is `9640d99b`) ran there. `lean-receipt.json` is that
run's `fvs/lean-probe-run` version 1 receipt, ticket 21's schema, with the project files hashed by ticket 21's
own `projectInputs`. `npm test` reads these files; it runs no tool.
