// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { specElementReaderDetailFixture } from "./SpecElementReader.fixtures";
import { SpecElementReader } from "./SpecElementReader";

afterEach(cleanup);

describe("SpecElementReader", () => {
  it("renders authored prose as markdown across requirement, decision, and task readers", async () => {
    const detail = specElementReaderDetailFixture();
    const snapshot = detail.currentRevision;
    if (snapshot === null)
      throw new Error("Reader fixture requires a revision");
    for (const entry of snapshot.elements) {
      const payload = entry.version.payload;
      if (payload.kind === "requirement") {
        payload.statement = "Every **execution** pins scope.";
      } else if (payload.kind === "criterion") {
        payload.text = "- Pin the selected `task`\n- Pin the criterion";
        payload.validationStrategy.note = "Run the **scope test**.";
      } else if (payload.kind === "decision") {
        payload.chosenApproach = "Persist the **selected scope**.";
        payload.reason = "1. Keep runs reproducible\n2. Keep review auditable";
        payload.rejectedAlternatives[0]!.reason =
          "The source `revision` could change.";
      } else if (payload.kind === "task" && entry.element.id === "task-2") {
        payload.instructions = "- Read the pinned snapshot\n- **Verify** it";
      }
    }

    const requirementView = render(
      <SpecElementReader detail={detail} kind="requirements" />,
    );
    const decisionView = render(
      <SpecElementReader detail={detail} kind="decisions" />,
    );
    const taskView = render(<SpecElementReader detail={detail} kind="tasks" />);

    expect(
      await within(requirementView.container).findByText("execution", {
        selector: "strong",
      }),
    ).toBeVisible();
    expect(
      await within(requirementView.container).findByText("task", {
        selector: "code",
      }),
    ).toBeVisible();
    expect(
      await within(requirementView.container).findByText("scope test", {
        selector: "strong",
      }),
    ).toBeVisible();
    expect(
      await within(decisionView.container).findByText("selected scope", {
        selector: "strong",
      }),
    ).toBeVisible();
    expect(
      await within(decisionView.container).findByText("revision", {
        selector: "code",
      }),
    ).toBeVisible();
    expect(
      await within(taskView.container).findByText("Verify", {
        selector: "strong",
      }),
    ).toBeVisible();
  });

  it("reads requirements from the current revision with their criteria and status", () => {
    const detail = specElementReaderDetailFixture();
    const approved = detail.currentApprovedRevision;
    if (approved === null) throw new Error("Reader fixture requires approval");
    const draftRevision = {
      ...approved.revision,
      id: "revision-2",
      number: 2,
      state: "draft" as const,
      basedOnRevisionId: approved.revision.id,
      contentHash: "revision-2-hash",
      proposedAt: null,
      approvedAt: null,
    };
    detail.currentRevision = {
      revision: draftRevision,
      elements: approved.elements.map((entry) => ({
        ...entry,
        version: {
          ...entry.version,
          revisionId: draftRevision.id,
          ...(entry.element.id === "requirement-1"
            ? {
                payload: {
                  kind: "requirement" as const,
                  statement:
                    "Every execution pins the full immutable scope for later review.",
                  priority: "must" as const,
                  risk: "high" as const,
                },
              }
            : {}),
        },
      })),
    };

    render(<SpecElementReader detail={detail} kind="requirements" />);

    expect(
      screen.getByRole("heading", { name: "Requirements" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Revision 2")).toBeInTheDocument();
    const requirement = screen.getByRole("article", {
      name: "R1 requirement",
    });
    expect(document.getElementById("R1")).toBe(requirement);
    expect(requirement).toHaveAttribute("tabindex", "-1");
    expect(within(requirement).getByText("Proof partial")).toBeInTheDocument();
    expect(within(requirement).getByText("Approved")).toBeInTheDocument();
    expect(
      within(requirement).getByRole("heading", {
        name: "Acceptance criteria",
      }),
    ).toBeInTheDocument();
    expect(within(requirement).getByText("R1.1")).toBeInTheDocument();
    expect(document.getElementById("R1.1")).toHaveAttribute("tabindex", "-1");
    expect(
      within(requirement).getByText(
        "The selected task and criterion are pinned.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Every execution pins scope."),
    ).not.toBeInTheDocument();
  });

  it("renders decision approach, rationale, and rejected alternatives", () => {
    render(
      <SpecElementReader
        detail={specElementReaderDetailFixture()}
        kind="decisions"
      />,
    );

    const decision = screen.getByRole("article", {
      name: /D1 Pin the complete execution scope/i,
    });
    expect(
      within(decision).getByRole("heading", { name: "Chosen approach" }),
    ).toBeInTheDocument();
    expect(
      within(decision).getByText(
        "Persist the selected tasks and criteria with the execution.",
      ),
    ).toBeInTheDocument();
    expect(
      within(decision).getByRole("heading", { name: "Rationale" }),
    ).toBeInTheDocument();
    expect(
      within(decision).getByText(
        "A run must remain reproducible after authoring continues.",
      ),
    ).toBeInTheDocument();
    expect(
      within(decision).getByRole("heading", {
        name: "Rejected alternatives",
      }),
    ).toBeInTheDocument();
    expect(
      within(decision).getByText("Resolve scope when work starts"),
    ).toBeInTheDocument();
    expect(
      within(decision).getByText(
        "The source revision could change before launch.",
      ),
    ).toBeInTheDocument();
  });

  it("falls back to the approved revision and resolves task links to handles", () => {
    const detail = specElementReaderDetailFixture();
    detail.currentRevision = null;

    render(<SpecElementReader detail={detail} kind="tasks" />);

    const task = screen.getByRole("article", {
      name: /T2 Validate immutable scope/i,
    });
    expect(within(task).getByText("Running")).toBeInTheDocument();
    expect(within(task).getByText("Dependencies")).toBeInTheDocument();
    expect(within(task).getByText("T1")).toBeInTheDocument();
    expect(within(task).getByText("Requirement links")).toBeInTheDocument();
    expect(within(task).getByText("R1")).toBeInTheDocument();
    expect(
      within(task).getByText(
        "Prove that execution reads the snapshot captured at launch.",
      ),
    ).toBeInTheDocument();
  });

  it("explains when no current or approved document exists", () => {
    const detail = specElementReaderDetailFixture();
    detail.currentRevision = null;
    detail.currentApprovedRevision = null;

    render(<SpecElementReader detail={detail} kind="tasks" />);

    expect(screen.getByText("No revision available")).toBeInTheDocument();
    expect(
      screen.getByText(
        "A current or approved revision is required to read tasks.",
      ),
    ).toBeInTheDocument();
  });
});
