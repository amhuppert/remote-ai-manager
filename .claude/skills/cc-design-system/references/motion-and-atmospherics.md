# Motion & Atmospherics

Animation timing, live-state pulses, atmospheric overlays, frosted glass, shadows, glows, transparency, and the rainbow gradient surfaces.

---

## Atmospheric overlays

Two always-on fixed pseudo-elements with `pointer-events: none`, applied to `body`:

| Layer | Recipe | z-index |
|---|---|---|
| Noise grain | SVG `feTurbulence` at `opacity: 0.025`, 256×256 tile | 9999 |
| Scan lines | `repeating-linear-gradient(transparent 0px, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)` | 9998 |

These are the only "atmosphere" — never reach for background images, gradients-as-fill, parallax effects, or texture patterns.

---

## Backgrounds

- **No images. No gradients as background fill.** The void color sits flat under everything.
- **Linear gradients are used sparingly** as accent flourishes:
  - 2px cyan top-edge gradient on hovered project cards.
  - Amber/cyan separator gradient between pinned and unpinned sections.
  - Never as content backgrounds.

---

## Frosted glass (chrome only)

Topbar and mobile bottom bar:

```css
background: rgba(11, 16, 25, 0.85);
backdrop-filter: blur(16px) saturate(140%);
```

Modal overlay:

```css
background: rgba(6, 9, 15, 0.8);
```

Modal overlays use a flat semi-transparent fill (no `backdrop-filter`). Live blur on a fullscreen overlay forces a per-frame GPU recomposite of the underlying view, which starves the main thread's input dispatch queue whenever the overlay's contents (e.g. a textarea) are typed in. Use opacity to communicate "behind glass" instead.

**Never frost content surfaces** — cards, panels, transcripts, sidebars all stay opaque.

---

## Shadows & glows

### Outer drop shadows — subtle and dark

| Surface | Shadow |
|---|---|
| Hovered cards | `0 4px 16px -4px rgba(0, 0, 0, 0.4)` |
| Popovers & menus | `0 8px 24px rgba(0, 0, 0, 0.35)` |

### The brand "glow"

Always a colored `box-shadow` with low opacity. Never a saturated drop shadow.

- Glow opacity range: `0.10–0.30`.
- Higher opacity (`0.25–0.30`) reserved for hover/active states.
- Glow colors come from accent token families: `--cyan-glow`, `--cyan-glow-strong`, `--amber-glow`, `--green-glow`, `--blue-glow`, `--red-glow`, `--violet-glow`, `--violet-glow-strong`.

### Inner shadow

Used on the active project card to read as "lit from the cyan border edge":

```css
box-shadow: inset 3px 0 8px -4px rgba(0, 229, 255, 0.15);
```

### Borders

- 1px solid from the 4-step intensity scale (`--border-dim/subtle/default/strong`).
- Hover bumps to `--border-strong`.
- Never thicker than 1px, except diff lines (3px left-border encoding add / remove / context).

---

## Animation

### Timing curves

| Curve | Use |
|---|---|
| `0.15s ease` | Interactions: hover, focus, button press. |
| `0.20s ease` | Entries: `fadeIn`, `slideUp`. |
| `0.25s ease` | Layout transitions, bottom-sheet `slideUpSheet`. |

**No bouncy easing.** No spring overshoot. No long animations. No parallax. No gratuitous motion.

### Live-state animations

| Animation | Surface | Duration |
|---|---|---|
| `pulse-dot` | Status dots on live states (running, awaiting) | 2.5s |
| `pulse-border` | Prompt input in sending state | — |
| `voice-recording-pulse` | Microphone button | — |

Idle status uses `--text-tertiary` with no glow and no animation.

### Stagger reveals

`.stagger-in` parents animate up to 8 children in 50ms increments using `staggerReveal` (8px translateY + opacity).

### Motion principles

- **Press uses background, not transform.** Cards do `translateY(-1px)` on hover, then return to 0. The only positional motion in the system.
- **State communicated by background**, never by scale or transform.

---

## Rainbow gradient (`.cc-rainbow-*` surfaces only)

Reserved for **max-class reasoning effort**. Never use rainbow for anything else — it signals "exceeds the scale" precisely because it doesn't belong to any single agent or status.

### Tokens

| Token | Value |
|---|---|
| `--rainbow-gradient` | 6-stop: `#ff6b6b → #ffa500 → #ffd93d → #6bcb77 → #4d96ff → #9b59b6 → loop` |
| `--rainbow-tint` | low-alpha (~0.10–0.14) for tinted backgrounds |
| `--rainbow-glow` | `rgba(155, 89, 182, 0.15)` — violet halo |
| `--rainbow-glow-strong` | `rgba(155, 89, 182, 0.25)` — hover halo |
| `--rainbow-glow-blue` | `rgba(77, 150, 255, 0.08)` — secondary halo |

### Surfaces

| Class | Use |
|---|---|
| `.cc-rainbow-text` | Gradient-clipped text, 700 weight. |
| `.cc-rainbow-border` | Animated border + soft violet/blue halo. |

### Animation

- `3s linear infinite`.
- **Held still under `prefers-reduced-motion`.**

---

## `prefers-reduced-motion`

- Rainbow gradient holds still (no animation; gradient still renders as a static visual).
- Live-state animations (`pulse-dot`, `pulse-border`, `voice-recording-pulse`) degrade to static.
- Entry animations (`fadeIn`, `slideUp`, `staggerReveal`) can be reduced to instant or to opacity-only — never block the user.
- Card `translateY(-1px)` hover is acceptable to keep; it's a single 1px motion and conveys hover affordance.
