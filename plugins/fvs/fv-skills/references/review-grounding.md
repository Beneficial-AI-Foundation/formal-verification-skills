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
40 lines per signature, 200 charged signature lines, 2 MiB per source file, and an expanded
`grounding.json` of at most 64000 JavaScript code units.

The 200-line budget is charged per occurrence. Every analog span and every `cited_apis` span
costs its inclusive line count, even when the same file and lines already appear for another
declaration or as an analog. The distinct-span count is informational only.

Check the budget before building a review. Crypto:
`fvs-codex-think.mjs review-preflight --topic "$ROOT" --iteration "n$N" [--target plan|followup]
--grounding "$GROUNDING_FILE"`. FC: `fvs-spec-review.mjs preflight "$REQUEST_FILE"` with the same
request JSON you will pass to `run`; its spec and deduplicated context files are indexed as in the
real packet. Preflight writes nothing, needs no reviewer selection or authentication, and never
contacts a provider. On success it prints, for example:

```text
FVS >> Grounding budget: charged 192/200 signature lines (analogs 192, cited_apis 0); 12 distinct spans (111 lines) informational only: every occurrence is charged, including repeats
```

On overrun it exits nonzero with the complete totals (later spans are still counted) and the first
span that crossed the limit, for example `first overflow at declarations[20] "D20" analogs[0]
Api.lean:1-10 (cumulative 210)` or `first overflow at cited_apis[3] ...`. Narrow the review scope:
review fewer declarations, or keep only the analogs and cited APIs the reviewer needs. Do not
silently drop declarations or citations to fit, and do not compact or merge repeated spans. Rerun
preflight until it passes. `review` and `run` repeat the same analysis against current sources
before creating any review directory and again when writing `grounding.json`, so a passing preflight
approves nothing on its own.

Pass this path as crypto `--grounding "$GROUNDING_FILE"`, or FC request field
`"grounding": "<project-relative inventory.json>"`. The wrapper creates `grounding.json`
inside the immutable packet and binds the inventory and cited sources by hash. It
rejects changed grounding at import/publication. Missing inventories are explicitly
labeled missing in the packet for reviewer assessment, never treated as completed reuse
analysis. All runtimes, including Other, receive the same artifact and contract.
