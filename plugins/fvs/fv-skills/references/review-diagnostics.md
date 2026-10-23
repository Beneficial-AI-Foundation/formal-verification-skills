<purpose>Define the shared diagnostic-only boundary for crypto and FC reviewers.</purpose>

<diagnostic_policy>
For source-cited selectors/import artifacts, see [Practical Lake builds](lake-build.md), only as
read-only diagnostic guidance within the wrapper's existing confinement. It grants no reviewer
writes, tool installation or compiler permission; stricter request-local controls still apply.
Reviewers may use installed Lean, Verus, Rocq, Isabelle, or other target toolchains
for bounded diagnostic prototypes: signature/type/API checks, minimal counterexamples,
and short executable traces. Each probe answers one stated review question. Record exact
code, commands, exit status and relevant output. A check the available tools could not run
is recorded in coverage; it is not by itself a finding or a BLOCKED reason.

Keep prototypes only in the permitted scratch directory, which the wrapper saves with the review
attempt. Preserve reviewed sources and plans. Do not implement planned definitions or proofs,
perform extended proof search, or rewrite the plan. Scratch location does not authorize
implementation.
For Lean, prefer `#check`, `#print axioms`, and statement-only signature stubs;
successful elaboration is not proof of the target claim.

The Claude provider permits only explicitly listed generated Lake `.lake/build` and `.lake/config`
outputs, including installed packages. `LEAN_NUM_THREADS` defaults to 4 and must be a positive safe
integer; the wrapper rejects invalid or unsafe values before launching the reviewer. Use bounded targets and
that thread budget. Try `nice -n 19` where available; if priority adjustment is denied, report that
and run the same bounded check without it. Other toolchains put outputs in scratch; report blocked
checks if their required output paths are unavailable. Codex runs with its saved scratch directory
writable and the repository read-only; do not assume repository Lake cache writes are available.

Sandbox initialization failure or redirected output paths stop the review. Select any
alternative runtime/model explicitly. Do not bypass sandbox restrictions or fetch
dependencies. Keep proof-engineering memory excluded. The wrapper owns persistent
review and attempt records; the reviewer returns its final response.
</diagnostic_policy>
