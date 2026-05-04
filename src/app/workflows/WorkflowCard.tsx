"use client";

import Link from "next/link";
import type { MachineSpec } from "./machine-spec-types";
import { getMachineStats } from "./machine-spec-types";

interface WorkflowCardProps {
  spec: MachineSpec;
}

/**
 * Card on the /workflows index. The entire card is a link; stats render in a
 * compact 5-column strip. Tagline is the human-readable hook; character is the
 * one-word architectural classification (linear, factory, hierarchical, etc.).
 */
export default function WorkflowCard({
  spec,
}: WorkflowCardProps): React.JSX.Element {
  const stats = getMachineStats(spec);

  return (
    <Link href={`/workflows/${spec.id}`} className="workflow-card">
      <div className="workflow-card-header">
        <div className="workflow-card-id">
          <span className="workflow-card-glyph" aria-hidden="true">
            ◆
          </span>
          <span className="workflow-card-machine-id">{spec.machineId}</span>
        </div>
        <span className="workflow-card-character">{spec.character}</span>
      </div>
      <h2 className="workflow-card-name">{spec.name}</h2>
      <p className="workflow-card-tagline">{spec.tagline}</p>
      <div className="workflow-card-stats">
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
    <div className="workflow-card-stat">
      <span className="workflow-card-stat-value">{value}</span>
      <span className="workflow-card-stat-label">{label}</span>
    </div>
  );
}
