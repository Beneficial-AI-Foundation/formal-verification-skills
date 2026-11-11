import M1demo
import Specs
open Lean

/-! Import discovery for the Lean constants oracle: every module in the import
closure of the roots above, the compiled file Lean resolves for it (findOLean)
and which of its data parts exist (.olean, .olean.server, .olean.private),
which a non-module importer loads. -/

def discover : CoreM Json := do
  let env ← getEnv
  let mut rows : Array Json := #[]
  for mod in env.header.moduleNames do
    let olean ← findOLean mod
    let mut parts : Array String := #[]
    for suffix in ["", ".server", ".private"] do
      let file : System.FilePath := ⟨olean.toString ++ suffix⟩
      if ← file.pathExists then parts := parts.push suffix
    rows := rows.push <| Json.mkObj [("module", toJson mod), ("olean", toJson olean.toString), ("parts", toJson parts)]
  return Json.arr rows

#eval show CoreM Unit from do
  IO.println (← discover).compress
