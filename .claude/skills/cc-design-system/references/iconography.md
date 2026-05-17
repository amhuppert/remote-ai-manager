# Iconography

Defaults, sizing, the canonical icon set, unicode-glyph rules, and the substitution policy.

---

## Defaults

- **Inline SVG by default.** Every functional icon is hand-drawn (or lifted from Lucide and tuned) as an inline `<svg>` with:
  - `stroke="currentColor"`
  - `stroke-width: 1.5`
  - `stroke-linecap: square`
  - `stroke-linejoin: miter`
  - no fill
  - 20–24px viewBox
- **Exceptions for shape-fill icons** — the filled diamond for Codex identity, the filled star for pinned items.
- **currentcolor inheritance** — icons pick up the parent text color: `--text-secondary` at rest, `--cyan` on hover for primary actions, semantic accents (`--amber` filled star, `--red` close-destructive) where meaning applies.
- **Inline next to a label** — when an icon sits next to text (e.g. `Context` in the info strip), match cap-height: 14–16px at the body's font-size, with a 6–8px gap.
- **Tooltips for icon-only buttons** — every icon-only control needs both `aria-label` and a `data-tooltip`.

---

## Sizing

**Icon-to-button ratio: 60%.**

| Container | Button size | Icon size |
|---|---|---|
| Desktop icon-button | 30px | 18px |
| Mobile touch target | 44px | 26px |

Minimum visual icon size: **20px** (`--icon-size-min`).

---

## Canonical set

The icon set covers:

**copy, success, refresh, close, back, forward, menu, settings (cog), star (pin on/off), plus (new), search, filter, chevron-down, terminal, claude-diamond, codex-diamond, return (⏎), arrow-up (send), trash.**

Before adding a new icon, check this list. Most actions already have a glyph.

---

## Unicode glyphs — typographic marks only

Permitted:

| Glyph | Codepoint | Use |
|---|---|---|
| `✓` | U+2713 | Inline confirmation token ("Copied ✓"). Not a button. |
| `‹` `›` | U+2039 / U+203A | Chevrons inside breadcrumb / label runs of text. |
| `/` | — | Breadcrumb separator (`--text-tertiary`). |
| `—` | — | Em-dash for null temporal values. |
| `⌘ ⇧ ⌥ ⌃ ↵` | — | Keyboard glyphs in shortcut hints (e.g. `⌘↵ send`). |

**Forbidden as functional icons.** Use the canonical SVG set instead:

| Glyph | Replace with |
|---|---|
| `⎘` | copy SVG |
| `☰` | menu SVG |
| `★` / `☆` | star (pin) SVG |
| `⟲` | refresh SVG |

**No emoji. No PNG icons. No color icons. Ever.**

---

## Substitution policy

When an icon isn't in the canonical set, prefer in this order:

1. **A hand-drawn 1.5-stroke SVG** matching the existing set's stroke weight, cap, join, and viewBox.
2. **Lucide** — closest match for stroke weight and minimal feel; tune to 1.5 stroke if needed. **Flag substitutions in handoff notes** so the canonical set can absorb them later.
3. **A unicode glyph** — only if the icon is truly typographic (e.g. arithmetic, currency).

Never introduce filled glyph systems (Material, Heroicons-solid), emoji, or color icons.

---

## Asset locations

Pre-built SVG assets ship with the design system:

- `assets/cc-logo.svg` — `CC` wordmark, Anybody 800, cyan, with canonical text-shadow glow baked in as an SVG filter.
- `assets/cc-favicon.svg` — square favicon mark.
- `assets/icon-cog.svg` — system-cog used in chrome.
- `assets/icon-layout-*.svg` — layout-switcher schematic rectangles (`conversation`, `default`, `split`, `diff`).
