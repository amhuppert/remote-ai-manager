import type { HTMLAttributes } from "react";
import { cn } from "@/lib/ui/cn";

export type BadgeTier = "status" | "type" | "count";
export type BadgeStatus =
  | "idle"
  | "running"
  | "active"
  | "merged"
  | "ready"
  | "awaiting"
  | "warning";
export type BadgeKind =
  | "feature"
  | "bug"
  | "idea"
  | "research"
  | "tech_debt"
  | "performance";
export type BadgeBackend = "claude" | "codex";

const base =
  "inline-flex items-center justify-center font-mono text-[0.7rem] font-semibold px-[8px] py-[2px] rounded-full whitespace-nowrap leading-[1.3]";

const statusAppearance: Record<BadgeStatus, string> = {
  idle: "bg-bg-raised text-text-secondary",
  running: "bg-cyan-glow text-cyan shadow-[0_0_6px_var(--color-cyan-glow)]",
  active: "bg-cyan-glow text-cyan shadow-[0_0_6px_var(--color-cyan-glow)]",
  merged: "bg-green-glow text-green",
  ready: "bg-green-glow text-green",
  awaiting: "bg-amber-glow text-amber",
  warning: "bg-amber-glow text-amber",
};

const typeAppearance: Record<BadgeKind, string> = {
  feature: "bg-cyan-glow text-cyan",
  bug: "bg-red-glow text-red",
  idea: "bg-amber-glow text-amber",
  research: "bg-violet-glow text-violet",
  tech_debt: "bg-amber-glow text-amber",
  performance: "bg-green-glow text-green",
};

const countAppearance = {
  default: "bg-bg-raised text-text-secondary",
  active: "bg-cyan-glow text-cyan",
} as const;

const backendAppearance: Record<BadgeBackend, string> = {
  claude: "bg-cyan-glow text-cyan",
  codex: "bg-violet-glow text-violet",
};

// `subtle` de-emphasizes a badge in repetitive contexts. It renders the neutral
// muted palette (text-secondary on bg-raised, 4.59:1) rather than fading the
// variant with opacity — an opacity fade multiplies the text toward its
// background and drops it below the WCAG AA contrast threshold. Where the accent
// variant's identity matters (backend), the badge text + aria-label still carry
// it. Resolved as a single appearance (not an appended override) because the
// primitive's `cn` does not tailwind-merge conflicting utilities.
const subtleAppearance = "bg-bg-raised text-text-secondary";

type BadgeCommon = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "className" | "style"
> & {
  /** Agent identity, orthogonal to tier. When set it owns the badge color
   *  (legacy `.cc-badge[data-backend]` is sourced after the tier rules). */
  backend?: BadgeBackend;
  subtle?: boolean;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

// Hybrid API (matches the legacy contract): tier picks the family, an
// attribute-style value picks within it.
export type BadgeProps =
  | (BadgeCommon & { tier?: "status"; status?: BadgeStatus })
  | (BadgeCommon & { tier: "type"; kind: BadgeKind })
  | (BadgeCommon & { tier: "count"; active?: boolean });

type BadgeAllProps = BadgeCommon & {
  tier?: BadgeTier;
  status?: BadgeStatus;
  kind?: BadgeKind;
  active?: boolean;
};

function resolveAppearance(p: BadgeAllProps): string {
  if (p.backend) return backendAppearance[p.backend];
  if (p.tier === "type") return typeAppearance[p.kind ?? "feature"];
  if (p.tier === "count")
    return p.active ? countAppearance.active : countAppearance.default;
  return statusAppearance[p.status ?? "idle"];
}

export function Badge(props: BadgeProps) {
  const {
    backend,
    subtle,
    layoutClassName,
    tier,
    status,
    kind,
    active,
    ...domProps
  } = props as BadgeAllProps;
  const appearance = subtle
    ? subtleAppearance
    : resolveAppearance(props as BadgeAllProps);
  const resolvedTier: BadgeTier = tier ?? "status";

  return (
    <span
      {...domProps}
      data-status={resolvedTier === "status" ? (status ?? "idle") : undefined}
      data-type={resolvedTier === "type" ? kind : undefined}
      data-active={
        resolvedTier === "count" ? String(active ?? false) : undefined
      }
      data-backend={backend}
      className={cn(base, appearance, layoutClassName)}
    />
  );
}
