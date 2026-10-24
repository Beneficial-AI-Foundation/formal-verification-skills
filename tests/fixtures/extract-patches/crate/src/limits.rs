use core::cmp::min;

pub fn clamp(x: u32) -> u32 {
    min(x, 100)
}

pub fn halve(x: u32) -> u32 {
    x / 2
}
