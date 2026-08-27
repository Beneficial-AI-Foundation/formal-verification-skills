<div align="center">

# FORMAL VERIFICATION SKILLS

**Formal verification in Lean 4 with AI-assisted specification and proof — for Rust code (via Aeneas) and for maths/crypto papers. Multi-runtime.**

[![npm version](https://img.shields.io/npm/v/fv-skills-baif?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/fv-skills-baif)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

<br>

```bash
npx fv-skills-baif
```

**Works on Mac, Windows, and Linux. Supports Claude Code, Codex, OpenCode, and Gemini CLI.**

<br>

![FVS Install](assets/terminal.svg)

<br>

</div>

---

## What This Is

FVS encodes the expert formal verification workflow into skills for AI coding assistants. It takes Rust code through a structured pipeline — dependency analysis, deep code understanding, specification generation, and proof — using the AI to handle the tedious parts while you stay in control of the verification strategy.

**FVS targets Lean 4** across two tracks. The **functional-correctness track** verifies Rust code via Aeneas (Rust → Charon → LLBC → Aeneas → Lean 4). The **paper track** formalises mathematics and crypto papers directly into Lean — no Rust source or Aeneas extraction required.

Some capabilities are framework-agnostic and work regardless of your verification target:
- **Dependency mapping** builds function call graphs from any extracted code
- **Verification planning** picks optimal targets using greedy graph traversal
- **Natural language explanation** produces human-readable summaries of Rust functions with pre/post conditions

Framework-specific commands (currently Lean) handle the actual specification and proof generation.

---

## Getting Started

### Plugin marketplace (Claude Code and Codex)

The Beneficial AI Foundation maintains one catalog for FVS and future BAIF plugins. Add the catalog
once, then install FVS from its `beneficial-ai-foundation` marketplace identity:

```bash
# Claude Code
claude plugin marketplace add Beneficial-AI-Foundation/plugins
claude plugin install fvs@beneficial-ai-foundation

# Codex
codex plugin marketplace add Beneficial-AI-Foundation/plugins
codex plugin add fvs@beneficial-ai-foundation
```

Start a new session after installation. Run `/fvs:help` in Claude Code or mention `$fvs:help` in
Codex. To refresh an existing install, update the catalog and then update or reinstall FVS:

```bash
# Claude Code
claude plugin marketplace update beneficial-ai-foundation
claude plugin update fvs@beneficial-ai-foundation

# Codex
codex plugin marketplace upgrade beneficial-ai-foundation
codex plugin add fvs@beneficial-ai-foundation
```

The BAIF Git catalog is a versioned distribution source that can list multiple independently
released plugins. It is separate from OpenAI's universal public Plugins Directory, which has its
own per-plugin submission process.

### npm installer (all runtimes)

```bash
npx fv-skills-baif
```

The installer prompts you to choose:
1. **Runtime** — Claude Code, OpenCode, Gemini, or all
2. **Location** — Global (all projects) or local (current project only)

Verify with `/fvs:help` inside your chosen runtime. The npm installer remains the distribution path
for OpenCode and Gemini CLI, and is also available for Claude Code and Codex.

### Prerequisites (Lean 4 / Aeneas)

- A working Lean 4 toolchain, and a Lean project with `lakefile.toml` and `lean-toolchain`
- **Functional-correctness track:** Aeneas-generated Lean (`Types.lean`, `Funs.lean`). Produce it from a Rust crate with `/fvs:aeneas-extract`, or supply the output of an existing Aeneas run.
- **Paper track:** no Rust or Aeneas needed — bring your paper/source material (PDF, LaTeX, images).
- **Optional:** the Codex CLI, to run the crypto loop's thinking stages dual-runtime (`--codex`).

### Recommended: Lean LSP MCP Server

For enhanced Lean 4 proof development with LLMs, install the [lean-lsp-mcp](https://github.com/oOo0oOo/lean-lsp-mcp) server. It provides instant goal state checking, local lemma search, and proof diagnostics without rebuilding.

**Note:** Avoid using the `lean_multi_attempt` tool for formal verification tasks - FV proof states often explode in size, making multi-attempt testing prohibitively slow.

### Staying Updated

For a marketplace install, invoke `/fvs:update` in Claude Code or `$fvs:update` in Codex. For an npm
install, run:

```bash
npx fv-skills-baif@latest
```

<details>
<summary><strong>Non-interactive Install (Docker, CI, Scripts)</strong></summary>

```bash
# Claude Code
npx fv-skills-baif --claude --global   # Install to ~/.claude/
npx fv-skills-baif --claude --local    # Install to ./.claude/

# Codex
npx fv-skills-baif --codex --global    # Install to ~/.codex/

# OpenCode
npx fv-skills-baif --opencode --global # Install to ~/.config/opencode/

# Gemini CLI
npx fv-skills-baif --gemini --global   # Install to ~/.gemini/

# All runtimes
npx fv-skills-baif --all --global      # Install to all directories
```

Use `--global` (`-g`) or `--local` (`-l`) to skip the location prompt.
Use `--claude`, `--codex`, `--opencode`, `--gemini`, or `--all` to skip the runtime prompt.

</details>

---

## Commands

Commands are grouped into five bundles. Each bundle has a **router** command that lists its members and forwards to the matched skill (invoke it bare to print the routing table). All member commands are also directly typeable.

### Aeneas — `/fvs:aeneas`

| Command | Description |
|---------|-------------|
| `/fvs:aeneas-extract` | Drive a Rust crate/folder/file through the bounded Aeneas extraction repair loop (pin audit, classify, auto-apply/bisect/gate/escalate, reversible records) |
| `/fvs:sync-aeneas-verif` | Sync Aeneas/Charon upstream docs and reconcile the extraction blocker catalog via two specialised agents |

### Context — `/fvs:context`

| Command | Description |
|---------|-------------|
| `/fvs:map-code` | Build function dependency graph from extracted code and Rust source |

### Formal-Core — `/fvs:fc`

| Command | Description |
|---------|-------------|
| `/fvs:fc-plan` | Pick next verification targets via greedy dependency graph traversal |
| `/fvs:lean-specify` | Generate a style-checked Lean spec skeleton with `@[step]` theorem pattern |
| `/fvs:lean-verify` | Attempt proof with domain tactics while blocking new target-style violations |
| `/fvs:natural-language` | Generate natural language explanation of module or function with pre/post conditions |
| `/fvs:lean-refactor` | Refactor, simplify, and decompose verified proofs (dead code removal, simp sharpening, tactic golf) — *also in Formalise* |
| `/fvs:trust-audit` | Build-backed audit of every sorry/axiom affecting a target layer; `#print axioms` classification, fail-if-unjustified gate, dependency-ordered table |

`lean-specify` and `lean-verify` load a target style guide from
`.formalising/fvs-config.json` (`project.style_guide_path`) or discover standard files such as
`doc/STYLE_GUIDE`. With no guide they enforce a 100-column fallback. Their post-write gate also
rejects ordinary Lean identifiers with three or more namespace dots, steering generated code
toward scoped namespaces, `open`, and local names.

`lean-specify`, `lean-verify`, and `lean-formalise` share an indexed proof-engineering store at
`.formalising/proof-engineering/`. Commands read `index.md` first, load at most eight relevant
lessons as delimited untrusted reference data, and reconcile at most three evidence-backed
candidates after the run. Every lesson has its own Markdown file under `fc/`, `crypto/`, or
`shared/`, capped at 800 words, so the memory stays searchable and reviewable instead of growing
into one long note.
Legacy `.formalising/PROOF-NOTES.md` content is retained as migration input. The store never keeps
secrets, raw transcripts, ephemeral error dumps, unsupported guesses, or inferred preferences.

```text
.formalising/                # Per-project FVS state
├── CODEMAP.md               # Function inventory and verification status
├── proof-engineering/       # Indexed, durable proof/modeling knowledge
│   ├── index.md             # Read first; links and metadata only
│   └── lessons/
│       ├── fc/              # Functional-correctness lessons
│       ├── crypto/          # Crypto proof and modeling lessons
│       └── shared/          # Lessons validated across tracks
└── fv-plans/                # Formalisation plans and reviews
```

### Formalise (Paper Track) — `/fvs:formalise`

| Command | Description |
|---------|-------------|
| `/fvs:lean-formalise` | Formalise paper/math content into Lean 4 specs and definitions (one-shot) |
| `/fvs:lean-refactor` | Refactor, simplify, and decompose verified proofs — *also in Formal-Core* |
| `/fvs:crypto-plan` | Author the next bounded, runtime-neutral plan for a topic-based crypto formalisation iteration (KB-grounded, cached under `sources/`) |
| `/fvs:crypto-review` | Send an initial or follow-up crypto plan to authenticated Codex for independent, read-only adversarial review before execution |
| `/fvs:crypto-execute` | Run the current iteration's bounded plan under the green-build guard |
| `/fvs:crypto-eval` | Adversarially evaluate the iteration; ends in one of ACCEPT / FOLLOWUP / HUMAN_RULING / BLOCKED |
| `/fvs:crypto-followup` | Convert eval findings into the next follow-up plan; HALTs on HUMAN_RULING |

### Manage — `/fvs:manage`

| Command | Description |
|---------|-------------|
| `/fvs:help` | Show available FVS commands and usage guide |
| `/fvs:update` | Update FVS through the current installation channel |
| `/fvs:reapply-patches` | Preserve customizations across FVS updates (patches for npm installs; fork guidance for plugin installs) |
| `/fvs:kb-setup` | Set up NotebookLM knowledge base integration (venv, auth, config) |

---

## How It Works

### Functional-correctness track (Rust → Lean 4)

This track verifies Rust that Aeneas has lowered to Lean 4. Starting from a Rust crate, `/fvs:aeneas-extract <path>` drives it through the bounded **extraction repair loop** — pin audit → classify → auto-apply / bisect / gate / escalate → reversible records — until you reach a clean build or a documented escalation. It writes reversible source records (`src-modifications.diff` plus a derived `.json`/`.md` and `src-assumptions.md`) at the crate root and never edits generated Lean. Once you have `Types.lean` / `Funs.lean`, the five-stage verification workflow begins:

### 1. Map

`/fvs:map-code` — Run probe-aeneas >= 0.19.0 to build an exact, reproducible function inventory and dependency graph. Models annotate and prioritize the canonical list but never determine its membership or count. Produces `CODEMAP.md` with every in-scope Rust function, its dependencies, and verification status.

### 2. Plan

`/fvs:fc-plan` — Walk the dependency graph bottom-up to find optimal verification targets. Prioritizes leaf functions (no unverified dependencies) using greedy traversal. Performs deep Rust source analysis to reason about pre/post conditions and bounds.

### 3. Specify

`/fvs:lean-specify <function>` — Generate a specification skeleton for the target function. For Lean 4: uses the `@[step] theorem fn_spec` pattern with preconditions from Rust source analysis and postconditions matching function behavior.

The command reads the bounded proof-engineering index and may reviewably add one-file-per-lesson
functional-correctness insights for later sessions.

### 4. Verify

`/fvs:lean-verify <function>` — Attempt to prove the specification. For Lean 4: uses domain-specific tactics (`step`, `simp`, `ring`, `field_simp`, `omega`). Reports proof status and remaining goals if incomplete.

The proof loop loads a bounded selection from `.formalising/proof-engineering/` before research and
can reviewably retain green-build patterns or lessons evidenced by actual Lean diagnostics.

### 5. Simplify

`/fvs:lean-refactor <spec_path>` — Refactor, simplify, and decompose verified proofs. Applies tiered heuristics (dead code removal, simp sharpening, tactic golf, smart automation) while verifying compilation after every change. Three modes: safe, balanced (default), and aggressive.

### 6. Audit

`/fvs:trust-audit <target>` — Build-backed audit of the trust surface. It target-filters the same canonical probe-aeneas inventory, then uses `#print axioms` to classify every supplied function as verified / `sorry` / axiom / uninspectable. The classical trio (`propext`, `Classical.choice`, `Quot.sound`) is auto-noted as Lean/Mathlib-standard; any project-custom axiom, sorry, or uninspectable entry keeps the gate NOT-CLEAN. Produces a re-runnable, dependency-ordered table under `.formalising/audits/`.

### The paper track (maths / crypto)

The paper track formalises papers directly into Lean 4 — no Rust, no Aeneas. Two entry points:

- **One-shot:** `/fvs:lean-formalise` reads your PDFs / images / LaTeX (optionally grounded in a NotebookLM knowledge base via `/fvs:kb-setup`) and produces Lean definition and spec files in a single pass.
- **Iterative crypto loop:** for larger crypto formalisations, a topic-based, restartable loop with
  an independent pre-execution review gate:

  `/fvs:crypto-plan` → `/fvs:crypto-review` → `/fvs:crypto-execute` → `/fvs:crypto-eval` → `/fvs:crypto-followup` → `/fvs:crypto-review` → repeat

  A high-effort thinker authors each bounded plan. Before execution, authenticated Codex
  independently attacks the plan or follow-up under a read-only sandbox and returns an
  evidence-backed APPROVE / APPROVE-WITH-EDITS / REJECT verdict. The executor runs an approved plan
  under a green-build guard; the post-execution adversarial eval tries to refute the spec, proof,
  and assumptions and ends in exactly one of ACCEPT / FOLLOWUP / HUMAN_RULING / BLOCKED. Follow-up
  turns findings into the next plan (halting for a human modeling ruling) and is reviewed again
  before execution.

  The authoring, execution, eval, and follow-up stages use the lightweight proof-engineering overlay:
  they load at most eight relevant `crypto`/`shared` lessons and propose at most three reviewed
  updates. Modeling lessons require paper or standard citations and remain provisional until an
  accepted adversarial eval or explicit human ruling. The independent `crypto-review` gate is
  deliberately memory-blind, so inherited lessons cannot frame the second-runtime critique.

  **Single- vs dual-runtime (`--codex`).** By default the loop is single-runtime — the thinking stages (`crypto-plan`, `crypto-eval`, `crypto-followup`) run the in-runtime `fvs-crypto-thinker`. Pass `--codex` to hand a stage's thinking to an independent **Codex CLI** thinker instead, so the adversarial planner/evaluator runs on a *different engine* than the executor and blind spots don't correlate. `crypto-execute` is the runtime-neutral executor and takes no `--codex`. Without the Codex CLI installed, a `--codex` stage stops with an install hint rather than silently falling back.

---

## Uninstalling

```bash
# Global
npx fv-skills-baif --claude --global --uninstall
npx fv-skills-baif --opencode --global --uninstall

# Local (current project)
npx fv-skills-baif --claude --local --uninstall
```

Removes all FVS commands, agents, hooks, and settings entries. Does not affect other installed tools.

---

## Acknowledgements

FVS builds on the work of several open-source projects:

- **[Aeneas](https://github.com/AeneasVerif/aeneas)** -- FVS incorporates and adapts
  documentation and proof skills from the Aeneas verification framework (Apache 2.0).
  The upstream Aeneas documentation is stored in `fv-skills/upstream/aeneas/` and can
  be synced with `/fvs:sync-aeneas-verif`.

- **[GSD (Get Shit Done)](https://github.com/gsd-build/get-shit-done)** -- FVS follows
  the GSD plugin architecture for Claude Code skill distribution (MIT).

- **[lean-lsp-mcp](https://github.com/oOo0oOo/lean-lsp-mcp)** -- MCP server for Lean
  LSP integration, referenced in proof workflows (MIT).

Individual contributions:

- **[Jin Xing Lim](https://github.com/jinxinglim)** -- proposed gating a crypto formalisation
  plan on an independent second-runtime adversarial review before execution, and wrote the
  reviewer prompt that `/fvs:crypto-review` (v2.1.0) is modelled on.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
