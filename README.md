<div align="center">

# FORMAL VERIFICATION SKILLS

**Formal verification of Rust code with AI-assisted specification and proof. Multi-framework, multi-runtime.**

[![npm version](https://img.shields.io/npm/v/fv-skills-baif?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/fv-skills-baif)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

<br>

```bash
npx fv-skills-baif
```

**Works on Mac, Windows, and Linux. Supports Claude Code, OpenCode, and Gemini CLI.**

<br>

![FVS Install](assets/FVS.png)

<br>

</div>

---

## What This Is

FVS encodes the expert formal verification workflow into skills for AI coding assistants. It takes Rust code through a structured pipeline — dependency analysis, deep code understanding, specification generation, and proof — using the AI to handle the tedious parts while you stay in control of the verification strategy.

**v1 focuses on Lean 4 via Aeneas** (Rust → Charon → LLBC → Aeneas → Lean 4). Verus and other verification frameworks are planned for v2.

Some capabilities are framework-agnostic and work regardless of your verification target:
- **Dependency mapping** builds function call graphs from any extracted code
- **Verification planning** picks optimal targets using greedy graph traversal
- **Natural language explanation** produces human-readable summaries of Rust functions with pre/post conditions

Framework-specific commands (currently Lean) handle the actual specification and proof generation.

---

## Getting Started

```bash
npx fv-skills-baif
```

The installer prompts you to choose:
1. **Runtime** — Claude Code, OpenCode, Gemini, or all
2. **Location** — Global (all projects) or local (current project only)

Verify with `/fvs:help` inside your chosen runtime.

### Prerequisites (Lean 4 / Aeneas)

- A Lean 4 project with `lakefile.toml` and `lean-toolchain`
- Aeneas-generated output (`Types.lean`, `Funs.lean`) from your Rust source
- Lean 4 toolchain installed and working

### Recommended: Lean LSP MCP Server

For enhanced Lean 4 proof development with LLMs, install the [lean-lsp-mcp](https://github.com/oOo0oOo/lean-lsp-mcp) server. It provides instant goal state checking, local lemma search, and proof diagnostics without rebuilding.

**Note:** Avoid using the `lean_multi_attempt` tool for formal verification tasks - FV proof states often explode in size, making multi-attempt testing prohibitively slow.

### Staying Updated

```bash
npx fv-skills-baif@latest
```

<details>
<summary><strong>Non-interactive Install (Docker, CI, Scripts)</strong></summary>

```bash
# Claude Code
npx fv-skills-baif --claude --global   # Install to ~/.claude/
npx fv-skills-baif --claude --local    # Install to ./.claude/

# OpenCode
npx fv-skills-baif --opencode --global # Install to ~/.config/opencode/

# Gemini CLI
npx fv-skills-baif --gemini --global   # Install to ~/.gemini/

# All runtimes
npx fv-skills-baif --all --global      # Install to all directories
```

Use `--global` (`-g`) or `--local` (`-l`) to skip the location prompt.
Use `--claude`, `--opencode`, `--gemini`, or `--all` to skip the runtime prompt.

</details>

---

## Commands

### General (framework-agnostic)

| Command | Description |
|---------|-------------|
| `/fvs:map-code` | Build function dependency graph from extracted code and Rust source |
| `/fvs:plan` | Pick next verification targets via greedy dependency graph traversal |
| `/fvs:natural-language` | Generate natural language explanation of module or function with pre/post conditions |
| `/fvs:help` | Show available FVS commands and usage guide |
| `/fvs:update` | Self-update to latest version via npx |

### Lean 4 (via Aeneas)

| Command | Description |
|---------|-------------|
| `/fvs:lean-specify` | Generate Lean spec skeleton with `@[progress]` theorem pattern |
| `/fvs:lean-verify` | Attempt proof using domain tactics (progress, simp, ring, omega) |

---

## How It Works

FVS follows a four-stage workflow. Each stage builds on the previous.

### 1. Map

`/fvs:map-code` — Analyze extracted code and Rust source to build a function dependency graph. Produces `CODEMAP.md` with every function, its dependencies, and verification status. Works with any extraction pipeline.

### 2. Plan

`/fvs:plan` — Walk the dependency graph bottom-up to find optimal verification targets. Prioritizes leaf functions (no unverified dependencies) using greedy traversal. Performs deep Rust source analysis to reason about pre/post conditions and bounds.

### 3. Specify

`/fvs:lean-specify <function>` — Generate a specification skeleton for the target function. For Lean 4: uses the `@[progress] theorem fn_spec` pattern with preconditions from Rust source analysis and postconditions matching function behavior.

### 4. Verify

`/fvs:lean-verify <function>` — Attempt to prove the specification. For Lean 4: uses domain-specific tactics (`progress`, `simp`, `ring`, `field_simp`, `omega`). Reports proof status and remaining goals if incomplete.

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

## Acknowledgments

The architecture and plugin infrastructure of this project is heavily inspired by — and in parts directly adapted from — [Get Shit Done (GSD)](https://github.com/glittercowboy/get-shit-done). Thanks to the GSD maintainers for building such a solid foundation.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
