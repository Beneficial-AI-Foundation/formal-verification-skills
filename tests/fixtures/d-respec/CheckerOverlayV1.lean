import M1demo.M1demo
open Aeneas Aeneas.Std Result

namespace m1demo.overlay.v1

/-- Revised contract for `helper` (node 19): its result is the checked `u32` sum of the two fields. -/
def helperSpec (p : m1demo.Pair) : Result Std.U32 := p.a + p.b

theorem helper_eq_spec (p : m1demo.Pair) : m1demo.helper p = helperSpec p := rfl

end m1demo.overlay.v1
