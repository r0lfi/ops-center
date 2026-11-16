//! Agent portraits: the web Ops Floor's 16×16 pixel figures
//! (frontend/src/components/ops-floor/AgentFigure.tsx and the LOOKS table in
//! office3d/geometry.ts). The Coordinator is Tux. Drawn with half blocks, two
//! pixels per terminal cell; keep both tables in step with the web page.

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};

pub const SIZE: usize = 16;
pub type Pixels = [[Option<Color>; SIZE]; SIZE];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Face {
    Plain,
    Glasses,
    Shades,
    Beard,
    Robot,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Extra {
    None,
    Headset,
    Antenna,
    RedHat,
    Cap,
    Beanie,
    Hood,
    Wizard,
}

struct Look {
    skin: u32,
    hair: u32,
    shirt: u32,
    face: Face,
    extra: Extra,
}

const fn look(skin: u32, hair: u32, shirt: u32, face: Face, extra: Extra) -> Look {
    Look {
        skin,
        hair,
        shirt,
        face,
        extra,
    }
}

const DEFAULT_LOOK: Look = look(0xd9a57c, 0x475569, 0x334155, Face::Plain, Extra::None);

fn look_of(slug: &str) -> Look {
    use Extra as E;
    use Face as F;
    match slug {
        "monitoring" => look(0xf0c8a0, 0x7c3aed, 0x334155, F::Glasses, E::Headset),
        "automation" => look(0x94a3b8, 0x64748b, 0x475569, F::Robot, E::Antenna),
        "linux" => look(0xe8b88f, 0x4a3324, 0x14532d, F::Beard, E::RedHat),
        "network" => look(0x8d5a3b, 0x0f0c0a, 0x0e7490, F::Plain, E::Cap),
        "container" => look(0xf0c8a0, 0xb45309, 0x1e40af, F::Glasses, E::Beanie),
        "security" => look(0xc99672, 0x0a0d12, 0x0b0f14, F::Shades, E::Hood),
        "patching" => look(0xe8b88f, 0xdc2626, 0x57534e, F::Plain, E::None),
        "chat" => look(0x8d5a3b, 0xec4899, 0x0f766e, F::Plain, E::Headset),
        "general" => look(0xf0c8a0, 0xe2e8f0, 0x581c87, F::Glasses, E::Wizard),
        "nova" => look(0xd9a57c, 0x15803d, 0x166534, F::Plain, E::Beanie),
        "ext-coordinator" => look(0xc99672, 0x111827, 0xf1f5f9, F::Glasses, E::None),
        "ext-coder" => look(0xf0c8a0, 0x0ea5e9, 0x111827, F::Glasses, E::Hood),
        "ext-reader" => look(0x8d5a3b, 0x1c1917, 0x7c2d12, F::Glasses, E::None),
        "ext-reviewer" => look(0xe8b88f, 0xf59e0b, 0x312e81, F::Plain, E::Cap),
        _ => DEFAULT_LOOK,
    }
}

const fn rgb(v: u32) -> Color {
    Color::Rgb((v >> 16) as u8, (v >> 8) as u8, v as u8)
}

const INK: u32 = 0x10151c;

struct Canvas(Pixels);

impl Canvas {
    /// Same as the web's `<R x y w h c>`: later rectangles paint over earlier.
    fn r(&mut self, x: usize, y: usize, w: usize, h: usize, c: u32) {
        for row in self.0.iter_mut().skip(y).take(h) {
            for px in row.iter_mut().skip(x).take(w) {
                *px = Some(rgb(c));
            }
        }
    }
}

/// The agent's portrait, pixel for pixel as on the web page.
pub fn pixels(slug: &str) -> Pixels {
    let mut p = Canvas([[None; SIZE]; SIZE]);
    if slug == "coordinator" {
        p.r(4, 2, 8, 13, 0x151a21);
        p.r(5, 8, 6, 6, 0xf1f5f9);
        p.r(5, 4, 2, 2, 0xf8fafc);
        p.r(9, 4, 2, 2, 0xf8fafc);
        p.r(6, 5, 1, 1, 0x050709);
        p.r(9, 5, 1, 1, 0x050709);
        p.r(7, 6, 2, 2, 0xf59e0b);
        p.r(3, 14, 4, 2, 0xf59e0b);
        p.r(9, 14, 4, 2, 0xf59e0b);
        return p.0;
    }
    let l = look_of(slug);
    let robot = slug == "automation";
    p.r(2, 12, 12, 4, l.shirt);
    p.r(4, 4, 8, 8, l.skin);
    if l.extra != Extra::Hood && !robot {
        p.r(4, 3, 8, 2, l.hair);
    }
    match l.face {
        Face::Plain => {
            p.r(6, 7, 1, 1, INK);
            p.r(9, 7, 1, 1, INK);
        }
        Face::Glasses => {
            p.r(5, 6, 2, 2, 0xbfe9ff);
            p.r(9, 6, 2, 2, 0xbfe9ff);
            p.r(4, 7, 8, 1, INK);
            p.r(6, 7, 1, 1, INK);
            p.r(9, 7, 1, 1, INK);
        }
        Face::Shades => {
            p.r(5, 6, 6, 2, 0x050709);
            p.r(6, 6, 1, 1, 0x38bdf8);
        }
        Face::Beard => {
            p.r(6, 6, 1, 1, INK);
            p.r(9, 6, 1, 1, INK);
            p.r(4, 9, 8, 3, l.hair);
        }
        Face::Robot => {
            p.r(5, 7, 2, 1, 0x38bdf8);
            p.r(9, 7, 2, 1, 0x38bdf8);
            p.r(6, 10, 4, 1, INK);
        }
    }
    match l.extra {
        Extra::None => {}
        Extra::RedHat => {
            p.r(3, 3, 10, 1, 0xb91c1c);
            p.r(5, 1, 6, 2, 0xdc2626);
        }
        Extra::Headset => {
            p.r(3, 7, 1, 3, 0x38bdf8);
            p.r(12, 7, 1, 3, 0x38bdf8);
            p.r(4, 2, 8, 1, 0x0d1218);
        }
        Extra::Beanie => p.r(4, 1, 8, 3, l.hair),
        Extra::Cap => {
            p.r(4, 2, 8, 2, l.hair);
            p.r(9, 4, 4, 1, l.hair);
        }
        Extra::Hood => {
            p.r(3, 2, 10, 3, l.shirt);
            p.r(3, 5, 1, 7, l.shirt);
            p.r(12, 5, 1, 7, l.shirt);
        }
        Extra::Wizard => {
            p.r(3, 3, 10, 1, 0x3b0764);
            p.r(5, 1, 6, 2, 0x3b0764);
            p.r(7, 0, 2, 1, 0x3b0764);
        }
        Extra::Antenna => {
            p.r(7, 1, 2, 3, 0x64748b);
            p.r(6, 0, 4, 1, 0x38bdf8);
        }
    }
    p.0
}

/// Scales the figure (columns 2..14, where all of it is drawn) down to
/// `w`×`h` pixels. Each target pixel takes its block's most common colour,
/// but a small detail such as an eye or Tux's beak wins its block, so faces
/// stay faces.
pub fn scaled(px: &Pixels, w: usize, h: usize) -> Vec<Vec<Option<Color>>> {
    const X0: usize = 2;
    const CW: usize = SIZE - 4;
    let mut area: Vec<(Color, usize)> = Vec::new();
    for c in px.iter().flatten().flatten() {
        match area.iter_mut().find(|a| a.0 == *c) {
            Some(a) => a.1 += 1,
            None => area.push((*c, 1)),
        }
    }
    let small = |c: Color| area.iter().any(|a| a.0 == c && a.1 <= 6);
    let span = |i: usize, n: usize, len: usize| {
        let a = i * len / n;
        (a, ((i + 1) * len / n).max(a + 1))
    };
    (0..h)
        .map(|y| {
            let (y0, y1) = span(y, h, SIZE);
            (0..w)
                .map(|x| {
                    let (x0, x1) = span(x, w, CW);
                    let mut seen: Vec<(Option<Color>, usize)> = Vec::new();
                    for row in &px[y0..y1] {
                        for &c in &row[X0 + x0..X0 + x1] {
                            if let Some(c) = c.filter(|c| small(*c)) {
                                return Some(c);
                            }
                            match seen.iter_mut().find(|s| s.0 == c) {
                                Some(s) => s.1 += 1,
                                None => seen.push((c, 1)),
                            }
                        }
                    }
                    // Ties go to colour over empty, then to the first seen.
                    seen.iter()
                        .enumerate()
                        .max_by_key(|(k, s)| (s.1, s.0.is_some(), usize::MAX - k))
                        .and_then(|(_, s)| s.0)
                })
                .collect()
        })
        .collect()
}

/// Rows of pixels as terminal lines: `▀` with the upper pixel as foreground
/// and the lower as background, so a cell holds two pixels.
pub fn lines(rows: &[Vec<Option<Color>>]) -> Vec<Line<'static>> {
    rows.chunks(2)
        .map(|pair| {
            let top = &pair[0];
            let low = pair.get(1);
            Line::from(
                (0..top.len())
                    .map(|x| {
                        let (a, b) = (top[x], low.and_then(|l| l[x]));
                        match (a, b) {
                            (None, None) => Span::raw(" "),
                            (Some(a), None) => Span::styled("▀", Style::new().fg(a)),
                            (None, Some(b)) => Span::styled("▄", Style::new().fg(b)),
                            (Some(a), Some(b)) => Span::styled("▀", Style::new().fg(a).bg(b)),
                        }
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .collect()
}

/// The role icon beside the name, one terminal cell wide. The web page uses
/// lucide icons (components/ai/AgentIdentity.tsx ICONS); these are text-only
/// stand-ins for the same roles, chosen to avoid emoji (double width).
pub fn role_icon(slug: &str) -> &'static str {
    match slug {
        "coordinator" => "⎇",     // GitBranch
        "monitoring" => "∿",      // Activity
        "linux" => "❯",           // Terminal
        "security" => "◈",        // ShieldCheck
        "network" => "⇄",         // Network
        "container" => "▣",       // Container
        "patching" => "⇡",        // PackageCheck
        "automation" => "⟳",      // Workflow
        "chat" => "❝",            // MessageSquare
        "general" => "⌕",         // FileSearch
        "nova" => "☻",            // UserRound
        "ext-coordinator" => "⋔", // Waypoints
        "ext-coder" => "λ",       // Code
        "ext-reader" => "▤",      // BookOpen
        "ext-reviewer" => "✓",    // ClipboardCheck
        _ => "◇",                 // Cpu
    }
}

/// Full portrait: 16 columns × 8 rows.
pub fn portrait(slug: &str) -> Vec<Line<'static>> {
    let px = pixels(slug);
    lines(&px.iter().map(|r| r.to_vec()).collect::<Vec<_>>())
}

/// Small portrait for cards: `rows` terminal rows, `cols` columns.
pub fn icon(slug: &str, cols: usize, rows: usize) -> Vec<Line<'static>> {
    lines(&scaled(&pixels(slug), cols, rows * 2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinator_is_tux_and_unknown_gets_default() {
        let tux = pixels("coordinator");
        assert_eq!(tux[6][7], Some(rgb(0xf59e0b)), "beak");
        assert_eq!(tux[0][0], None);
        let d = pixels("someone-new");
        assert_eq!(d[12][2], Some(rgb(0x334155)), "default shirt");
        assert_eq!(d[7][6], Some(rgb(INK)), "eye");
    }

    #[test]
    fn role_icons_are_one_cell() {
        for slug in [
            "coordinator",
            "monitoring",
            "linux",
            "security",
            "network",
            "container",
            "patching",
            "automation",
            "chat",
            "general",
            "nova",
            "ext-coordinator",
            "ext-coder",
            "ext-reader",
            "ext-reviewer",
            "someone-new",
        ] {
            assert_eq!(Line::from(role_icon(slug)).width(), 1, "{slug}");
        }
        assert_ne!(role_icon("linux"), role_icon("security"));
    }

    #[test]
    fn sizes() {
        assert_eq!(portrait("linux").len(), 8);
        assert_eq!(portrait("linux")[0].width(), 16);
        let i = icon("coordinator", 6, 3);
        assert_eq!(i.len(), 3);
        assert_eq!(i[0].width(), 6);
    }

    #[test]
    fn small_icon_keeps_the_eyes() {
        let s = scaled(&pixels("chat"), 6, 6);
        assert!(s.iter().flatten().any(|c| *c == Some(rgb(INK))));
    }
}
