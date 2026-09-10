<purpose>Define the shared diagnostic-only boundary for crypto and FC reviewers.</purpose>

<diagnostic_policy>
Reviewers may use installed Lean, Verus, Rocq, Isabelle, or other target toolchains
for bounded diagnostic prototypes: signature/type/API checks, minimal counterexamples,
and short executable traces. Each probe answers one stated review question. Default
instruction budget: three probes, about 40 lines each, at most one correction each.
Record exact code, commands, exit status and relevant output. Report uncertainty when
the budget or available tools cannot answer the question. This is not a CPU quota.

Keep prototypes disposable and in the permitted scratch directory. Preserve reviewed
sources and plans. Do not implement planned definitions or proofs, perform extended
proof search, or rewrite the plan. Scratch location does not authorize implementation.
For Lean, prefer `#check`, `#print axioms`, and statement-only signature stubs;
successful elaboration is not proof of the target claim.

A necessary build of existing sources is separate from the probe budget. The Claude
provider permits only explicitly listed generated Lake `.lake/build` and `.lake/config`
outputs, including installed packages. Use bounded targets and the configured thread
budget. Try `nice -n 19` where available; if priority adjustment is denied, report that
and run the same bounded check without it. Other toolchains put outputs in scratch;
report blocked checks if their required output paths are unavailable. Codex retains
its native read-only sandbox: do not assume Lake cache writes are available there.

Sandbox initialization failure or redirected output paths stop the review. Select any
alternative runtime/model explicitly. Do not bypass sandbox restrictions or fetch
dependencies. Keep proof-engineering memory excluded. The wrapper owns persistent
review and attempt records; the reviewer returns its final response.
</diagnostic_policy>
