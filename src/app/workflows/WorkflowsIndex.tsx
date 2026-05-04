"use client";

import Topbar from "@/components/Topbar";
import WorkflowCard from "./WorkflowCard";
import type { MachineSpec } from "./machine-spec-types";

interface WorkflowsIndexProps {
  specs: ReadonlyArray<MachineSpec>;
}

/**
 * Index page for /workflows. A single-column reading lane on mobile, two
 * columns on desktop. Above the grid is a brief explainer so newcomers can
 * orient themselves before drilling into a specific machine.
 */
export default function WorkflowsIndex({
  specs,
}: WorkflowsIndexProps): React.JSX.Element {
  return (
    <div className="app" data-page="workflows">
      <Topbar
        page="workflows"
        breadcrumbs={[{ label: "workflows", href: "/workflows" }]}
      />
      <main className="main">
        <div className="page-header stagger-in">
          <h1 className="page-title">
            Workflow <span className="accent">Atlas</span>
          </h1>
          <p className="page-subtitle">
            The XState machines that orchestrate Command Center. Pick one to see
            its states, transitions, actors, and guards.
          </p>
        </div>
        <div className="workflow-grid stagger-in">
          {specs.map((spec) => (
            <WorkflowCard key={spec.id} spec={spec} />
          ))}
        </div>
      </main>
    </div>
  );
}
