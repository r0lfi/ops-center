//! Ops Floor, 2D plan. The rooms and seats of the web page scaled to the
//! terminal, with routes in Braille and work in motion as a moving packet.
//! Small terminals get the same floor as a list, room by room.

use super::*;
use crate::figure::role_icon;
use crate::floor::{self, Edge, Floor, FloorAgent, Flow, Motion, Status, Tone};
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::widgets::canvas::{Canvas, Line as CLine};
use std::collections::HashSet;

/// A polyline in canvas units.
type Path = Vec<(f64, f64)>;

const ROOM_BORDER: Color = Color::Rgb(44, 58, 96);
const ROUTE: Color = Color::Rgb(62, 74, 112);
const ROUTE_ON: Color = Color::Rgb(110, 120, 170);
/// Size of the small figure on a card: 4×4 pixels in half blocks, small
/// enough that every card with a border has room for it.
const ICON_W: u16 = 4;
const ICON_H: u16 = 2;

fn status_tone(a: &FloorAgent) -> Color {
    match (a.status, a.motion) {
        (Status::Error, _) => RED,
        (Status::Approval, _) => YELLOW,
        (Status::Paused, _) => DIM,
        (_, Motion::Completed) => GREEN,
        (_, Motion::Delegating | Motion::Reviewing) => CYAN,
        (Status::Working, _) => GREEN,
        (Status::Idle, _) => Color::Rgb(150, 160, 185),
    }
}

/// One glyph per status; a working agent's glyph turns once a second.
fn glyph(a: &FloorAgent, tick: u64) -> &'static str {
    match (a.status, a.motion) {
        (Status::Error, _) => "✕",
        (Status::Approval, _) => "!",
        (Status::Paused, _) => "‖",
        (_, Motion::Completed) => "✓",
        (Status::Working, _) => ["◐", "◓", "◑", "◒"][(tick % 4) as usize],
        (Status::Idle, _) => "○",
    }
}

