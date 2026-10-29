# Recorded fixture: Rust identity qualification run 2

Recorded outputs, copied byte-for-byte, of a second offline run of the pinned tools (same pipeline and
receipts as `../qualified-run1`) after one commit (`bfe6580e`) that adds a type-generic function `pick<T>`
and its caller `pick_u32` to the run 1 crate (`lib.rs.txt`). Under the same Charon version (0.1.274) the
added functions renumber existing def_ids: for example the trait-impl method `score` is def_id 22 in run 1
and 24 here. `npm test` reads these files; it does not run Charon, Aeneas, Lean or the probes.
