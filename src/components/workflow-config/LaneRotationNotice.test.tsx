// @vitest-environment jsdom
/**
 * The live-execution disclosure that an authority or instructions edit retires
 * the seat's validator lane (R12.4/D12).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type {
  ValidatorAssignment,
  ValidatorCohort,
} from "@/lib/workflow-graph/config-schemas";
import {
  LaneRotationNotice,
  assignmentsRotatedByEdit,
} from "./LaneRotationNotice";

afterEach(cleanup);

function assignment(
  id: string,
  overrides: Partial<ValidatorAssignment> = {},
): ValidatorAssignment {
  return {
    id,
    profile: { tier: "builtin", id: "general-reviewer" },
    strategy: "conversation",
    authority: "blocking",
    continuity: { enabled: true },
    agent: {
      backend: "claude",
      modelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
    },
    ...overrides,
  };
}

const BASE: ValidatorCohort = {
  enabled: true,
  assignments: [assignment("general"), assignment("security")],
};

function withAssignment(
  id: string,
  overrides: Partial<ValidatorAssignment>,
): ValidatorCohort {
  return {
    ...BASE,
    assignments: BASE.assignments.map((entry) =>
      entry.id === id ? { ...entry, ...overrides } : entry,
    ),
  };
}

describe("assignmentsRotatedByEdit", () => {
  it("reports nothing when the roster is untouched", () => {
    expect(assignmentsRotatedByEdit(BASE, structuredClone(BASE))).toEqual([]);
  });

  it("reports the seat whose authority changed", () => {
    expect(
      assignmentsRotatedByEdit(
        BASE,
        withAssignment("security", { authority: "advisory" }),
      ),
    ).toEqual(["security"]);
  });

  it("reports the seat whose instructions changed", () => {
    expect(
      assignmentsRotatedByEdit(
        BASE,
        withAssignment("general", { focus: "auth boundaries" }),
      ),
    ).toEqual(["general"]);
  });

  it("reports a seat whose instructions were cleared", () => {
    const withFocus = withAssignment("general", { focus: "auth boundaries" });
    expect(assignmentsRotatedByEdit(withFocus, BASE)).toEqual(["general"]);
  });

  it("reports every affected seat, in roster order", () => {
    const edited: ValidatorCohort = {
      ...BASE,
      assignments: [
        { ...assignment("general"), focus: "hot paths" },
        { ...assignment("security"), authority: "advisory" },
      ],
    };
    expect(assignmentsRotatedByEdit(BASE, edited)).toEqual([
      "general",
      "security",
    ]);
  });

  it("ignores a seat that is being added rather than rotated", () => {
    const added: ValidatorCohort = {
      ...BASE,
      assignments: [...BASE.assignments, assignment("types")],
    };
    expect(assignmentsRotatedByEdit(BASE, added)).toEqual([]);
  });

  it("ignores an edit that leaves both axes alone", () => {
    expect(
      assignmentsRotatedByEdit(
        BASE,
        withAssignment("security", { strategy: "task" }),
      ),
    ).toEqual([]);
  });
});

describe("LaneRotationNotice", () => {
  it("renders nothing when no seat's authority or instructions moved", () => {
    render(<LaneRotationNotice base={BASE} draft={structuredClone(BASE)} />);
    expect(
      screen.queryByTestId("lane-rotation-notice"),
    ).not.toBeInTheDocument();
  });

  it("names the affected seat and the rotation reason before the edit is applied", () => {
    render(
      <LaneRotationNotice
        base={BASE}
        draft={withAssignment("security", { authority: "advisory" })}
      />,
    );
    const notice = screen.getByTestId("lane-rotation-notice");
    expect(notice.textContent).toContain("security");
    expect(notice.textContent).toContain("assignment_changed");
    expect(notice.textContent).toContain("Saving");
  });

  it("names every affected seat", () => {
    render(
      <LaneRotationNotice
        base={BASE}
        draft={{
          ...BASE,
          assignments: [
            { ...assignment("general"), focus: "hot paths" },
            { ...assignment("security"), authority: "advisory" },
          ],
        }}
      />,
    );
    const notice = screen.getByTestId("lane-rotation-notice");
    expect(notice.textContent).toContain("general");
    expect(notice.textContent).toContain("security");
  });
});