fn cut(text: &str, w: usize) -> String {
    if text.chars().count() <= w {
        return text.to_string();
    }
    let mut out: String = text.chars().take(w.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn tick() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Agents the current filter and search keep bright; the rest are dimmed,
/// never moved.
fn bright(app: &App) -> HashSet<String> {
    app.agent_list()
        .into_iter()
        .map(|i| app.agents[i].slug.clone())
        .collect()
}

pub(super) fn draw_floor(f: &mut Frame, app: &mut App, area: Rect) {
    let floor = app.floor();
    let sel = app.floor_selected(&floor);
    let filter = AGENT_FILTERS[app.agent_filter];
    let mut t = format!("Ops Floor · 2D plan ({})", floor.agents.len());
    if filter != "all" {
        t.push_str(&format!(" · filter: {filter}"));
    }
    if !app.agent_query.is_empty() {
        t.push_str(&format!(" · \"{}\"", app.agent_query));
    }
    let block = panel(title("▦", t), true);
    let inner = block.inner(area);
    f.render_widget(block, area);
    app.hit_panels.push((area, 0));
    if floor.agents.is_empty() {
        f.render_widget(
            Paragraph::new(s(" No agents yet. Waiting for the first snapshot …", DIM)),
            inner,
        );
        return;
    }
    let [strip, body] = Layout::vertical([Constraint::Length(1), Constraint::Min(1)]).areas(inner);
    draw_strip(f, &floor, strip);

    let wide = body.width >= 130 && body.height >= 16;
    let (plan, detail) = if wide {
        let [p, d] = Layout::horizontal([Constraint::Min(80), Constraint::Length(44)]).areas(body);
        (p, d)
    } else {
        let h = if body.height >= 20 { 3 } else { 0 };
        let [p, d] = Layout::vertical([Constraint::Min(1), Constraint::Length(h)]).areas(body);
        (p, d)
    };
    let lit = bright(app);
    if plan.width < 84 || plan.height < 18 {
        draw_list(f, app, &floor, sel, &lit, plan);
    } else {
        draw_plan(f, app, &floor, sel, &lit, plan);
    }
    if let Some(i) = sel {
        if wide {
            draw_detail(f, app, &floor, i, detail);
        } else if detail.height > 0 {
            draw_summary(f, &floor.agents[i], detail);
        }
    }
}

fn draw_strip(f: &mut Frame, floor: &Floor, area: Rect) {
    let c = floor.counts();
    let part = |n: usize, label: &str, color: Color| {
        vec![
            b(format!(" {n}"), if n > 0 { color } else { DIM }),
            s(format!(" {label} "), DIM),
            s("│", BORDER),
        ]
    };
    let mut spans = Vec::new();
    spans.extend(part(c.needs, "need you", YELLOW));
    spans.extend(part(c.working, "working", GREEN));
    spans.extend(part(c.idle, "idle", TEXT));
    spans.extend(part(c.paused, "paused", TEXT));
    spans.extend(part(c.errors, "errors", RED));
    spans.extend(part(c.running, "running tasks", TEXT));
    spans.extend(part(c.queued, "queued", TEXT));
    if area.width >= 130 {
        spans.extend([
            s("  ── ", ROUTE_ON),
            s("route  ", DIM),
            s("── ", BLUE),
            s("in use  ", DIM),
            s("●→ ", CYAN),
            s("handing over", DIM),
        ]);
    }
    f.render_widget(Paragraph::new(Line::from(spans)), area);
}

/// World units to cells.
struct Scale {
    area: Rect,
    sx: f64,
    sy: f64,
}

impl Scale {
    fn x(&self, v: f64) -> u16 {
        self.area.x + (v * self.sx).round() as u16
    }
    fn y(&self, v: f64) -> u16 {
        self.area.y + (v * self.sy).round() as u16
    }
    fn rect(&self, r: &floor::Room) -> Rect {
        let (x0, y0) = (self.x(r.x), self.y(r.y));
        let (x1, y1) = (self.x(r.x + r.w), self.y(r.y + r.h));
        Rect::new(x0, y0, x1.saturating_sub(x0), y1.saturating_sub(y0)).intersection(self.area)
    }
}

fn draw_plan(
    f: &mut Frame,
    app: &mut App,
    floor: &Floor,
    sel: Option<usize>,
    lit: &HashSet<String>,
    area: Rect,
) {
    let sc = Scale {
        area,
        sx: area.width as f64 / floor::WORLD_WIDTH,
        sy: area.height as f64 / floor.layout.height,
    };
    // Cards first, as rectangles: the lines run between them.
    let mut cards: Vec<(usize, Rect)> = Vec::new();
    let mut rooms: Vec<(Rect, &floor::Room, usize)> = Vec::new();
    for r in &floor.layout.rooms {
        let members: Vec<usize> = (0..floor.agents.len())
            .filter(|i| floor.agents[*i].room == r.id)
            .collect();
        if members.is_empty() {
            continue;
        }
        let rect = sc.rect(r);
        let working = members
            .iter()
            .filter(|i| floor.agents[**i].status == Status::Working)
            .count();
        rooms.push((rect, r, working));
        let inside = Rect::new(
            rect.x + 1,
            rect.y + 1,
            rect.width.saturating_sub(2),
            rect.height.saturating_sub(2),
        );
        for i in members {
            let a = &floor.agents[i];
            let mut cw = ((104.0 * sc.sx).floor() as u16).clamp(8, 24);
            if a.seat.big {
                cw = ((140.0 * sc.sx).floor() as u16).clamp(10, 30);
            }
            let cw = cw.min(inside.width);
            let ch = ((150.0 * sc.sy).floor() as u16)
                .clamp(3, 5)
                .min(inside.height);
            let cx = sc.x(a.seat.x).saturating_sub(cw / 2);
            let cy = sc.y(a.seat.y).saturating_sub(ch / 2);
            let x = cx.clamp(inside.x, inside.right().saturating_sub(cw).max(inside.x));
            let y = cy.clamp(inside.y, inside.bottom().saturating_sub(ch).max(inside.y));
            cards.push((i, Rect::new(x, y, cw, ch)));
        }
        // Room for the agent's figure: every card one figure wider, its
        // neighbours in the room moved aside. Where the room is too narrow
        // for that, only the cards with free space beside them widen.
        let first = cards.len()
            - cards
                .iter()
                .rev()
                .take_while(|(i, _)| floor.agents[*i].room == r.id)
                .count();
        let room_cards: Vec<Rect> = cards[first..].iter().map(|(_, c)| *c).collect();
        let spread = [1, 0]
            .into_iter()
            .find_map(|gap| widen_all(&room_cards, inside, ICON_W + 1, gap));
        match spread {
            Some(v) => {
                for (k, c) in v.into_iter().enumerate() {
                    cards[first + k].1 = c;
                }
            }
            None => {
                for k in first..cards.len() {
                    let c = cards[k].1;
                    let wide = widen(c, inside, ICON_W + 1);
                    if cards
                        .iter()
                        .enumerate()
                        .all(|(j, (_, o))| j == k || !o.intersects(wide))
                    {
                        cards[k].1 = wide;
                    }
                }
            }
        }
    }
    let rect_of = |slug: &str| {
        cards
            .iter()
            .find(|(i, _)| floor.agents[*i].slug == slug)
            .map(|(_, r)| *r)
    };
    let selected = sel.map(|i| floor.agents[i].slug.as_str());
    let edges = floor::edges(&app.agents, &app.tasks, &floor.agents);
    let flows = floor::flows(&floor.agents, &app.live, std::time::Instant::now());
    let moving: HashSet<(&str, &str)> = flows
        .iter()
        .map(|fl| (fl.from.as_str(), fl.to.as_str()))
        .collect();
    let shown: Vec<&Edge> = edges
        .iter()
        .filter(|e| !moving.contains(&(e.from.as_str(), e.to.as_str())))
        .filter(|e| e.tone != Tone::Dim || selected == Some(&e.from) || selected == Some(&e.to))
        .collect();

    // 1. Lines, in Braille, under everything else.
    let center = |r: Rect| {
        (
            (r.x - area.x) as f64 + r.width as f64 / 2.0,
            area.height as f64 - ((r.y - area.y) as f64 + r.height as f64 / 2.0),
        )
    };
    let mut paths: Vec<(Path, Color)> = Vec::new();
    for e in &shown {
        let (Some(a), Some(b2)) = (rect_of(&e.from), rect_of(&e.to)) else {
            continue;
        };
        let on = selected == Some(&e.from) || selected == Some(&e.to);
        let color = match e.tone {
            Tone::Error => RED,
            Tone::Approval => YELLOW,
            Tone::Active => BLUE,
            Tone::Dim if on => ROUTE_ON,
            Tone::Dim => ROUTE,
        };
        paths.push((curve(center(a), center(b2)), color));
    }
    let mut packets: Vec<(Path, Rect, &Flow)> = Vec::new();
    for fl in &flows {
        let (Some(a), Some(b2)) = (rect_of(&fl.from), rect_of(&fl.to)) else {
            continue;
        };
        let p = curve(center(a), center(b2));
        paths.push((p.clone(), CYAN));
        packets.push((p, b2, fl));
    }
    let (w, h) = (area.width as f64, area.height as f64);
    f.render_widget(
        Canvas::default()
            .background_color(PANEL)
            .marker(ratatui::symbols::Marker::Braille)
            .x_bounds([0.0, w])
            .y_bounds([0.0, h])
            .paint(|ctx| {
                for (p, color) in &paths {
                    for seg in p.windows(2) {
                        ctx.draw(&CLine::new(seg[0].0, seg[0].1, seg[1].0, seg[1].1, *color));
                    }
                }
            }),
        area,
    );

    // 2. Rooms.
    for (rect, r, working) in &rooms {
        let mut t = vec![s(format!(" {} ", r.name), CYAN)];
        if *working > 0 && rect.width as usize > r.name.len() + 14 {
            t.push(s(format!("{working} working "), GREEN));
        }
        f.render_widget(
            Block::new()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::new().fg(ROOM_BORDER))
                .title(Line::from(t)),
            *rect,
        );
    }

    // 3. Cards.
    let tk = tick();
    app.hit_floor.clear();
    for (i, r) in &cards {
        let a = &floor.agents[*i];
        draw_card(f, a, *r, Some(*i) == sel, !lit.contains(&a.slug), tk);
        app.hit_floor.push((*r, a.slug.clone()));
    }

    // 4. Packets and arrowheads on top, just outside the target card.
    let buf = f.buffer_mut();
    for (p, target, fl) in &packets {
        let to_cell = |(x, y): (f64, f64)| {
            (
                area.x + x.floor().clamp(0.0, w - 1.0) as u16,
                area.y + (h - y).floor().clamp(0.0, h - 1.0) as u16,
            )
        };
        let outside: Vec<(u16, u16)> = p
            .iter()
            .map(|pt| to_cell(*pt))
            .filter(|(x, y)| !target.contains(Position { x: *x, y: *y }))
            .filter(|(x, y)| {
                !cards
                    .iter()
                    .any(|(_, r)| r.contains(Position { x: *x, y: *y }))
            })
            .collect();
        if let Some(&(x, y)) = outside.last() {
            let tip = p.last().copied().unwrap_or_default();
            let at = p[p.len().saturating_sub(4)];
            let (dx, dy) = (tip.0 - at.0, tip.1 - at.1);
            let arrow = if dx.abs() * 0.5 > dy.abs() {
                if dx > 0.0 {
                    "▶"
                } else {
                    "◀"
                }
            } else if dy > 0.0 {
                "▲"
            } else {
                "▼"
            };
            put(buf, x, y, arrow, CYAN);
        }
        if !outside.is_empty() {
            // Four steps a second-tick cycle: out on delegated, back on returned.
            let k = outside.len() * (tk % 4) as usize / 4;
            let (x, y) = outside[k.min(outside.len() - 1)];
            put(buf, x, y, "●", if fl.delegate { CYAN } else { GREEN });
        }
    }
}

fn put(buf: &mut Buffer, x: u16, y: u16, sym: &str, color: Color) {
    if buf.area.contains(Position { x, y }) {
        buf[(x, y)].set_symbol(sym).set_fg(color);
    }
}

/// An S-curve between two points (vertical bends cross far less than
/// straight lines), as a polyline.
fn curve(a: (f64, f64), b: (f64, f64)) -> Path {
    let mid = (a.1 + b.1) / 2.0;
    let (p1, p2) = ((a.0, mid), (b.0, mid));
    (0..=24)
        .map(|k| {
            let t = k as f64 / 24.0;
            let u = 1.0 - t;
            let c = |p0: f64, q1: f64, q2: f64, p3: f64| {
                u * u * u * p0 + 3.0 * u * u * t * q1 + 3.0 * u * t * t * q2 + t * t * t * p3
            };
            (c(a.0, p1.0, p2.0, b.0), c(a.1, p1.1, p2.1, b.1))
        })
        .collect()
}

/// `c` made `by` columns wider around its centre, kept inside `inside`.
fn widen(c: Rect, inside: Rect, by: u16) -> Rect {
    let w = (c.width + by).min(inside.width);
    let x =
        c.x.saturating_sub((w - c.width) / 2)
            .clamp(inside.x, inside.right().saturating_sub(w).max(inside.x));
    Rect::new(x, c.y, w, c.height)
}

/// All cards widened, then moved apart along their rows (at least `gap`
/// columns between cards that share rows) and back inside the room. None
/// when they do not fit.
fn widen_all(cards: &[Rect], inside: Rect, by: u16, gap: u16) -> Option<Vec<Rect>> {
    let mut v: Vec<Rect> = cards.iter().map(|c| widen(*c, inside, by)).collect();
    let rows = |a: &Rect, b: &Rect| a.y < b.bottom() && b.y < a.bottom();
    let mut order: Vec<usize> = (0..v.len()).collect();
    order.sort_by_key(|k| (cards[*k].x, cards[*k].y));
    // Left to right: push each card past the ones before it.
    for (n, &k) in order.iter().enumerate() {
        let min = order[..n]
            .iter()
            .filter(|j| rows(&v[**j], &v[k]))
            .map(|j| v[*j].right() + gap)
            .max()
            .unwrap_or(inside.x);
        v[k].x = v[k].x.max(min);
    }
    // Right to left: pull back what went past the room's edge.
    for (n, &k) in order.iter().enumerate().rev() {
        let max = order[n + 1..]
            .iter()
            .filter(|j| rows(&v[**j], &v[k]))
            .map(|j| v[*j].x.saturating_sub(gap))
            .chain([inside.right()])
            .min()
            .unwrap_or(inside.right());
        v[k].x = v[k].x.min(max.saturating_sub(v[k].width));
    }
    let fits = v.iter().enumerate().all(|(k, c)| {
        c.x >= inside.x
            && c.right() <= inside.right()
            && v[k + 1..].iter().all(|o| !o.intersects(*c))
    });
    fits.then_some(v)
}

fn draw_card(f: &mut Frame, a: &FloorAgent, r: Rect, picked: bool, dim: bool, tk: u64) {
    let tone = if dim { DIM } else { status_tone(a) };
    let text = if dim { DIM } else { TEXT };
    let bg = if picked { SEL } else { PANEL };
    let w = r.width as usize;
    let status = Line::from(vec![
        s(format!("{} ", glyph(a, tk)), tone),
        s(cut(a.label(), w.saturating_sub(4)), tone),
    ]);
    let detail_fg = if a.status == Status::Approval && !dim {
        YELLOW
    } else {
        DIM
    };
    let detail = Line::from(s(cut(&a.detail(), w.saturating_sub(2)), detail_fg));
    f.render_widget(Clear, r);
    // The agent's figure from the web Ops Floor, left of the status lines:
    // inside the border, or under the name on cards too low for one.
    let framed = r.height >= 4;
    let body = if framed {
        Rect::new(
            r.x + 1,
            r.y + 1,
            r.width.saturating_sub(2),
            r.height.saturating_sub(2),
        )
    } else {
        Rect::new(r.x, r.y + 1, r.width, r.height.saturating_sub(1))
    };
    // Beside the status lines where the card is wide enough, otherwise
    // under the status line where it is tall enough.
    let with_icon = body.height >= ICON_H && body.width >= ICON_W + 1 + 6;
    let below = !with_icon && body.height > ICON_H && body.width >= ICON_W;
    let (status, detail) = if with_icon {
        let tw = (body.width - ICON_W - 1) as usize;
        (
            Line::from(vec![
                s(format!("{} ", glyph(a, tk)), tone),
                s(cut(a.label(), tw.saturating_sub(2)), tone),
            ]),
            Line::from(s(cut(&a.detail(), tw), detail_fg)),
        )
    } else {
        (status, detail)
    };
    let role = s(
        format!("{} ", role_icon(&a.slug)),
        if dim { DIM } else { CYAN },
    );
    if framed {
        let mut block = Block::new()
            .borders(Borders::ALL)
            .border_type(if picked {
                BorderType::Thick
            } else {
                BorderType::Rounded
            })
            .border_style(Style::new().fg(if picked { ACCENT } else { tone }))
            .style(Style::new().bg(bg))
            .title(Line::from(vec![
                role,
                b(cut(&a.short, w.saturating_sub(4)), text),
            ]));
        let count = match (a.running, a.queued, a.pending) {
            (_, _, p) if p > 0 => Some(format!("{p} waiting")),
            (0, 0, _) => None,
            (r, 0, _) => Some(format!("{r} run")),
            (r, q, _) => Some(format!("{r} run·{q} q")),
        };
        if let Some(c) = count.filter(|c| c.chars().count() + 2 <= w) {
            block = block.title_bottom(Line::from(s(c, tone)).alignment(Alignment::Right));
        }
        f.render_widget(block, r);
    } else {
        let name = Line::from(vec![
            role,
            b(
                cut(&a.short, w.saturating_sub(2)),
                if picked { ACCENT } else { text },
            ),
        ]);
        f.render_widget(Paragraph::new(name).style(Style::new().bg(bg)), r);
    }
    if with_icon {
        let icon = Rect::new(body.x, body.y, ICON_W, ICON_H);
        let rest = Rect::new(
            body.x + ICON_W + 1,
            body.y,
            body.width - ICON_W - 1,
            body.height,
        );
        let lines = crate::figure::icon(&a.slug, ICON_W as usize, ICON_H as usize);
        if dim {
            f.render_widget(Paragraph::new(lines).style(Style::new().fg(DIM)), icon);
        } else {
            f.render_widget(Paragraph::new(lines), icon);
        }
        f.render_widget(Paragraph::new(vec![status, detail]), rest);
    } else if below {
        f.render_widget(Paragraph::new(status), body);
        let icon = Rect::new(body.x, body.y + 1, ICON_W, ICON_H);
        let lines = crate::figure::icon(&a.slug, ICON_W as usize, ICON_H as usize);
        if dim {
            f.render_widget(Paragraph::new(lines).style(Style::new().fg(DIM)), icon);
        } else {
            f.render_widget(Paragraph::new(lines), icon);
        }
        let tw = body.width.saturating_sub(ICON_W + 1);
        if tw >= 4 {
            f.render_widget(
                Paragraph::new(Line::from(s(cut(&a.detail(), tw as usize), detail_fg))),
                Rect::new(body.x + ICON_W + 1, body.y + 1, tw, 1),
            );
        }
    } else if body.width >= 2 + 1 + 6 {
        // Too low for the figure: a 2×2 pixel version before the status.
        let icon = Rect::new(body.x, body.y, 2, 1);
        let lines = crate::figure::icon(&a.slug, 2, 1);
        if dim {
            f.render_widget(Paragraph::new(lines).style(Style::new().fg(DIM)), icon);
        } else {
            f.render_widget(Paragraph::new(lines), icon);
        }
        let tw = (body.width - 3) as usize;
        let status = Line::from(vec![
            s(format!("{} ", glyph(a, tk)), tone),
            s(cut(a.label(), tw.saturating_sub(2)), tone),
        ]);
        let detail = Line::from(s(cut(&a.detail(), tw), detail_fg));
        f.render_widget(
            Paragraph::new(vec![status, detail]),
            Rect::new(body.x + 3, body.y, body.width - 3, body.height),
        );
    } else {
        f.render_widget(Paragraph::new(vec![status, detail]), body);
    }
}

fn draw_list(
    f: &mut Frame,
    app: &mut App,
    floor: &Floor,
    sel: Option<usize>,
    lit: &HashSet<String>,
    area: Rect,
) {
    let tk = tick();
    let mut lines: Vec<(Line<'static>, Option<String>)> = Vec::new();
    let order = floor.order();
    let mut room = "";
    for i in order {
        let a = &floor.agents[i];
        if a.room != room {
            room = a.room;
            let name = floor
                .layout
                .rooms
                .iter()
                .find(|r| r.id == room)
                .map_or(room, |r| r.name);
            lines.push((Line::from(b(format!(" {name}"), CYAN)), None));
        }
        let dim = !lit.contains(&a.slug);
        let tone = if dim { DIM } else { status_tone(a) };
        let nw = 14.min(area.width as usize / 4);
        let mut l = Line::from(vec![
            s(if Some(i) == sel { " ▸ " } else { "   " }, ACCENT),
            s(format!("{} ", glyph(a, tk)), tone),
            s(
                format!("{} ", role_icon(&a.slug)),
                if dim { DIM } else { CYAN },
            ),
            b(
                format!("{:<nw$} ", cut(&a.short, nw)),
                if dim { DIM } else { TEXT },
            ),
            s(format!("{:<18} ", a.label()), tone),
            s(a.detail(), DIM),
        ]);
        if Some(i) == sel {
            l = l.style(Style::new().bg(SEL));
        }
        lines.push((l, Some(a.slug.clone())));
    }
    let at = lines
        .iter()
        .position(|(_, slug)| slug.is_some() && sel.map(|i| &floor.agents[i].slug) == slug.as_ref())
        .unwrap_or(0);
    let skip = at.saturating_sub(area.height.saturating_sub(1) as usize);
    app.hit_floor.clear();
    for (row, (_, slug)) in lines
        .iter()
        .skip(skip)
        .take(area.height as usize)
        .enumerate()
    {
        if let Some(slug) = slug {
            app.hit_floor.push((
                Rect::new(area.x, area.y + row as u16, area.width, 1),
                slug.clone(),
            ));
        }
    }
    let shown: Vec<Line> = lines.into_iter().skip(skip).map(|(l, _)| l).collect();
    f.render_widget(Paragraph::new(shown), area);
}

fn draw_summary(f: &mut Frame, a: &FloorAgent, area: Rect) {
    let tone = status_tone(a);
    let lines = vec![
        Line::from(vec![
            b(format!(" {} ", a.name), TEXT),
            s(format!("· {} ", a.label()), tone),
            s(
                format!("· {} running · {} queued", a.running, a.queued),
                DIM,
            ),
        ]),
        Line::from(s(format!(" {}", a.detail()), DIM)),
        Line::from(s(
            " Enter open · a approvals · m message · n task · l logs · x stop",
            DIM,
        )),
    ];
    f.render_widget(
        Paragraph::new(lines).block(
            Block::new()
                .borders(Borders::TOP)
                .border_style(Style::new().fg(BORDER)),
        ),
        area,
    );
}

fn draw_detail(f: &mut Frame, app: &App, floor: &Floor, i: usize, area: Rect) {
    let a = &floor.agents[i];
    let agent = &app.agents[a.index];
    let tone = status_tone(a);
    let w = area.width.saturating_sub(4) as usize;
    let room = floor
        .layout
        .rooms
        .iter()
        .find(|r| r.id == a.room)
        .map_or(a.room, |r| r.name);
    let row = |k: &str, v: String, c: Color| Line::from(vec![s(format!(" {k:<9}"), DIM), s(v, c)]);
    // The full portrait, as on the web page, with the essentials beside it.
    let side = w.saturating_sub(17);
    let beside = [
        Line::from(vec![
            s(format!("{} ", role_icon(&a.slug)), CYAN),
            b(cut(&a.name, side.saturating_sub(2)), TEXT),
        ]),
        Line::from(s(cut(a.label(), side), tone)),
        Line::from(s(cut(room, side), DIM)),
        Line::from(s(
            cut(
                &format!("{} running · {} queued", a.running, a.queued),
                side,
            ),
            TEXT,
        )),
    ];
    let mut lines: Vec<Line> = crate::figure::portrait(&a.slug)
        .into_iter()
        .enumerate()
        .map(|(k, mut l)| {
            l.spans.insert(0, Span::raw(" "));
            if let Some(x) = k.checked_sub(2).and_then(|k| beside.get(k)) {
                l.spans.push(Span::raw("  "));
                l.spans.extend(x.spans.iter().cloned());
            }
            l
        })
        .collect();
    let name = |slug: &str| {
        app.agents
            .iter()
            .find(|x| x.slug == slug)
            .map_or(slug.to_string(), |x| x.name.clone())
    };
    match (a.motion, &a.peer) {
        (Motion::Delegating, Some(p)) => {
            lines.push(row("Handing", format!("work to {}", name(p)), CYAN))
        }
        (Motion::Reviewing, Some(p)) => {
            lines.push(row("Results", format!("from {}", name(p)), CYAN))
        }
        _ => {}
    }
    if let Some(t) = &a.tool {
        lines.push(row("Tool", t.clone(), BLUE));
    }
    if let Some(t) = &a.target {
        lines.push(row("Target", t.clone(), TEXT));
    }
    lines.push(Line::default());
    for l in wrap(&a.detail(), w.max(10)) {
        lines.push(Line::from(s(format!(" {l}"), TEXT)));
    }
    if a.pending > 0 {
        lines.push(Line::default());
        lines.push(Line::from(b(
            format!(" {} waiting for you", a.pending),
            YELLOW,
        )));
        for x in app
            .actions
            .iter()
            .filter(|x| x.agent_id == agent.id && !app.decided.contains(&x.id))
        {
            lines.push(Line::from(vec![
                s(format!("  {} ", x.request_code), DIM),
                s(cut(&x.tool, w.saturating_sub(16)), TEXT),
                s(
                    format!(" L{} {}", x.approval_level, x.risk),
                    status_color(&x.risk),
                ),
            ]));
        }
        lines.push(Line::from(s("  a or Enter opens it in Approvals", DIM)));
    }
    if a.status == Status::Error {
        if let Some(e) = &agent.error_message {
            lines.push(Line::default());
            for l in wrap(&crate::mask::mask(e), w.max(10)).into_iter().take(4) {
                lines.push(Line::from(s(format!(" {l}"), RED)));
            }
        }
    }
    let routes: Vec<String> = match &agent.allowed_dispatch_targets {
        Some(t) => t.iter().map(|x| name(x)).collect(),
        None if agent.slug == "coordinator" => vec!["every shared agent".into()],
        None => vec![],
    };
    if !routes.is_empty() {
        lines.push(Line::default());
        lines.push(Line::from(s(" Can hand work to", DIM)));
        for l in wrap(&routes.join(", "), w.max(10)) {
            lines.push(Line::from(s(format!(" {l}"), TEXT)));
        }
    }
    let recent: Vec<&Logged> = app
        .events
        .iter()
        .rev()
        .filter(|l| l.ev.agent == a.slug || l.ev.peer.as_deref() == Some(&a.slug))
        .take(6)
        .collect();
    if !recent.is_empty() {
        lines.push(Line::default());
        lines.push(Line::from(s(" Recent", DIM)));
        for l in recent {
            lines.push(Line::from(vec![
                s(format!(" {} ", time(l.at)), DIM),
                s(cut(&l.ev.describe(), w.saturating_sub(9)), TEXT),
            ]));
        }
    }
    let block = panel(
        Line::from(vec![
            s(format!(" {} ", glyph(a, tick())), tone),
            b(format!("{} ", a.name), TEXT),
        ]),
        false,
    )
    .title_bottom(Line::from(s(" Enter open · m msg · n task · l logs ", DIM)));
    f.render_widget(Paragraph::new(lines).block(block), area);
}
