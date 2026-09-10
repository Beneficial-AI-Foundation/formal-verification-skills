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
review. Supplying all three flags is the standalone non-interactive path; never replace an explicit
choice. Ask only for missing choices, in this order:

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
`Skip review` when entered automatically; record it exactly as `Unreviewed (user skipped)` and do
not auto-start proof work.

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
node ~/.claude/scripts/fvs-spec-review.mjs run "$REQUEST_FILE"
```

The helper records input hashes and a complete `prompt.md` under a new
`.formalising/spec-reviews/<spec>-<unique>/` directory. It checks CLI installation/authentication,
then launches a fresh process with the selected model/effort. Codex uses a read-only, ephemeral
session with user config disabled; Claude uses safe mode with Read/Glob/Grep and native-sandboxed
Bash, no MCP servers, and a scratch cwd. The appended diagnostic policy permits small probes
and necessary existing-source builds with explicit generated output paths. Reviewed sources
remain read-only. Each attempt's raw evidence is saved before validation. These flags are per process;
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
node ~/.claude/scripts/fvs-spec-review.mjs import "$REVIEW_DIRECTORY" "$RESPONSE_FILE"
```

The importer verifies input hashes, the response structure, and exactly one
`VERDICT: PASS | APPROVE-WITH-EDITS | REVISE | BLOCKED`. It refuses overwrites and changed inputs. Imported responses
are labeled externally supplied; verify and record reviewer identity and actual model/effort
instead of treating the requested settings as proof of what ran. CLI-reported models, when
available, are recorded separately from the requested model; surface any runtime/model fallback.

Keep the reviewer text byte-for-byte intact. The reviewer never edits the specification. The
authoring seat (`lean-specify`) re-checks every finding and exclusively writes `triage.md` beside
`review.md`, recording finding IDs, accept/reject/defer evidence, requested versus observed
reviewer/model/effort, source coverage, and pre-edit/post-edit (old/new) hashes. Refuse to overwrite
either artifact.

Report the review path, provenance, selected model/effort, prioritized findings, accepted next
actions, and rejected/deferred findings with reasons. Keep the full reviewer response accessible
in the artifact. Distinguish the reviewer verdict from the orchestrator's disposition:

- **PASS**, supported by triage with no unresolved semantic issue: statement ready for
  `/fvs:lean-verify`; the theorem still has its original proof obligations.
- **APPROVE-WITH-EDITS:** the authoring seat applies every accepted, exhaustively named bounded
  edit, reruns the structure, style, and optional build gates, records finding IDs and old/new
  hashes, then sets `approved after edits`. This is terminal with no second review.
- **REVISE:** make a fresh substantive revision, then run another fresh review.
- **BLOCKED:** add the missing authority/evidence, then run another fresh review.
- **Failed, cancelled, disabled, or exported without a response:** report `Unreviewed`, including
  the reason. Do not claim successful adversarial verification or automatically begin proof work.

REVISE/BLOCKED cycles preserve each unique packet, `review.md`, and `triage.md`. Pass the prior
review and triage in the next request's `history` array as separately delimited untrusted process
history, never as source authority or proof-engineering memory. Run at most three reviewer rounds
per command invocation. At the cap stop with the latest artifact paths and the exact standalone
`/fvs:lean-spec-review <spec.lean>` resume command; never auto-approve.

</process>
