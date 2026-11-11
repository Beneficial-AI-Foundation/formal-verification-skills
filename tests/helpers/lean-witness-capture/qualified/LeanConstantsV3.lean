import M1demo
import Specs
open Lean

/-! Lean constants extractor, fvs/lean-constants version 2, extractor v3 (body only; the
harness adds schema, producer and inputs). For every constant declared in a
project module: kernel kind, module, whether Lean has a declaration range
for it (evidence only; source status comes from the bound .ilean files), structure and projection facts, kernel family links, structure
fields resolved to their projection functions, the constants its type and its
value mention (separately; theorem proofs included), and, for definitions,
theorems and opaque constants, the axioms Lean.collectAxioms reports. Also the
environment's imported module names, for comparison with discovery, and every
constant a lane names outside the project with the module Lean records for it,
so a missing project constant is never mistaken for an external one. -/

def projectRoots : List Name := [`M1demo, `Specs]

def isProjectModule (m : Name) : Bool := projectRoots.contains m.getRoot

def kindOf : ConstantInfo → String
  | .axiomInfo _ => "axiom"
  | .defnInfo _ => "def"
  | .thmInfo _ => "theorem"
  | .opaqueInfo _ => "opaque"
  | .quotInfo _ => "quot"
  | .inductInfo _ => "inductive"
  | .ctorInfo _ => "ctor"
  | .recInfo _ => "recursor"

def moduleOf (env : Environment) (nm : Name) : Option Name :=
  (env.getModuleIdxFor? nm).map fun idx => env.header.moduleNames[idx.toNat]!

def extract : CoreM Json := do
  let env ← getEnv
  let mut own : Array (Name × ConstantInfo) := #[]
  for pair in env.constants.map₁.toList do
    if (moduleOf env pair.1).any isProjectModule then own := own.push pair
  let mut nodes : Array Json := #[]
  for (nm, info) in own do
    let typeUses := info.type.getUsedConstants
    let valueUses := ((info.value? (allowOpaque := true)).map (·.getUsedConstants)).getD #[]
    let ranges ← findDeclarationRanges? nm
    let family : List (String × Json) := match info with
      | .inductInfo v =>
        let recursors := own.filterMap fun (r, ri) => match ri with
          | .recInfo rv => if rv.all.contains nm then some r else none
          | _ => none
        [("family", Json.mkObj [("ctors", toJson v.ctors), ("recursors", toJson recursors)])]
      | .ctorInfo v => [("family", Json.mkObj [("inductive", toJson v.induct)])]
      | .recInfo v => [("family", Json.mkObj [("inductives", toJson v.all)])]
      | _ => []
    let fields : List (String × Json) :=
      if isStructure env nm then
        [("fields", Json.arr ((getStructureFields env nm).map fun f =>
          Json.mkObj [("field", toJson f), ("projection", toJson (getProjFnForField? env nm f))]))]
      else []
    let axioms ← match info with
      | .defnInfo _ | .thmInfo _ | .opaqueInfo _ => do pure [("axioms", toJson (← collectAxioms nm))]
      | _ => pure []
    nodes := nodes.push <| Json.mkObj ([
      ("name", toJson nm), ("module", toJson (moduleOf env nm)), ("kind", toJson (kindOf info)),
      ("hasDeclarationRange", toJson ranges.isSome), ("isStructure", toJson (isStructure env nm)),
      ("isProjection", toJson (env.isProjectionFn nm)),
      ("isClass", toJson (isClass env nm)), ("isInstance", toJson (Meta.isInstanceCore env nm)),
      ("type", toJson typeUses), ("value", toJson valueUses)] ++ family ++ fields ++ axioms)
  let ownNames : NameSet := own.foldl (fun acc p => acc.insert p.1) {}
  let mut seen : NameSet := {}
  let mut referenced : Array Json := #[]
  for p in own do
    let info := p.2
    let uses := info.type.getUsedConstants ++ ((info.value? (allowOpaque := true)).map (·.getUsedConstants)).getD #[]
    for c in uses do
      unless ownNames.contains c || seen.contains c do
        seen := seen.insert c
        referenced := referenced.push <| Json.mkObj [("name", toJson c), ("module", toJson (moduleOf env c))]
  return Json.mkObj [("nodes", Json.arr nodes), ("referenced", Json.arr referenced), ("moduleNames", toJson env.header.moduleNames)]

#eval show CoreM Unit from do
  IO.println (← extract).compress
