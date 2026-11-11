# Reproduce a Lean witness without adopting historical runtime state

The graph reader keeps extraction facts separate from project setup. This is a bounded interface
for the qualified Lean4.31 constants-v2/probe-lean lane; no new extraction or proof is implied.

`fvs-lean-graph.mjs ... --extraction-state ORIGINAL_STATE.json` reads the raw original state outside
the immutable Lean source. The API equivalent is `buildLeanGraph({... , extractionStateText})`.
It uses the existing recorded-state validation and extraction/publication checks. The resulting
`binding.input` records mode `external-recorded-attempt` and SHA256 of those exact bytes. No file is
written into the project and historical choices, agreements and grants are never installed.

If live state exists, it must validate and its extraction status/inputs/run must agree. Runtime
choices are not substituted. Malformed/duplicate JSON, a changed publication or conflicting facts
leave the graph incomplete/unbound. The default with no explicit input retains legacy live-state
behavior and emits no new binding marker. Complete graph state alone does not establish binding.

The checker independently rebuilds identity, graph and closure plan. For a marked graph it requires
the same exact already-bound extraction.rust.state bytes and digest, then passes them to the graph
API and compares the actual canonical output. Missing/unknown/mismatched markers refuse; a supplied
bound label, edited graph or self-consistent plan cannot replace reproduction. Legacy graphs retain
the original route. Rebind the actual engine identity after any source change.

Receipt validation preserves legacy argv and adds only these finite forms:

- `[LAKE, "--no-cache", "--rehash", "--verbose", "build", ...requestedLibraries]`, with exactly the
  requested root set and the pinned Lake bytes.
- `[LAKE, "env", "lean", "--threads=2", EXTRACTOR_FILE]`, with retained extractor bytes matching the
  recorded producer, pinned Lake and the actual project cwd.

Keep all actual flags in execution and receipts. Unknown/reordered/conflicting options, wrong tools,
programs, roots or output/import identity refuse. These argument checks do not prove child resource
propagation: retain the separate measured cap evidence, current tool/source/dependency pins and
fresh project build receipts. No automatic tool upgrade/download or general flag parser exists.

The unshipped tests/helpers/lean-witness-capture runner is a reviewed-source candidate for the
M1demo-only tracer, relocated from the preserved seven-step producer with unchanged qualified
support/templates. Its prepare-only path runs no tools and is not witness evidence. Actual capture,
consumer/provenance review and real checker acceptance remain separate gates. Do not use an old
state/Specs/receipt in the new source, remove inconvenient inputs or rewrite envelope SHAs.
