<overview>
# Protocol formalisation prose

Use these rules when authoring protocol explanations or explicitly revising existing prose.
They guide the existing authoring call; they add no model call, review gate or edit authority.
The target repository's documentation conventions and the supplied scientific content govern.
</overview>

## Meaning before wording

- Ground terminology in the actual source paper or standard, with its version and section,
  definition, algorithm or theorem locator. Use the target's established correspondence between
  paper notation and Lean identifiers. Where they differ, explain the mapping without renaming code.
- Keep the parties, roles, message direction, round or epoch indices, state transitions, oracle
  access and corruption conditions explicit where needed to understand the passage. Introduce
  nonstandard symbols before using them. Preserve units, return order and failure behavior.
- Preserve quantifier order, dependencies of choices, assumptions, adversary capabilities, query
  bounds, probability spaces, advantage normalization and reduction direction. Keep correctness,
  security and implementation correspondence distinct. A construction is not a security proof.
- State a definition as a definition, a theorem with its hypotheses and conclusion, and a planned
  obligation as pending. Preserve distinctions between equality, equality in distribution and a
  bound. A successful build checks elaboration; it does not establish paper fidelity or close a
  proof obligation. Never invent a proof claim, citation, assumption or missing argument.
- If the paper, prose and Lean disagree, flag the exact conflict separately. Retain the existing
  mathematical scope; resolve neither a model discrepancy nor an ambiguous claim by wordsmithing.
  Preserve material limitations and documented deviations that affect interpretation.

## Exposition at the right level

- Let module introductions identify the construction or result and its source. Let declaration
  docstrings describe their own object or fact. Use blueprint or narrative documentation for the
  longer explanation, keeping the accounts consistent without repeating every paragraph.
- Give the reader the purpose and dependencies of a construction when they help. For a short
  algorithm, established notation or existing pseudocode can be clearer than narrating each line.
  For a theorem, state what holds under which assumptions; keep proof narration in its existing
  place. Editing prose grants no authority to move or rewrite code.
- Prefer concrete subjects and standard cryptographic vocabulary. Remove stale review history,
  empty emphasis and redundant naming justifications when they carry no technical meaning.
  Retain useful technical repetition; avoid synonym rotation, invented compound terms, arbitrary
  length quotas or a universal ban on passive voice or first-person plural.
- Follow nearby accepted documentation for spelling, heading depth, notation, doc-comment form,
  citation syntax and the division between Lean docs and blueprint prose. Preserve formulas,
  references, anchors and embedded code. Publication attribution is scientific content: retain
  accurate author names and citation targets when required by the paper or repository. Flag any
  conflict with anonymization requirements rather than silently removing attribution.

## Synthetic examples

These are invented editorial examples, not claims about any particular protocol or paper.

- Given a theorem with `q` bounding the **number** of decryption queries, replace “the decryption
  queries are bounded by q” with “The adversary makes at most `q` decryption queries.” Retain all
  other theorem hypotheses; do not add an adaptive-access claim.
- Given a definition that returns `none` on rejection, replace “This is intentionally not an
  always-successful receive map” with “The receive algorithm returns `none` on rejection.”
- Given a plan with a security lemma still pending, replace “There remains the future task of
  proving the stated security lemma” with “The security lemma remains a proof obligation.”
  If its status is unclear, flag it separately rather than asserting completion.

## Editorial eval findings

An editorial correction fixes grammar, spelling or demonstrably redundant wording while preserving
every technical assertion. A missing assumption, changed quantifier, security claim, source
interpretation, theorem statement, definition or proof is never editorial. Ambiguity is semantic
until resolved through the existing review/followup or human-ruling route. Mixed findings do not
qualify for an editorial-only pass. A green build or a small textual diff cannot establish this
classification or the quality of the corrected prose.
