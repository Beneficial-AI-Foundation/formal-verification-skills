<purpose>
Orchestrate specification generation for a single Lean function.

Takes a verification target (function name), analyzes it deeply via Rust source
and Lean translation, checks dependency spec status, and generates a .lean spec
file with the correct structure and a sorry placeholder for the proof.

Output: Specs/{path}/{function_name}_spec.lean with theorem statement and sorry.
</purpose>

<process>

<step name="resolve_target">
Accept function name and resolve to concrete paths.

**Input:** Function name (Lean name or Rust name).

```bash
# Search in CODEMAP.md if available
grep -i "$TARGET" CODEMAP.md 2>/dev/null

# Search directly in Funs.lean
grep "def ${TARGET}" $(find . -name "Funs.lean" -not -path "./.lake/*" | head -1) 2>/dev/null
```

**Resolve:**
- Full Lean qualified name (e.g., `MyProject.my_module.my_function`)
- Path to containing Funs.lean
- Function signature (args and return type)
- Output spec path: `Specs/{module_path}/{function_name}_spec.lean`

**If function not found:**
```
Function "$TARGET" not found in Funs.lean.

Did you mean one of these?
[fuzzy matches from function inventory]

Or run /fvs:map-code to refresh the function index.
```

Wait for user clarification.
</step>

<step name="analyze_function">
Dispatch **fvs-code-reader** for deep analysis of the target function.

Agent inputs:
- Lean function body from Funs.lean
- Rust source function (if available)
- Types referenced by the function from Types.lean

Expected outputs:
- **Control flow**: Branches, loops, early returns (mapped to Result in Lean)
- **Type dependencies**: Structs/enums used, their Lean representations
- **Arithmetic operations**: Field ops, scalar ops, bitwise (for tactic selection)
- **Error paths**: Which branches produce Error vs Ok
- **Postcondition candidates**: What properties should the spec assert?

Reference: @fv-skills/references/aeneas-patterns.md (type translation patterns)
Reference: @fv-skills/references/lean-spec-conventions.md (postcondition patterns)
</step>

<step name="check_dependencies">
Verify dependency specs are available.

From the dependency graph (CODEMAP.md or re-analysis), identify callees:

```bash
# Check each dependency for existing spec
for dep in $DEPENDENCIES; do
  SPEC=$(find Specs/ -name "${dep}*_spec.lean" 2>/dev/null | head -1)
  if [ -n "$SPEC" ]; then
    SORRY=$(grep -c "sorry" "$SPEC" 2>/dev/null || echo 0)
    echo "FOUND: $dep (sorry=$SORRY)"
  else
    echo "MISSING: $dep"
  fi
done
```

**If dependencies lack specs:**
```
Warning: These dependency functions do not have specs yet:
  - dep_function_a (called 2x in target)
  - dep_function_b (called 1x in target)

The spec can still be written, but the proof may need these specs later.
Options:
1. Continue anyway (proof will use sorry for dependency lemmas)
2. Specify a dependency first (/fvs:lean-specify dep_function_a)
```

Warn but allow user to continue.
</step>

<step name="generate_spec">
Dispatch **fvs-spec-generator** to produce the specification file.

Agent inputs:
- Function analysis from step 2
- Dependency spec status from step 3
- Template: @fv-skills/templates/spec-file.lean

**Spec structure requirements:**
- Correct module path and imports (Types, Funs, dependencies)
- `open` declarations for relevant namespaces
- `@[progress]` attribute on theorem
- Theorem name: `{function_name}_spec`
- Existential form: `exists result, fn args = ok result /\ postconditions`
- `sorry` as proof placeholder
- Comments explaining postcondition intent

**Write spec file:**
```bash
mkdir -p Specs/{module_path}
```

Write to `Specs/{module_path}/{function_name}_spec.lean`.

Reference: @fv-skills/references/lean-spec-conventions.md (naming, structure, attributes)
Reference: @fv-skills/references/aeneas-patterns.md (import patterns, Result types)
</step>

<step name="validate_spec">
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
FVS -- SPEC GENERATED

Function: {lean_qualified_name}
Spec file: Specs/{path}/{function_name}_spec.lean
Postconditions: [summary of what the spec asserts]
Dependencies: [N] specs found, [M] missing
Status: Ready for verification (contains sorry)

---

Next: /fvs:lean-verify Specs/{path}/{function_name}_spec.lean
```
</step>

</process>

<success_criteria>
- Target function resolved to Lean name and Funs.lean location
- Deep analysis of function body, types, and control flow completed
- Dependency specs checked with clear status report
- Spec file generated with correct imports, @[progress], existential form, sorry
- Spec file written to Specs/ directory with proper path structure
- Optional build check confirms spec compiles (with sorry warning expected)
- Clear next step offered to user
</success_criteria>
