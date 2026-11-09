import M1demo.M1demo
open Aeneas Aeneas.Std Result

namespace m1demo.overlay.v1

/-- Revised contract for `helper` (node 19): its result is the checked `u32` sum of the two fields. -/
def helperSpec (p : m1demo.Pair) : Result Std.U32 := p.a + p.b

/-- Node 19's revised statement, stated exactly as its reviewed contract. -/
theorem helper_eq_sum (p : m1demo.Pair) : m1demo.helper p = p.a + p.b := rfl

/-- The same fact through the named specification, for consumers of the revision. -/
theorem helper_eq_spec (p : m1demo.Pair) : m1demo.helper p = helperSpec p := rfl

end m1demo.overlay.v1
