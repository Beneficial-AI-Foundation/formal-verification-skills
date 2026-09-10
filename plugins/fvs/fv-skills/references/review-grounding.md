# Preparing review grounding

<purpose>Prepare bounded, verifiable source and reuse evidence before review.</purpose>

Before invoking either review helper, perform a bounded read-only scout of the target
and its local dependencies. Inventory every proposed declaration/helper. Look for
3–5 existing analogs per declaration in project libraries and installed pinned
dependencies (for example `.lake/packages/mathlib`). If fewer exist, report the actual
results and search limits. Include exact signatures and source locations for cited APIs.
Do not manufacture matches to reach a quota, implement helpers, or run proof search.

Crypto: require `## Reuse audit` in the high-level plan or follow-up; map proposed
declarations to REUSE-AS-IS, EXTEND, ADAPTER, or JUSTIFY-FORK with evidence. The executor
plan must implement those choices. Keep paper authority separate from API evidence.

FC: ground behavior in the implementation and its extraction/interpretation definitions.
Check proposed helper lemmas against project libraries and dependencies such as mathlib.
Record the reuse audit in this companion inventory, not as mandatory prose in Lean
source. An empty declarations list is valid when no new helper/abstraction is proposed;
still index the existing APIs used by the specification.

Save a fresh `inventory.json` under a unique directory in the active review tree:
crypto `reviews/_grounding/` within the topic; FC `.formalising/spec-reviews/_grounding/`.
Use project-relative paths and this schema (replace the example with real evidence):

```json
{
  "version": 1,
  "declarations": [
    {
      "name": "proposed_helper",
      "signature": "the proposed statement, without a proof",
      "analogs": [
        {"path": "Math/Existing.lean", "start": 12, "end": 15, "handling": "REUSE-AS-IS"}
      ],
      "search": {
        "queries": ["exact read-only searches actually run"],
        "roots": ["Math", ".lake/packages/mathlib/Mathlib"],
        "conclusion": "Only one relevant analog found in the searched scope."
      }
    }
  ],
  "cited_apis": [{"path": "Math/Existing.lean", "start": 12, "end": 15}],
  "limitations": "State unavailable dependencies, omitted searches, or uncertainty."
}
```

Use `analogs: []` plus queries, roots, and an explicit conclusion for a no-analog result.
Select complete signature spans; the wrapper extracts their contents verbatim and hashes
each underlying file. Bounds: 30 proposed declarations, 5 analogs each, 60 cited APIs,
40 lines per signature, 200 total signature lines, 2 MiB per source file, 64 KiB expanded artifact. Narrow the
review scope if it exceeds these bounds; do not silently drop declarations or citations.

Pass this path as crypto `--grounding "$GROUNDING_FILE"`, or FC request field
`"grounding": "<project-relative inventory.json>"`. The wrapper creates `grounding.json`
inside the immutable packet and binds the inventory and cited sources by hash. It
rejects changed grounding at import/publication. Missing inventories are explicitly
labeled missing in the packet for reviewer assessment, never treated as completed reuse
analysis. All runtimes, including Other, receive the same artifact and contract.
