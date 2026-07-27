import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/ui/cn";

export type StatusChipTone =
  | "neutral"
  | "cyan"
  | "amber"
  | "green"
  | "red"
  | "violet";

// solid = bordered tone pill (the status-list default). flat = borderless tone
// fill (chips that read as a filled accent, no rim). ghost = a neutral, dashed,
// transparent affordance that promotes to cyan on hover (an "empty"/"add"
// action that reads as inert until touched) — ghost owns its own colours and
// ignores `tone`.
export type StatusChipAppearance = "solid" | "flat" | "ghost";

// The pill shape shared by every chip: mono, 0.7rem, full radius. The border
// shape and the border/background/text colours live in the appearance + tone
// maps below (never here) so no two applied utilities target one property
// unconditionally. Line-wrapping is the one geometry axis a consumer picks
// (short status labels stay on one line; long inheritance/capability text wraps
// inside its row), so it lives on the primitive rather than leaking
// `overflow-wrap` through `layoutClassName`.
const base =
  "inline-flex items-center gap-[4px] rounded-full px-[8px] py-[2px] font-mono text-[0.7rem] font-medium leading-[1.3]";
const nowrapClass = "whitespace-nowrap";
const wrapClass = "[overflow-wrap:anywhere]";

// `neutral` is the muted default (subtle border, tertiary text); the accent
// tones pair a translucent border with the matching glow fill and accent text.
// Every tone names a background: Preflight is off, so a tone that left it unset
// would inherit the UA `buttonface` fill on the `as="button"` chip.
const toneClass: Record<StatusChipTone, string> = {
  neutral: "border-border-subtle bg-transparent text-text-tertiary",
  cyan: "border-[var(--cc-cyan-a25)] bg-cyan-glow text-cyan",
  amber: "border-[var(--cc-amber-a25)] bg-amber-glow text-amber",
  green: "border-[var(--cc-green-a20)] bg-green-glow text-green",
  red: "border-[var(--cc-red-a40)] bg-red-glow text-red",
  violet: "border-[var(--cc-codex-violet-a35)] bg-violet-glow text-violet",
};

// solid/flat own only the border SHAPE (colours come from the tone map). ghost
// is self-contained — its own border/bg/text/hover — so the tone map is not
// applied when appearance is ghost.
const GHOST_CLASS =
  "border border-dashed border-border-default bg-transparent text-text-secondary hover:border-cyan hover:text-cyan";
const appearanceClass: Record<StatusChipAppearance, string> = {
  solid: "border border-solid",
  flat: "border-0",
  ghost: GHOST_CLASS,
};

interface StatusChipCommon {
  tone?: StatusChipTone;
  /**
   * Border/fill recipe. `solid` (default) is the bordered tone pill; `flat`
   * drops the border for a filled accent; `ghost` is a neutral dashed
   * transparent affordance that ignores `tone` and promotes to cyan on hover.
   */
  appearance?: StatusChipAppearance;
  /** Wrap long content inside the row instead of forcing a single line. */
  wrap?: boolean;
  /** Leading glyph or spinner rendered before the label. */
  icon?: ReactNode;
  children: ReactNode;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
}

type StatusChipSpanProps = StatusChipCommon &
  Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style" | "children"> & {
    as?: "span";
  };

type StatusChipButtonProps = StatusChipCommon &
  Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "className" | "style" | "children"
  > & {
    /** Renders an interactive chip (adds the focus ring + pointer). */
    as: "button";
  };

export type StatusChipProps = StatusChipSpanProps | StatusChipButtonProps;

const interactive =
  "cursor-pointer transition-colors duration-150 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

// ghost is self-coloured, so it does not additionally apply the tone triple —
// that would double up border/bg/text utilities. solid/flat take their colours
// from the tone map on top of the appearance's border shape.
function shapeAndTone(
  appearance: StatusChipAppearance,
  tone: StatusChipTone,
): string {
  return appearance === "ghost"
    ? appearanceClass.ghost
    : cn(appearanceClass[appearance], toneClass[tone]);
}

export function StatusChip(props: StatusChipProps): React.JSX.Element {
  if (props.as === "button") {
    const {
      as,
      tone = "neutral",
      appearance = "solid",
      wrap = false,
      icon,
      children,
      layoutClassName,
      ...rest
    } = props;
    void as;
    return (
      <button
        {...rest}
        type={rest.type ?? "button"}
        data-tone={tone}
        data-appearance={appearance}
        className={cn(
          base,
          wrap ? wrapClass : nowrapClass,
          shapeAndTone(appearance, tone),
          interactive,
          layoutClassName,
        )}
      >
        {icon}
        {children}
      </button>
    );
  }

  const {
    as,
    tone = "neutral",
    appearance = "solid",
    wrap = false,
    icon,
    children,
    layoutClassName,
    ...rest
  } = props;
  void as;
  return (
    <span
      {...rest}
      data-tone={tone}
      data-appearance={appearance}
      className={cn(
        base,
        wrap ? wrapClass : nowrapClass,
        shapeAndTone(appearance, tone),
        layoutClassName,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
