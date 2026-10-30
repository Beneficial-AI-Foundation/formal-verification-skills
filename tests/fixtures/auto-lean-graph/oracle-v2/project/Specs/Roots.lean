import M1demo.M1demo
open Aeneas Aeneas.Std Result

namespace m1demo.roots

/-- `root_sum` is the shared helper. -/
theorem root_sum_eq (p : m1demo.Pair) : m1demo.root_sum p = m1demo.helper p := rfl

/-- `root_twice` doubles the shared helper's result. -/
theorem root_twice_eq (p : m1demo.Pair) :
    m1demo.root_twice p = (do let i ← m1demo.helper p; i * 2#u32) := rfl

end m1demo.roots
