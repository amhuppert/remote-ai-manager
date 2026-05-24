import "./styles/workflows-catalog.css";
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
          {machineSpecs.map((spec) => (
            <WorkflowCard key={spec.id} spec={spec} />
          ))}
        </div>
      </main>
    </div>
  );
}
