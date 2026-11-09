//! Window placement maths. Kept free of any windowing code so it can be unit tested.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

fn clamp(v: i32, lo: i32, hi: i32) -> i32 {
    if hi < lo { lo } else { v.clamp(lo, hi) } // larger than the area: pin to its top-left
}

/// Remembers the point a window grows and shrinks *around*, so repeated resizes (home -> results ->
/// home) always return to exactly where they started instead of creeping by a pixel each time.
#[derive(Default, Debug)]
pub struct Anchor {
    last: Option<(i32, i32)>,
    /// Twice the centre (kept doubled so odd sizes stay exact integers).
    centre2: (i32, i32),
}

impl Anchor {
    /// Top-left for a window of `nw` x `nh` that keeps the same centre as `old`, nudged to stay inside
    /// `area` (the monitor work area, which excludes the taskbar). If the user dragged the window since
    /// our last placement, the new centre is taken from where it is now.
    pub fn place(&mut self, old: Rect, nw: i32, nh: i32, area: Rect) -> (i32, i32) {
        let moved_by_user = match self.last {
            Some((x, y)) => (old.x - x).abs() > 2 || (old.y - y).abs() > 2,
            None => true,
        };
        if moved_by_user {
            self.centre2 = (2 * old.x + old.w, 2 * old.y + old.h);
        }
        let x = clamp((self.centre2.0 - nw).div_euclid(2), area.x, area.x + area.w - nw);
        let y = clamp((self.centre2.1 - nh).div_euclid(2), area.y, area.y + area.h - nh);
        self.last = Some((x, y));
        (x, y)
    }
}
