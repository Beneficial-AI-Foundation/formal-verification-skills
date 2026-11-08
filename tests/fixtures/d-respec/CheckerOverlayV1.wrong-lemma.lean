import M1demo.M1demo
open Aeneas Aeneas.Std Result

namespace m1demo.overlay.v1

/-- Revised contract for `helper` (node 19): its result is the checked `u32` sum of the two fields. -/
def helperSpec (p : m1demo.Pair) : Result Std.U32 := p.a + p.b

-- Deliberately failing first attempt: the commutativity lemma does not exist.
theorem helper_eq_spec (p : m1demo.Pair) : m1demo.helper p = helperSpec p := by
  simp [m1demo.helper_add_comm]

end m1demo.overlay.v1
