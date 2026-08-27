import type {
  BackendModelParameterDefinition,
  BackendModelParameterValueEmphasis,
  BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import { cn } from "@/lib/ui/cn";

/** Stable provider-neutral parameter summary for compact read-only surfaces. */
export function modelSelectionParametersLabel(
  selection: BackendModelSelection,
): string {
  return Object.entries(selection.parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([parameter, value]) => `${parameter}=${value}`)
    .join(", ");
}

/**
 * The catalog's presentation weight for a parameter value. Selection surfaces
 * read this instead of testing values themselves — the catalog owns which tiers
 * exceed a provider's normal scale, so the same control renders correctly for
 * `xhigh`, `extra-high`, `max`, and whatever a future refresh introduces.
 */
export function parameterValueEmphasis(
  parameter: BackendModelParameterDefinition,
  value: string | undefined,
): BackendModelParameterValueEmphasis | undefined {
  return parameter.values.find((candidate) => candidate.value === value)
    ?.emphasis;
}

/**
 * The design system's "exceeds the scale" rainbow treatment. It is reserved for
 * catalog values marked `exceeds-scale` and nothing else, which is why the two
 * recipes live beside the model-selection presentation helpers rather than in a
 * general UI module: rainbow is only reachable from here.
 *
 * Reduced motion halts the gradient scroll; the gradient itself still renders.
 */

/**
 * Geometry for a rainbow `SelectTrigger asChild` variant — the canonical trigger
 * box minus the border/background/open-ring the rainbow replaces. `asChild` is
 * the Select primitive's sanctioned escape hatch for exactly this control.
 */
export const RAINBOW_TRIGGER_BASE_CLASS = cn(
  "group inline-flex h-9 cursor-pointer items-center gap-[6px] rounded-md border border-solid px-3 font-mono text-[0.72rem] font-medium whitespace-nowrap transition-all duration-150 ease-[ease] outline-none max-768:h-[44px]",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]",
  "disabled:cursor-not-allowed disabled:opacity-40",
);

/**
 * Animated gradient border + violet/blue halo. The background MUST be expressed
 * as `background-image`/`-size`/`-clip`/`-origin` longhands rather than the
 * `background` shorthand: Tailwind emits the shorthand AFTER the longhands, so it
 * would reset size to `auto` and clip to `border-box`, breaking the 200% scroll
 * animation and the per-layer clipping.
 */
export const RAINBOW_TRIGGER_CLASS = cn(
  "border-transparent",
  "[background-image:var(--rainbow-tint),linear-gradient(var(--bg-surface),var(--bg-surface)),var(--rainbow-gradient)]",
  "[background-origin:padding-box,padding-box,border-box]",
  "[background-clip:padding-box,padding-box,border-box]",
  "[background-size:200%_auto,100%_100%,200%_auto]",
  "motion-safe:animate-[rainbow-border-shift_3s_linear_infinite]",
  "shadow-[0_0_8px_var(--rainbow-glow),0_0_20px_var(--rainbow-glow-blue)]",
  "hover:shadow-[0_0_12px_var(--rainbow-glow-strong),0_0_24px_var(--cc-rainbow-glow-blue-a15)]",
  "data-[state=open]:shadow-[0_0_0_3px_var(--rainbow-glow),0_0_14px_var(--cc-rainbow-glow-violet-a15)]",
);

/**
 * Gradient-clipped label text. `background-image` longhand (not the `background`
 * shorthand) so Tailwind cannot reset `background-clip: text` back to
 * `border-box` — without the clip the transparent text fill renders the label
 * invisible instead of rainbow-coloured.
 */
export const RAINBOW_TEXT_CLASS = cn(
  "[background-image:var(--rainbow-gradient)] [background-size:200%_auto]",
  "[-webkit-background-clip:text] [background-clip:text] [-webkit-text-fill-color:transparent]",
  "font-bold motion-safe:animate-[rainbow-shift_3s_linear_infinite]",
);
