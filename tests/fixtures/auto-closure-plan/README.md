# Recorded fixture: ticket 13 closure plan inputs

Recorded outputs, copied byte for byte (the LLBCs gzipped with `gzip -9 -n`), of two offline runs at the
landed `ada/auto-fv` head `b9d8c394`. Each run made one recorded extraction attempt (prepare, attempt, charon,
aeneas, publish, lake build, record-extraction), the pinned probes, a ticket 10 identity record
(`identity-record.json`, with a ticket 21 run receipt) and a ticket 21 Lean graph record (`graph-record.json`,
receipt built with ticket 21's state-hashing `projectInputs`) from the same project. Raw receipts for every
step are kept outside the repository. `npm test` reads these files; it runs no tool.

| Run | Crate (`lib.rs.txt`) | What the records say |
|---|---|---|
| `positive` | `helper`, `sum_to` (loop), `root_a` and `root_b` (both call `helper`; `root_b` also calls `sum_to`), `independent` | both complete and bound, with equal provenance and published Lean files |
| `recursion` | `count_down` (self-recursive), `is_even` and `is_odd` (mutually recursive), `root_self`, `root_mutual`, `root_plain` | ticket 10 partial and bound (the three recursive functions are unsupported, reason recursion); ticket 21 incomplete and unbound (probe-lean omits empty external lists on `is_even` and `is_odd`) |
