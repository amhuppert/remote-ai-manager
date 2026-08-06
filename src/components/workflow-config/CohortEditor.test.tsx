// @vitest-environment jsdom
/**
 * The ordered validator-cohort editor shared by the builder, the runtime
 * pause-to-edit surface, and the Settings global defaults (R12/D11).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { agentProfileKeys } from "@/lib/agent-profiles/query-keys";
import type { AgentProfileLibraryListing } from "@/lib/agent-profiles/schemas";
import {
  validatorCohortSchema,
  type ValidatorAssignment,
  type ValidatorCohort,
} from "@/lib/workflow-graph/config-schemas";
import { CohortEditor, toggleCohortEnabled } from "./CohortEditor";

afterEach(cleanup);

const PROJECT = "my-app";

const LISTING: AgentProfileLibraryListing = {
  profiles: [
    {
      ref: { tier: "builtin", id: "general-reviewer" },
      name: "General Reviewer",
      description: "Reviews a diff against acceptance criteria.",
      revision: 1,
      recommendedFor: ["workflow_validator"],
      tags: [],
      readOnly: true,
    },
    {
      ref: { tier: "global", id: "security-reviewer" },
      name: "Security Reviewer",
      description: "Reads a diff for exploitable defects.",
      revision: 3,
      recommendedFor: ["workflow_validator"],
      tags: [],
      readOnly: false,
    },
  ],
  diagnostics: [],
};

function assignment(
  id: string,
  overrides: Partial<ValidatorAssignment> = {},
): ValidatorAssignment {
  return {
    id,
    profile: { tier: "builtin", id: "general-reviewer" },
    strategy: "conversation",
    continuity: { enabled: true },
    agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
    ...overrides,
  };
}

const COHORT: ValidatorCohort = {
  enabled: true,
  assignments: [
    assignment("general"),
    assignment("security", {
      profile: { tier: "global", id: "security-reviewer" },
    }),
  ],
};

function renderCohort(
  props: Partial<React.ComponentProps<typeof CohortEditor>> = {},
) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(agentProfileKeys.projectList(PROJECT), LISTING);
  const onChange = vi.fn();
  const view = renderWithQuery(
    <CohortEditor
      value={props.value ?? COHORT}
      onChange={onChange}
      libraryProjectName={PROJECT}
      {...props}
    />,
    queryClient,
  );
  return { onChange, ...view };
}

function rowIds(): string[] {
  return screen
    .getAllByTestId(/^cohort-assignment-/)
    .map((row) => row.getAttribute("data-assignment-id") ?? "");
}

describe("CohortEditor ordering", () => {
  it("lists assignments in configured order", () => {
    renderCohort();
    expect(rowIds()).toEqual(["general", "security"]);
  });

  it("moves an assignment later in the cohort", () => {
    const { onChange } = renderCohort();
    fireEvent.click(screen.getByLabelText("Move general down"));
    const next = onChange.mock.calls[0]?.[0] as ValidatorCohort;
    expect(next.assignments.map((a) => a.id)).toEqual(["security", "general"]);
  });

  it("moves an assignment earlier in the cohort", () => {
    const { onChange } = renderCohort();
    fireEvent.click(screen.getByLabelText("Move security up"));
    const next = onChange.mock.calls[0]?.[0] as ValidatorCohort;
    expect(next.assignments.map((a) => a.id)).toEqual(["security", "general"]);
  });

  it("cannot move the first assignment up or the last one down", () => {
    renderCohort();
    expect(screen.getByLabelText("Move general up")).toBeDisabled();
    expect(screen.getByLabelText("Move security down")).toBeDisabled();
  });

  it("appends a new assignment with an id that does not collide", () => {
    const { onChange } = renderCohort();
    fireEvent.click(screen.getByRole("button", { name: "Add validator" }));
    const next = onChange.mock.calls[0]?.[0] as ValidatorCohort;
    expect(next.assignments).toHaveLength(3);
    expect(new Set(next.assignments.map((a) => a.id)).size).toBe(3);
    expect(validatorCohortSchema.safeParse(next).success).toBe(true);
  });

  it("removes one assignment and keeps the rest in order", () => {
    const { onChange } = renderCohort();
    fireEvent.click(screen.getByLabelText("Remove general"));
    const next = onChange.mock.calls[0]?.[0] as ValidatorCohort;
    expect(next.assignments.map((a) => a.id)).toEqual(["security"]);
  });

  it("refuses to empty an enabled cohort, which would pass vacuously", () => {
    renderCohort({
      value: { enabled: true, assignments: [assignment("general")] },
    });
    expect(screen.getByLabelText("Remove general")).toBeDisabled();
  });
});

describe("CohortEditor dormancy", () => {
  const DISABLED: ValidatorCohort = { ...COHORT, enabled: false };

  it("keeps a disabled cohort's assignments visible and marked dormant", () => {
    renderCohort({ value: DISABLED });
    expect(rowIds()).toEqual(["general", "security"]);
    for (const row of screen.getAllByTestId(/^cohort-assignment-/)) {
      expect(row).toHaveAttribute("data-dormant", "true");
    }
    expect(screen.getByTestId("cohort-dormant-notice")).toBeVisible();
  });

  it("does not edit dormant assignments in place", () => {
    renderCohort({ value: DISABLED });
    expect(screen.getByLabelText("Move security up")).toBeDisabled();
    expect(screen.getByLabelText("Remove general")).toBeDisabled();
  });

  it("restores every dormant assignment, in order, when re-enabled", () => {
    const restored = toggleCohortEnabled(DISABLED, true);
    expect(restored.enabled).toBe(true);
    expect(restored.assignments).toEqual(DISABLED.assignments);
  });

  it("seeds one reviewer when re-enabling a cohort that retained nothing", () => {
    const restored = toggleCohortEnabled(
      { enabled: false, assignments: [] },
      true,
    );
    expect(restored.assignments).toHaveLength(1);
    expect(validatorCohortSchema.safeParse(restored).success).toBe(true);
  });

  it("keeps the assignments when validation is switched off", () => {
    const off = toggleCohortEnabled(COHORT, false);
    expect(off.enabled).toBe(false);
    expect(off.assignments.map((a) => a.id)).toEqual(["general", "security"]);
  });
});

describe("CohortEditor cascade provenance", () => {
  it("names the tier an inherited cohort comes from", () => {
    renderCohort({ cascade: { state: "inherit", origin: "global defaults" } });
    const provenance = screen.getByTestId("cohort-cascade");
    expect(provenance).toHaveAttribute("data-cascade-state", "inherit");
    expect(provenance.textContent).toContain("global defaults");
  });

  it("marks a cohort authored at this tier as in use", () => {
    renderCohort({ cascade: { state: "use", origin: "this context" } });
    expect(screen.getByTestId("cohort-cascade")).toHaveAttribute(
      "data-cascade-state",
      "use",
    );
  });

  it("marks a cohort disabled for this tier", () => {
    renderCohort({
      value: { ...COHORT, enabled: false },
      cascade: { state: "disabled", origin: "this context" },
    });
    expect(screen.getByTestId("cohort-cascade")).toHaveAttribute(
      "data-cascade-state",
      "disabled",
    );
  });

  it("shows no provenance where there is no cascade above it", () => {
    renderCohort();
    expect(screen.queryByTestId("cohort-cascade")).not.toBeInTheDocument();
  });
});

describe("CohortEditor per-assignment editing", () => {
  it("edits one assignment's focus without touching its siblings", () => {
    const { onChange } = renderCohort();
    fireEvent.change(screen.getByLabelText("Focus for security"), {
      target: { value: "auth boundaries" },
    });
    const next = onChange.mock.calls[0]?.[0] as ValidatorCohort;
    expect(next.assignments[1]?.focus).toBe("auth boundaries");
    expect(next.assignments[0]).toEqual(COHORT.assignments[0]);
  });

  it("edits one assignment's runtime without touching its siblings", () => {
    const { onChange } = renderCohort();
    const row = screen.getByTestId("cohort-assignment-security");
    fireEvent.click(within(row).getByRole("button", { name: /codex/i }));
    const next = onChange.mock.calls[0]?.[0] as ValidatorCohort;
    expect(next.assignments[1]?.agent.backend).toBe("codex");
    expect(next.assignments[0]?.agent.backend).toBe("claude");
  });

  it("shows each assignment's profile tier badge in its row header", () => {
    renderCohort();
    expect(
      within(screen.getByTestId("cohort-assignment-general")).getByTestId(
        "cohort-tier-badge",
      ).textContent,
    ).toBe("Built-in");
    expect(
      within(screen.getByTestId("cohort-assignment-security")).getByTestId(
        "cohort-tier-badge",
      ).textContent,
    ).toBe("Global");
  });

  it("offers no per-assignment reset where no lane exists to reset", () => {
    renderCohort();
    expect(screen.queryByLabelText("Reset general")).not.toBeInTheDocument();
  });

  it("resets one assignment's lane by its use-site id", () => {
    const onResetAssignment = vi.fn();
    renderCohort({ onResetAssignment });
    fireEvent.click(screen.getByLabelText("Reset general"));
    expect(onResetAssignment).toHaveBeenCalledWith("general");
  });
});

describe("CohortEditor read-only", () => {
  it("disables every mutation affordance", () => {
    renderCohort({ readOnly: true });
    expect(screen.getByLabelText("Move security up")).toBeDisabled();
    expect(screen.getByLabelText("Remove general")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Add validator" }),
    ).toBeDisabled();
  });
});
