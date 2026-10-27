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

## Choose the expository job before editing words

Identify what each sentence contributes and arrange the information in dependency order before
changing verbs or synonyms. Keep a clear sentence unchanged when it already serves its purpose.

| Job | Useful information order |
| --- | --- |
| Introduce a construction | Its purpose, the given data, the candidate algorithm or comparison map, then the property still to establish. Explain one stage before describing iteration when the first stage makes the recurrence understandable. |
| Define an object | Its parameters and their scope, the defining data and conditions, then its name. Distinguish the object from an object equipped with additional structure. |
| Introduce notation | Identify the existing object and assign its symbol; give the scope of any convention or abbreviation. |
| Give an explicit expression | Identify the already introduced quantity, give its expression, then clarify the symbols or conditions needed to read it. |
| State a consequence | Name the available premise or result and the conclusion it actually licenses. Use “therefore” or “equivalently” only for the supported relation. |
| Explain a theorem | Put hypotheses before the conclusion; define unfamiliar terms here or immediately above. Explain what the bound measures, not just its Lean identifier. |

These are choices for the passage at hand, not a template every paragraph must fill. A display
should introduce an object, perform an operation or state a result; surrounding prose should explain
its role or conditions rather than translate each symbol. Preserve matched wording for symmetric
operations and stable technical terms. Replacing repeated words alone does not improve exposition.

## Develop the explanation at the right level

- A module introduction can develop a connected explanation: the construction's purpose and
  source, its inputs and roles, how the main operations relate, and the result or remaining
  obligation. Group related sentences into paragraphs. For a protocol, a short role/message
  timeline, notation table or separate algorithm summaries can expose state and round structure
  more clearly than a dense paragraph. Use only supplied transitions, message order and data.
- A declaration docstring describes its own object or fact. Keep a short, sufficient docstring
  short; theorem statements and explanations of their proofs have different jobs. Retain useful
  proof explanations in their existing narrative location, with precise dependencies. A complete
  one-sentence argument need not be expanded, and a substantive construction need not be compressed
  to one sentence. Editing prose grants no authority to move or rewrite code.
- Introduce nonstandard notation before use. When paper and repository conventions differ, state
  their actual correspondence, including tuple order or units. Scope a simplification locally so it
  cannot look like a change of object. A brief reminder after a detour can be useful even if the
  notation appears earlier. Add a familiar case or example only when supplied by the source or
  verified from the existing definitions; never invent a specialization to complete a pattern.
- Attribute an inherited construction or argument at the relevant source locator, distinguishing
  supplied new ingredients from the cited strategy. Preserve necessary citations and technical
  repetition; do not claim originality, equivalence or proof by polishing a transition.
- State what the algorithm does or what the theorem asserts positively. Remove stale review history,
  empty emphasis, irrelevant modelling or naming justifications, rejected alternatives and duplicate
  caveats when they carry no technical meaning. Keep limitations and deviations that affect the
  admissible inputs, adversary model, interpretation or proof status. A negative statement may be
  necessary to record such a boundary; removing every “not” would lose information.
- Follow nearby accepted documentation for spelling, heading depth, notation, doc-comment form,
  citation syntax and the division between Lean docs and blueprint prose. Keep those accounts
  consistent without repeating every paragraph. Preserve formulas, references, anchors and embedded
  code. Publication attribution is scientific content: retain accurate author names and citation targets
  when required by the paper or repository. Flag any conflict with anonymization requirements
  rather than silently removing attribution.

Choose detail for the reader and the kind of document. Do not impose length quotas, synonym
rotation, a universal ban on passive voice or first-person plural, or the conversational register
of a review comment on final mathematical exposition.

## Synthetic examples

These are invented editorial examples, not claims about any particular protocol or paper. Each
revision assumes that all the stated facts are already supplied; it adds no algorithm or claim.

### Construction: connect purpose, data and the remaining claim

Before: “There is a candidate receive algorithm `R`. Its correctness remains to be proved. It uses
the given deterministic decapsulation function `D`. The goal is to construct a receive algorithm.”

After: “To construct the receive algorithm, use the given deterministic decapsulation function `D`
to define the candidate `R`. Correctness of `R` remains to be proved.”

This orders the existing purpose, input, candidate and obligation. It retains the determinism
restriction and pending proof. A module explanation can develop these connections; a field docstring
may need only its operation's description.

### Naming, expression and consequence: preserve their different roles

Before: “The total query count is `q`. It is `q = q_pre + q_post`. It is at most `Q` if `q_pre + q_post ≤ Q`.”

After: “Let `q` denote the total query count, given by `q = q_pre + q_post`. If `q_pre + q_post ≤ Q`,
then `q` is at most `Q`.”

Naming the count, giving its expression and drawing a conditional consequence are separate moves.
Retain every expression and condition; do not infer that an adversary chooses queries adaptively.

### Notation: make the convention boundary explicit

Before: “Here `σ` is `state`. For this subsection only, `σ` denotes the receiver state.
The source writes `(σ, m)`; Lean writes `(m, state)`.”

After: “For this subsection only, let `σ` denote the receiver state, represented by `state` in Lean.
The source's tuple `(σ, m)` corresponds to Lean's `(m, state)`.”

This states the local scope and correspondence without changing either tuple or renaming code.

### Theorem explanation: introduce the quantities before the bound

Before: “The estimate is `Pr[Win(A)] ≤ ε(q)` for every adversary `A` satisfying `F(A)` and making at
most `q` decryption queries. The event `Win(A)` is a successful forgery, `F(A)` is the freshness
condition, and `ε(q)` is the forgery bound.”

After: “Let `Win(A)` be the event of a successful forgery and `F(A)` the freshness condition.
For every adversary `A` satisfying `F(A)` and making at most `q` decryption queries, the forgery
bound `ε(q)` gives `Pr[Win(A)] ≤ ε(q)`.”

The revision supplies the same meanings before the inequality. It keeps the universal adversary,
freshness restriction, query bound and probability claim. It says nothing about a proof strategy.

### Declaration: give the fact on its own subject

Given a definition that returns `none` on rejection, replace “This is intentionally not an
always-successful receive map” with “The receive algorithm returns `none` on rejection.”
Given a theorem with `q` bounding the **number** of decryption queries, replace “the decryption
queries are bounded by q” with “The adversary makes at most `q` decryption queries.” Retain all
other theorem hypotheses and the original adversary model.

### Leave useful prose alone

“The receiver returns `none` on rejection.” already describes the operation. Repeating “receiver”
in the next sentence may keep the party explicit. A supplied restriction such as “This bound covers
fixed queries only; adaptive queries are not covered.” records mathematical scope and must survive.
A cited, complete one-sentence argument can also remain unchanged. None needs expansion or synonym
substitution merely to demonstrate an edit.

## Editorial eval findings

An editorial correction fixes grammar, spelling or demonstrably redundant wording while preserving
every technical assertion. A missing assumption, changed quantifier, security claim, source
interpretation, theorem statement, definition or proof is never editorial. Ambiguity is semantic
until resolved through the existing review/followup or human-ruling route. Mixed findings do not
qualify for an editorial-only pass. A green build or a small textual diff cannot establish this
classification or the quality of the corrected prose.
