<purpose>
Review one FC specification through a fresh adversarial reviewer. The user controls runtime,
model, and effort; the orchestrator records the response and checks the findings. The shared
`fv-skills/references/fc-spec-review.md` is the canonical reviewer contract.
</purpose>

<process>

## 1. Resolve the target and choose the reviewer

Resolve the requested existing `.lean` spec, its function, Rust source, extracted Funs/Types,
interpretation definitions, relevant dependency specs, and any explicit statement of intent.
Use the paths already resolved by `lean-specify` when called automatically. Ask when the target
is ambiguous. Report absent evidence; do not invent sources or infer correctness from compilation.
For legacy specs, record author runtime as `unknown` unless the user or generation record supplies
it. The current host is not evidence of who authored an existing spec.

Honor explicit `--reviewer`, `--model`, and `--effort` values and choices already made for this
review. Ask only for missing choices, in this order:

1. **Reviewer:** on Claude show `Codex (recommended)`, `Claude — fresh reviewer`, `Other`;
   on Codex show `Claude (recommended)`, `Codex — fresh reviewer`, `Other`. On another host show
   `Codex`, `Claude`, `Other`, recommending a runtime different from the known author where possible.
   If host and known author differ, annotate which choices actually give cross-runtime review.
2. **Model:** for Codex offer `GPT Sol — gpt-5.6-sol (default)`, `GPT Astra — gpt-6-astra`, and
   `Cheaper/custom model`; for Claude offer `Fable — fable (default)`, `Sonnet — sonnet`, and
   `Cheaper/custom model`. Custom choices accept the user's provider-specific model ID, including
   cheaper models; these suggestions are defaults, not minimum capability requirements.
3. **Effort:** offer `max (default)` and the selected runtime/model's supported lower levels.
   Include `runtime-default` for models without an effort control. Codex can also offer `ultra`
   when the selected model supports it; it is not the default. Consult the installed CLI/model
   catalog when available; do not silently substitute an effort when a model rejects `max`.

Use the host's question UI. Where it provides a built-in free-text Other field, use that field
instead of duplicating an Other option. Where no question tool works, print the choices and wait
for a text answer. A preselected option or unanswered prompt is not a selection. Offer a one-run
skip/cancel when entered automatically; record the spec as unreviewed if chosen.

For **Other**, ask for provider/runtime identity, model ID, and effort. Export the review packet
in Step 2 for that reviewer and import its returned response in Step 3. This route supports manual
handoff without executing arbitrary user-supplied shell commands.

## 2. Run or hand off the review

The helper uses a JSON request so paths and source contents never become shell commands. Create an
OS temporary request file with the Write tool (preserve JSON escaping):

```json
{
  "spec": "Specs/Module/Function.lean",
  "context": ["src/module.rs", "Generated/Funs.lean", "Generated/Types.lean", "Defs.lean"],
  "runtime": "codex",
  "model": "gpt-5.6-sol",
  "effort": "max",
  "author_runtime": "claude"
}
```

Use actual existing project-relative paths. Include complete relevant files, including definitions
used by the statement; do not pass only the theorem, an author summary, or proof-engineering
lessons. The reviewer must report unresolved/missing evidence as BLOCKED. `runtime` is
`codex|claude|other`; `author_runtime` is `codex|claude|other|unknown`. Record the precise identity of
Other separately in triage. Keep the selected model/effort explicit.
If relevant dependencies were omitted, add them to the request and run a new review. PASS must
cover only the hashed evidence packet; a reviewer's additional source reads are not captured by
the original hashes. Oversized packets fail at the selected runtime's context limit rather than
being silently summarized or truncated.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/fvs-spec-review.mjs run "$REQUEST_FILE"
```

The helper records input hashes and a complete `prompt.md` under a new
`.formalising/spec-reviews/<spec>-<unique>/` directory. It checks CLI installation/authentication,
then launches a fresh process with the selected model/effort. Codex uses a read-only, ephemeral
session with user config disabled; Claude uses safe mode with only Read/Glob/Grep and no MCP
servers. Neither receives write or proof-execution instructions. These flags are per process;
they do not change the user's runtime configuration. Use an up-to-date CLI if a flag is unsupported.

On unavailable authentication, CLI failure, unsupported model/effort, or invalid output: show the
error and setup guidance, then let the user retry, choose a different reviewer/model/effort, or
leave the review pending. Installing/signing in is the user's action; never auto-install or
silently fall back. Claude setup: https://code.claude.com/docs/en/overview; `claude auth login`.
Codex setup: install `@openai/codex`, then `codex login`.

**Same-runtime fallback without a usable CLI:** offer a fresh read-only subagent, never the author
or its resumed session. Inline the entire `prompt.md` content in its prompt; restrict tools to
source reads. Use the user's model/effort if supported. If the host cannot honor per-call controls,
state the actual inherited/configured values and obtain a revised selection before dispatch.
Record this limitation and import the returned text through Step 3. If fresh subagents are
unavailable, use the Other handoff or leave the review pending; do not relabel self-review.

## 3. Record and triage

For CLI reviewers, successful execution records `review.md` beside the packet. For Other or a
fresh fallback subagent, save the complete returned text to an OS temporary file and import it:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/fvs-spec-review.mjs import "$REVIEW_DIRECTORY" "$RESPONSE_FILE"
```

The importer verifies input hashes, the response structure, and exactly one
`VERDICT: PASS | REVISE | BLOCKED`. It refuses overwrites and changed inputs. Imported responses
are labeled externally supplied; verify and record reviewer identity and actual model/effort
instead of treating the requested settings as proof of what ran. CLI-reported models, when
available, are recorded separately from the requested model; surface any runtime/model fallback.

Keep the reviewer text intact. Re-check every finding against the cited source evidence and
append `## Orchestrator triage` with finding ID, accept/reject/defer, checked evidence, and proposed
next action. Record claimed versus observed reviewer/model/effort and source coverage. A material
model substitution or unresolved provenance is an explicit limitation, never hidden independence.
Do not edit the specification during review. Semantic corrections are a follow-up with a fresh
review after the changes. An old PASS never applies to a changed specification or source packet.

Report the review path, provenance, selected model/effort, prioritized findings, accepted next
actions, and rejected/deferred findings with reasons. Keep the full reviewer response accessible
in the artifact. Distinguish the reviewer verdict from the orchestrator's disposition:

- **PASS**, supported by triage with no unresolved semantic issue: statement ready for
  `/fvs:lean-verify`; the theorem still has its original proof obligations.
- **REVISE:** report the required statement corrections; keep the spec pending revision/review.
- **BLOCKED:** report missing evidence or unresolved intent; keep the spec pending review.
- **Failed, cancelled, disabled, or exported without a response:** report `Unreviewed`, including
  the reason. Do not claim successful adversarial verification or automatically begin proof work.

</process>
