// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TemplateLibraryItem } from "@/lib/workflow-graph/template-library-service";
import TemplateLibrary from "@/features/workflow-templates/components/TemplateLibrary";

const globalItem: TemplateLibraryItem = {
  tier: "global",
  id: "kiro-spec",
  name: "Kiro Spec Workflow",
  description: "Methodology-level spec workflow.",
  revision: 3,
  parameters: [
    {
      type: "string",
      name: "feature",
      label: "Feature name",
      required: true,
    },
  ],
  prerequisites: [
    { kind: "path", path: ".kiro", label: "Kiro directory" },
    { kind: "skill", skill: "kiro-spec-design", backend: "claude" },
    { kind: "skill", skill: "kiro-spec-tasks" },
  ],
};

const projectItem: TemplateLibraryItem = {
  tier: "project",
  id: "local-fix",
  name: "Local Fix Workflow",
  description: null,
  revision: 1,
  parameters: [],
  prerequisites: [],
};

// A project-tier template sharing a name with the global one — must list distinctly.
const projectSameName: TemplateLibraryItem = {
  ...globalItem,
  tier: "project",
  id: "kiro-spec-local",
  description: "Project-local copy.",
  prerequisites: [],
};

// A template row's accessible name includes its tier badge ("Global"/"Project")
// plus the template name, so match by substring rather than exact equality.
function selectTemplate(name: string): Promise<void> {
  const user = userEvent.setup();
  return user.click(screen.getByRole("button", { name: new RegExp(name) }));
}

describe("TemplateLibrary", () => {
  it("lists global and project templates each tagged with its tier (R7.1)", () => {
    render(
      <TemplateLibrary items={[globalItem, projectItem]} onLaunch={vi.fn()} />,
    );

    const globalRow = screen
      .getByText("Kiro Spec Workflow")
      .closest("li") as HTMLElement;
    const projectRow = screen
      .getByText("Local Fix Workflow")
      .closest("li") as HTMLElement;

    expect(within(globalRow).getByText(/global/i)).toBeInTheDocument();
    expect(within(projectRow).getByText(/project/i)).toBeInTheDocument();
  });

  it("lists same-name templates across tiers as distinct items (R7.1)", () => {
    render(
      <TemplateLibrary
        items={[globalItem, projectSameName]}
        onLaunch={vi.fn()}
      />,
    );
    // Two entries with the same name, one per tier.
    expect(screen.getAllByText("Kiro Spec Workflow")).toHaveLength(2);
    // The two rows carry distinct tier tags — one Global, one Project.
    const rows = screen.getAllByRole("button", { name: /Kiro Spec Workflow/ });
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0] as HTMLElement).getByText("Global"),
    ).toBeInTheDocument();
    expect(
      within(rows[1] as HTMLElement).getByText("Project"),
    ).toBeInTheDocument();
  });

  it("makes a selected template's declared prerequisites visible before launch (R7.2)", async () => {
    render(<TemplateLibrary items={[globalItem]} onLaunch={vi.fn()} />);

    await selectTemplate("Kiro Spec Workflow");

    // Path prerequisite, its kind, and label visible.
    expect(screen.getByText(".kiro")).toBeInTheDocument();
    expect(screen.getByText(/Kiro directory/)).toBeInTheDocument();
    // Skill prerequisite + its scoped backend visible.
    expect(screen.getByText("kiro-spec-design")).toBeInTheDocument();
    expect(screen.getByText(/claude/i)).toBeInTheDocument();
    // Backend-unscoped skill prerequisite visible.
    expect(screen.getByText("kiro-spec-tasks")).toBeInTheDocument();
  });

  it("indicates when a selected template has no prerequisites (R7.2)", async () => {
    render(<TemplateLibrary items={[projectItem]} onLaunch={vi.fn()} />);

    await selectTemplate("Local Fix Workflow");

    expect(screen.getByText(/no prerequisites/i)).toBeInTheDocument();
  });

  it("sends { id, tier, parameters } to onLaunch on a valid submit (R7.3)", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    render(<TemplateLibrary items={[globalItem]} onLaunch={onLaunch} />);

    await user.click(
      screen.getByRole("button", { name: /Kiro Spec Workflow/ }),
    );
    await user.type(screen.getByLabelText("Feature name"), "checkout");
    await user.click(screen.getByRole("button", { name: /^launch$/i }));

    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith({
      id: "kiro-spec",
      tier: "global",
      parameters: { feature: "checkout" },
    });
  });

  it("itemizes each missing prerequisite and reflects no-start on prerequisites_unmet (R7.4)", async () => {
    render(
      <TemplateLibrary
        items={[globalItem]}
        onLaunch={vi.fn()}
        selectedTemplateId="kiro-spec"
        launchOutcome={{
          status: "prerequisites_unmet",
          missing: [
            { kind: "path", path: ".kiro", label: null, reason: "absent" },
            {
              kind: "skill",
              skill: "kiro-spec-design",
              backend: "claude",
              label: null,
              reason: "probe_error",
            },
          ],
        }}
      />,
    );

    // Each missing prerequisite itemized by kind.
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(".kiro")).toBeInTheDocument();
    expect(within(alert).getByText("kiro-spec-design")).toBeInTheDocument();
    // Distinct reasons surfaced (absent vs probe_error).
    expect(
      within(alert).getByText(/could not be evaluated/i),
    ).toBeInTheDocument();
    // Reflects the run did not start.
    expect(within(alert).getByText(/did not start/i)).toBeInTheDocument();
  });

  it("surfaces a distinct non-prerequisite rejection reason and reflects no-start (R7.5)", () => {
    render(
      <TemplateLibrary
        items={[globalItem]}
        onLaunch={vi.fn()}
        selectedTemplateId="kiro-spec"
        launchOutcome={{
          status: "rejected",
          reason: "Worktree has uncommitted changes.",
        }}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(
      within(alert).getByText("Worktree has uncommitted changes."),
    ).toBeInTheDocument();
    expect(within(alert).getByText(/did not start/i)).toBeInTheDocument();
  });

  it("reflects a started state on success (R7.6)", () => {
    render(
      <TemplateLibrary
        items={[globalItem]}
        onLaunch={vi.fn()}
        selectedTemplateId="kiro-spec"
        launchOutcome={{ status: "started" }}
      />,
    );

    expect(screen.getByText(/started/i)).toBeInTheDocument();
  });

  it("renders an EmptyState when the library is empty (R7.7)", () => {
    render(<TemplateLibrary items={[]} onLaunch={vi.fn()} />);

    expect(screen.getByText(/no templates/i)).toBeInTheDocument();
    // No selectable template rows.
    expect(
      screen.queryByRole("button", { name: /workflow/i }),
    ).not.toBeInTheDocument();
  });

  it("notifies selection changes via onSelectTemplate (R7.1)", async () => {
    const user = userEvent.setup();
    const onSelectTemplate = vi.fn();
    render(
      <TemplateLibrary
        items={[globalItem, projectItem]}
        onLaunch={vi.fn()}
        onSelectTemplate={onSelectTemplate}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Local Fix Workflow/ }),
    );
    expect(onSelectTemplate).toHaveBeenCalledWith("local-fix");
  });
});
