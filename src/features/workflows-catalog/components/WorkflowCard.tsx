"use client";

import Link from "next/link";
import type { MachineSpec } from "../machine-spec-types";
import { getMachineStats } from "../machine-spec-types";

interface WorkflowCardProps {
  spec: MachineSpec;
}

/**
 * Card on the /workflows index. The entire card is a link; stats render in a
 * compact 5-column strip. Tagline is the human-readable hook; character is the
 * one-word architectural classification (linear, factory, hierarchical, etc.).
 *
 * The `before:` pseudo-element is the cyan top-accent hairline revealed on
 * hover (legacy `.workflow-card::before`).
 */
export default function WorkflowCard({
  spec,
}: WorkflowCardProps): React.JSX.Element {
  const stats = getMachineStats(spec);

  return (
    <Link
      href={`/workflows/${spec.id}`}
      className="relative flex flex-col gap-sm overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg text-inherit no-underline transition-all duration-150 ease-[ease] before:absolute before:left-0 before:right-0 before:top-0 before:h-px before:bg-[linear-gradient(90deg,transparent,var(--cyan-glow-strong),transparent)] before:opacity-0 before:transition-opacity before:duration-200 before:ease-[ease] before:content-[''] hover:-translate-y-[2px] hover:border-border-strong hover:bg-bg-raised hover:before:opacity-100"
    >
      <div className="flex items-center justify-between font-mono text-[0.7rem] text-text-tertiary">
        <div className="flex items-center gap-[6px]">
          <span className="text-cyan" aria-hidden="true">
            ◆
          </span>
          <span className="tracking-[0.04em]">{spec.machineId}</span>
        </div>
        <span className="uppercase tracking-[0.08em] text-violet">
          {spec.character}
        </span>
      </div>
      <h2 className="font-display text-[1.4rem] tracking-[-0.01em] text-text-primary">
        {spec.name}
      </h2>
      <p className="text-[0.9rem] leading-[1.5] text-text-secondary">
        {spec.tagline}
      </p>
      <div className="mt-sm grid grid-cols-5 gap-sm border-x-0 border-b-0 border-t border-solid border-border-subtle pt-sm">
        <Stat value={stats.states} label="states" />
        <Stat value={stats.events} label="events" />
        <Stat value={stats.actors} label="actors" />
        <Stat value={stats.guards} label="guards" />
        <Stat value={stats.actions} label="actions" />
      </div>
    </Link>
  );
}

function Stat({
  value,
  label,
}: {
  value: number;
  label: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-[2px]">
      <span className="font-mono text-[1.1rem] tabular-nums text-cyan">
        {value}
      </span>
      <span className="font-mono text-[0.7rem] uppercase tracking-[0.04em] text-text-tertiary">
        {label}
      </span>
    </div>
  );
}
