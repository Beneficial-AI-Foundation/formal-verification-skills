<purpose>
Orchestrate specification generation for a single Lean function using two-phase
subagent dispatch (research -> execute).

Takes a verification target (function name), dispatches fvs-researcher to gather
context (Funs.lean, Types.lean, Rust source, existing stubs, similar specs), then
dispatches fvs-executor to write the spec file.

Output: Specs/{path}/{FunctionName}.lean with @[progress] theorem and sorry placeholder.
</purpose>

<process>

<step name="resolve_target">
Accept function name and resolve to concrete paths.

**Input:** Function name (Lean name or Rust name).

```bash
# Search in CODEMAP.md if available
grep -i "$TARGET" .formalising/CODEMAP.md 2>/dev/null

# Search directly in Funs.lean
grep "def ${TARGET}" $(find . -name "Funs.lean" -not -path "./.lake/*" | head -1) 2>/dev/null
```

**Resolve:**
- Full Lean qualified name (e.g., `MyProject.my_module.my_function`)
- Path to containing Funs.lean
- Function signature (args and return type)
- Output spec path: `Specs/{module_path}/{FunctionName}.lean`

**If function not found:**
```
Function "$TARGET" not found in Funs.lean.

Did you mean one of these?
[fuzzy matches from function inventory]

Or run /fvs:map-code to refresh the function index.
```

Wait for user clarification.
</step>

<step name="resolve_models">
Read config and resolve models for subagent dispatch.

```bash
CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null || echo '{"model_profile":"quality","model_overrides":{}}')
```

Resolution sequence:
1. Parse `model_profile` from config (default: `"quality"`)
2. Check `model_overrides` for `"fvs-researcher"` and `"fvs-executor"`
3. If no override, look up profile table for the agent and profile
4. Store resolved models as `RESEARCH_MODEL` and `EXECUTOR_MODEL`

Reference: fv-skills/references/model-profiles.md (profile table and dispatch pattern)
</step>

<step name="research_phase">
Dispatch **fvs-researcher** subagent in spec-generation mode to gather all context.

Read and inline reference files before dispatch:
- fv-skills/references/aeneas-patterns.md (type translation patterns)
- fv-skills/references/lean-spec-conventions.md (postcondition patterns)

Researcher tasks:
1. Read target function body from Funs.lean
2. Read Types.lean for type dependencies used in the function
3. Find Rust source for bounds analysis and pre/post conditions
4. Check .formalising/stubs/ for existing NL explanation (if exists, use it!)
5. Find similar verified specs in Specs/ directory for patterns to follow
6. Determine the correct output path: Specs/{module_path}/{FunctionName}.lean

Expected output: Structured findings with function analysis, type context, postcondition
candidates, similar specs, and dependency status. Ends with `## RESEARCH COMPLETE`.

**If researcher returns ## ERROR:** Display the error and stop.
</step>

<step name="execute_phase">
Dispatch **fvs-executor** subagent in spec-generation mode to write the spec file.

Inline into executor prompt:
- Research findings from previous step
- Spec file template (fv-skills/templates/spec-file.lean)
- Target output path

**Spec structure requirements:**
- Correct module path and imports (Types, Funs, dependencies)
- `open` declarations for relevant namespaces
- `@[progress]` attribute on theorem
- Existential form: `exists result, fn args = ok result /\ postconditions`
- Array types use `(Array U64 5#usize)` notation
- Interpretation functions where applicable
- `sorry` as proof placeholder
- Comments explaining postcondition intent

Executor writes the spec file using the Write tool (VS Code diff).
User approves the diff inline.

Expected output: Ends with `## EXECUTION COMPLETE`.

**If executor returns ## ERROR:** Display the error and stop.
</step>

<step name="validate_and_report">
Validate the generated spec meets structural requirements.

**Checklist:**
- [ ] File exists at expected path
- [ ] Has correct Lean imports (project Types, Funs modules)
- [ ] Has `@[progress]` attribute on main theorem
- [ ] Theorem uses existential form with `sorry`
- [ ] Module path matches project namespace
- [ ] No references to non-existent spec files

**Optional build check:**
```bash
nice -n 19 lake build 2>&1 | tail -20
```

If build fails on import errors: fix imports and re-validate.
If build fails on type errors: review generated spec against actual signatures.
Build warnings about `sorry` are expected and correct at this stage.

**Report result:**
```
FVS >> GENERATING SPEC

Function: {lean_qualified_name}
Spec file: Specs/{path}/{FunctionName}.lean
Postconditions: [summary of what the spec asserts]
Dependencies: [N] specs found, [M] missing
Status: [??] Ready for verification (contains sorry)

---

Next: /fvs:lean-verify Specs/{path}/{FunctionName}.lean
```
</step>

</process>

<success_criteria>
- Target function resolved to Lean name and Funs.lean location
- Config read and models resolved for fvs-researcher and fvs-executor
- Research subagent gathered context: function body, types, stubs, similar specs
- Executor subagent wrote spec file with correct structure and sorry placeholder
- Spec file written to Specs/ directory via VS Code diff
- Optional build check confirms spec compiles (with sorry warning expected)
- Clear next step offered to user
</success_criteria>
