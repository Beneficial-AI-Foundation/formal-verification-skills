# Registry input fixture

`plan.json` and `graph.json` are exact recorded bytes from the genuine paired
Rust-identity / Lean-graph / closure-planner run at FVS commit
`af2dac66992090a3054f9770e22e93d03d2514d1`:

- plan: `f3a57d76661f76388eb45a07148b5ddda392fdd783149a41eb8c776bd687d83e`
- graph: `d653bfda8a94ebbead3b9ae74bf49c9766502d3d5342850bdfcae5390bbeacbd`

Source: session 39's retained
`paired-join/af2dac669920-20261030T223441Z-21878/` run, manifest
`09ffb47417615af24aa9924b0f516fa9e5357026e173f42322a06752e9cc9449`.
Session 43 accepted this bounded evidence in
`paired-join-evidence-review-af2dac6.md`, SHA-256
`cb40dd6e69eab46f75c25ed52e58d2391d08de9d9aee375dcdbeb4999f419a1c`.

The lane is mixed-version: identity metadata uses probe-rust 0.11.0,
probe-aeneas 0.20.0 and probe-lean 0.14.0; graph metadata uses probe-lean
0.24.0 and the accepted constants-v2 capture on Lean 4.31. This does not
promote the newer stack or qualify recursion, private Rust identities,
class/instance labels, dalek or Lean 4.35.

The registry tests read these recorded inputs. Contracts, definition files,
reviews and mutations created by the tests are labelled synthetic test data.
The tests run no probes, compilers, Lean proofs or model providers. Provisional
review state and declared independence do not constitute proof acceptance.
