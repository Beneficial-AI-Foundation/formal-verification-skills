<purpose>Judge reuse, scope, content coverage, findings, and author dispositions consistently.</purpose>

<shared_review_policy>
Grounding is evidence, not authority by itself. Check the supplied inventory against
the target: declarations, analogs, searches yielding no analog, and cited API signatures.
The wrapper verifies verbatim source spans and freshness; scout selections and search
claims remain untrusted. A missing/incomplete inventory is a finding where it prevents
judging reuse or source fidelity. Never infer semantic absence from a keyword search.

Reuse: inspect existing project and pinned dependency APIs before endorsing new helpers
or abstractions. An unjustified fork of an existing abstraction is at least MAJOR,
Class: CONTENT. Distinguish legitimate adapters and extensions from duplication. In
FC, implementation source determines behavior; mathlib and project helper lemmas are
reuse candidates, not authority for inventing different implementation semantics.

Scope economy: check unused parameters, helper lemmas without consumers, trivial
wrappers, and work belonging to a later iteration. State the concrete wasted or
misleading interface/obligation, not a preference for a different design.

Classify each finding as CONTENT (mathematics, source fidelity, API/reuse, semantic
scope) or PROCESS (workflow, evidence tracking, gates). Order by BLOCKER, MAJOR, MINOR,
OBSERVATION, then CONTENT before PROCESS within a severity. IDs are unique `F-<integer>`.
Each finding has one Class, Claim, Evidence, and bounded Minimal suggested edit
(FC may label that last field Suggested change). Limit suggested edits to 80 lines /
4000 characters; use a precise re-planning request for larger changes. Claim and
Evidence must be substantive, with re-verifiable citations or a concrete counterexample.

The Content coverage statement identifies mathematical/source surfaces actually
examined, conclusions, and uncertainties. A long process audit cannot substitute for
content review. Documentation: missing prose alone is not a finding. False claims,
misleading authority, and enlarged trust boundaries are findings, graded by consequence.

Authoring-seat dispositions (kept in separate immutable triage):
- FIX: apply the named bounded correction and record gates and old/new hashes.
- DESCOPE: remove the offending planned work and check remaining obligations still close.
- DEFER-WITH-RULING: cite a verbatim dated human ruling accepting the deferral, with the
  unresolved question and downstream impact. The author cannot grant its own ruling.
- REJECT-FINDING: demonstrate with source evidence why the finding is wrong.
- ASK-HUMAN: unresolved authority/scope choice; approval remains pending.

Accepted MAJOR/BLOCKER reuse findings require FIX (including removing the duplication)
or DEFER-WITH-RULING; renaming them MINOR or deferring silently is insufficient.
DESCOPE counts as a fix only when it eliminates the cited defect. A disproven finding
may be REJECT-FINDING with checked evidence. An unresolved required edit blocks approval.

APPROVE-WITH-EDITS remains terminal after all required bounded edits are resolved and
local gates pass. Formatting correction is not another review round. Preserve the raw
response and any mechanical normalization separately; no formatting operation may
change claims, IDs, severity, class, evidence, suggested edits, or verdict. Missing
substantive fields require a new explicitly requested response; never invent them.
Explicit user Skip/override remains available and must be labeled unreviewed/overridden,
not misrepresented as reviewer approval.
</shared_review_policy>
