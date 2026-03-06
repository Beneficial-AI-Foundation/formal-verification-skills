<purpose>
Orchestrate verification planning from CODEMAP.md to produce a prioritized
verification plan.

Uses a two-phase subagent dispatch: fvs-researcher gathers verification state and
analyzes targets (read-only), then fvs-executor writes the structured PLAN.md file.

Output: .formalising/PLAN.md with prioritized targets, and user-selected target
ready for /fvs:lean-specify.
</purpose>

<process>

<step name="check_codemap">
Verify CODEMAP.md exists and is current.

```bash
[ -f .formalising/CODEMAP.md ] && echo "CODEMAP found" || echo "CODEMAP missing"
```

**If missing:**
```
CODEMAP.md not found. Run /fvs:map-code first to analyze the project.

Alternatively, specify a function directly:
  /fvs:lean-specify function_name
```

Warn but allow user to skip if they want to specify a target manually.

**If found:** Parse function inventory and dependency graph from CODEMAP.md.
</step>

<step name="resolve_models">
Read `.formalising/fvs-config.json` for model profile configuration.

If config exists: extract `model_profile` and `model_overrides`.
If config missing: default to `quality` profile with no overrides.

Resolve models for both subagents using the profile table
(see fv-skills/references/model-profiles.md):

- `fvs-researcher`: quality=inherit, balanced=sonnet, budget=haiku
- `fvs-executor`: quality=inherit, balanced=sonnet, budget=sonnet

Check `model_overrides` for per-agent overrides before using profile defaults.

Reference: @fv-skills/references/model-profiles.md (dispatch pattern, resolution sequence)
</step>

<step name="research_phase">
Dispatch **fvs-researcher** in plan mode (read-only analysis).

Read reference files for inlining into the Task() prompt:
- aeneas-patterns.md (dependency patterns, naming conventions)
- lean-spec-conventions.md (spec naming, what makes good targets)
- proof-strategies.md (for understanding verification difficulty)

Also inline:
- CODEMAP.md content (function inventory and dependency graph)
- List of existing spec files

These are INLINED because @-references do NOT cross Task() boundaries.

Agent inputs (all inlined in prompt):
- CODEMAP.md function inventory and dependency graph
- List of existing spec files in Specs/
- aeneas-patterns.md content
- lean-spec-conventions.md content
- proof-strategies.md content

Expected outputs:
- Verification state per function (verified, in-progress, unspecified)
- Topological sort of unverified functions
- "Ready now" set: leaves and functions with all deps verified
- "Blocked" set: functions waiting on dependency verification
- Complexity/leverage/risk evaluation for top candidates
- Functions with existing stubs in .formalising/stubs/

Agent returns with `## RESEARCH COMPLETE` containing structured `<findings>`,
`<relevant_files>`, and `<recommendations>` sections.

Reference: @fv-skills/references/aeneas-patterns.md (dependency patterns)
Reference: @fv-skills/references/lean-spec-conventions.md (what makes a good spec target)
</step>

<step name="execution_phase">
Dispatch **fvs-executor** in plan mode with research findings.

Agent inputs (all inlined in prompt):
- Complete research findings from fvs-researcher output
- No additional reference files needed (researcher already processed them)

The executor writes `.formalising/PLAN.md` with:

```markdown
# Verification Plan

## Progress
- Verified: [V] functions
- In progress: [P] functions
- Unspecified: [U] functions
- Total: [T] functions

## Priority Targets
| # | Function | Complexity | Leverage | Risk | Status | Notes |
|---|----------|------------|----------|------|--------|-------|

## Recommended Order
[Bottom-up verification sequence]

## Blocked Functions
[Functions waiting on dependency verification, with blocker names]
```

Agent returns with `## EXECUTION COMPLETE` confirming files written.
All writes use the Write tool (VS Code diffs) for user approval.
</step>

<step name="present_plan">
Display prioritized verification targets for user selection.

```
FVS >> PLAN COMPLETE

Status: [V] [OK] / [P] [??] / [U] [--] of [T] total

Ready to verify (dependencies satisfied):

  #  Function                  Complexity  Leverage  Risk
  1. scalar_mul_inner          Low         High      Low
  2. point_validate            Low         Medium    Low
  3. field_add                 Low         Low       Low
  4. batch_normalize           Medium      High      Medium
  ...

Blocked (need dependency specs first):
  [!!] multi_scalar_mul (needs: scalar_mul_inner, point_add)
  [!!] verify_signature (needs: hash_to_curve, scalar_mul)

Written: .formalising/PLAN.md

---

Select a target number, or type a function name directly.
```

Wait for user selection. Store selected target for use by /fvs:lean-specify.

After selection, suggest next command:
```
Target selected: {function_name}

>> Next Up

/fvs:lean-specify {function_name}
```
</step>

</process>

<success_criteria>
- CODEMAP.md loaded and parsed (or user warned if missing)
- Model profile resolved from config or quality default
- fvs-researcher dispatched with inlined references, returns verification analysis
- fvs-executor dispatched with research findings, writes .formalising/PLAN.md
- Prioritized list presented with clear selection interface
- User selects target, next command suggested
</success_criteria>
