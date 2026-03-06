<overview>

Model profile system for FVS subagent dispatch. Controls which models are used for
research vs execution subagents across the four main commands. Configuration is stored
in `.formalising/fvs-config.json` per project.

Three profiles:
- **quality** -- best results, highest cost. Default. Recommended for formal verification where correctness matters more than speed.
- **balanced** -- good results, moderate cost. Suitable for iterative development cycles.
- **budget** -- fastest, lowest cost. Suitable for exploration and mapping tasks.

Commands read the active profile at dispatch time and resolve the model for each
subagent before calling Task(). The profile table below defines the mapping.

</overview>

<quick_reference>

## Profile Table

| Agent                    | quality | balanced | budget |
|--------------------------|---------|----------|--------|
| fvs-researcher           | inherit | sonnet   | haiku  |
| fvs-executor             | inherit | sonnet   | sonnet |
| fvs-explainer            | inherit | sonnet   | haiku  |
| fvs-dependency-analyzer  | sonnet  | haiku    | haiku  |
| fvs-code-reader          | sonnet  | sonnet   | haiku  |

Quality uses `inherit` (= parent model, typically Opus) for the agents that matter most:
researcher, executor, and explainer. These handle spec generation, proof attempts, and
NL explanation — tasks where reasoning quality directly impacts correctness.

## Resolution

`inherit` means the subagent uses the same model as the parent command. This avoids
organization policy conflicts that can occur with explicit model name references. When
a command dispatches with `model="inherit"`, the Task() system uses whatever model is
currently running the parent.

For non-inherit values, the model name is passed directly to Task() as the `model`
parameter.

## Config File

**Location:** `.formalising/fvs-config.json`

```json
{
  "model_profile": "quality",
  "model_overrides": {}
}
```

The config file is optional. If it does not exist, commands default to the `quality`
profile.

### Overriding Specific Agents

Use `model_overrides` to change the model for a single agent without switching the
entire profile:

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "fvs-lean-prover": "inherit"
  }
}
```

This runs most agents at balanced tier but keeps the prover at inherit (parent model)
for maximum proof quality.

### Valid Override Values

- `"inherit"` -- use parent model
- `"sonnet"` -- Claude Sonnet
- `"haiku"` -- Claude Haiku

</quick_reference>

<patterns>

## Dispatch Pattern

Commands resolve the model for each subagent dispatch using this sequence:

1. Read `.formalising/fvs-config.json` (or use defaults if file is missing)
2. Determine the active profile: `config.model_profile` or `"quality"` if unset
3. Check `config.model_overrides` for the target agent name
4. If no override, look up the profile table for the agent and profile
5. Pass the resolved model to the Task() call

```
// In command workflow:

// 1. Read config (graceful default)
config = read .formalising/fvs-config.json
if config missing:
  config = { model_profile: "quality", model_overrides: {} }

profile = config.model_profile || "quality"

// 2. Resolve model for target agent
if agent_name in config.model_overrides:
  model = config.model_overrides[agent_name]
else:
  model = PROFILE_TABLE[agent_name][profile]

// 3. Dispatch subagent
Task(
  subagent_type = agent_name,
  model = model,
  description = "...",
  prompt = "..."
)
```

## Graceful Defaults

- **Config file missing:** Use `quality` profile. Do not create the file automatically.
- **Unknown agent name:** Use `inherit`. New agents default to parent model.
- **Invalid profile name:** Fall back to `quality` with a warning.
- **Empty overrides:** Ignored. Equivalent to no overrides.

## Two-Phase Dispatch

Each main command dispatches two subagents in sequence:

```
/fvs:map-code
  -> Task(fvs-researcher, model=resolve("fvs-researcher"), research_mode="map-code")
  -> Task(fvs-executor,   model=resolve("fvs-executor"),   execution_mode="map-code")

/fvs:plan
  -> Task(fvs-researcher, model=resolve("fvs-researcher"), research_mode="plan")
  -> Task(fvs-executor,   model=resolve("fvs-executor"),   execution_mode="plan")

/fvs:lean-specify
  -> Task(fvs-researcher, model=resolve("fvs-researcher"), research_mode="spec-generation")
  -> Task(fvs-executor,   model=resolve("fvs-executor"),   execution_mode="spec-generation")

/fvs:lean-verify
  -> Task(fvs-researcher, model=resolve("fvs-researcher"), research_mode="proof-attempt")
  -> Task(fvs-executor,   model=resolve("fvs-executor"),   execution_mode="proof-attempt")
```

The researcher gathers context (read-only), the executor writes files based on findings.

</patterns>

<runtime_models>

## Runtime-Specific Model Handling

Model selection works differently across runtimes. Commands should only use `Task(model=...)`
on runtimes that support it.

### Claude Code

Supports inline model selection via `Task(model="...")`. The profile system works natively:
- `"inherit"` — subagent uses the parent session's model (typically Opus)
- `"sonnet"` — Claude Sonnet
- `"haiku"` — Claude Haiku

### Codex

Does NOT support dynamic model selection. Models are pre-configured per agent in `.toml`
files at install time. The `Task(model="...")` parameter is omitted when converting commands
to Codex skills. Model choice is determined by the Codex configuration, not by FVS.

### OpenCode / Gemini CLI

Similar to Claude Code — support inline model parameters with runtime-specific model name
mappings. The same `Task(model="...")` pattern applies.

### Implication for Commands

Commands should resolve the model from the profile table and pass it to `Task()`. On runtimes
that don't support dynamic model selection (Codex), the parameter is silently ignored. This
means the same command files work across all runtimes without conditional logic.

</runtime_models>

<anti_patterns>

## Anti-Patterns

- **Hardcoding "opus" in profile table:** Use `inherit` instead. Organization policies may restrict model access. `inherit` defers to whatever the parent is running.
- **Creating fvs-config.json automatically:** The file is user-created. Commands use defaults when it is missing.
- **Ignoring overrides:** Always check `model_overrides` before the profile table. User overrides take precedence.
- **Dispatching without resolution:** Never pass a profile name ("quality") as the model. Always resolve to a concrete model name or "inherit" first.

</anti_patterns>

<summary>

The model profile system gives users control over cost/quality tradeoffs across all FVS
subagent dispatches. The quality profile (default) uses inherit for top-tier agents and
sonnet for utility agents. The balanced and budget profiles progressively reduce model
capability for cost savings. Per-agent overrides allow fine-grained control without
switching the entire profile.

</summary>
