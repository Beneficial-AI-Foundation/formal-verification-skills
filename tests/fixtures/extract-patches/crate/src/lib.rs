//! Fixture crate for the patch-mode extraction engine tests.

pub mod limits;

pub fn double(x: u32) -> u32 {
    x.wrapping_add(x)
}

pub fn sum(xs: &[u32]) -> u32 {
    xs.iter().fold(0, |acc, x| acc.wrapping_add(*x))
}
