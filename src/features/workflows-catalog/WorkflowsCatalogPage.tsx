import Topbar from "@/components/Topbar";
import WorkflowCard from "./components/WorkflowCard";
import { machineSpecs } from "./machine-specs";

/**
 * Index page for /workflows. A single-column reading lane on mobile, two
 * columns on desktop. Above the grid is a brief explainer so newcomers can
 * orient themselves before drilling into a specific machine.
 */
export default function WorkflowsCatalogPage(): React.JSX.Element {
  return (
    <div className="app" data-page="workflows">
      <Topbar
        page="workflows"
        breadcrumbs={[{ label: "workflows", href: "/workflows" }]}
      />
      <main className="main">
        <div className="stagger-in mb-2xl max-768:mb-lg">
          <h1 className="mb-sm font-display text-[2.4rem] leading-[1.1] font-extrabold tracking-[-0.03em] text-text-primary max-768:text-[1.6rem]">
            Workflow{" "}
            <span className="text-cyan [text-shadow:0_0_30px_var(--cyan-glow-text)]">
              Atlas
            </span>
          </h1>
          <p className="font-mono text-[0.82rem] font-normal text-text-secondary">
            The 3 XState machines that orchestrate Command Center. Pick one to
            see its states, transitions, actors, and guards.
          </p>
        </div>
        <div className="stagger-in mt-xl grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-lg">
          {machineSpecs.map((spec) => (
            <WorkflowCard key={spec.id} spec={spec} />
          ))}
        </div>
      </main>
    </div>
  );
}
