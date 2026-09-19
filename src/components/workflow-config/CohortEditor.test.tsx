// @vitest-environment jsdom
/**
 * The ordered validator-cohort editor shared by the builder, the runtime
 * pause-to-edit surface, and the Settings global defaults (R12/D11).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { backendCatalogKeys } from "@/lib/agent-backends/query-keys";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import { agentProfileKeys } from "@/lib/agent-profiles/query-keys";
import type { AgentProfileLibraryListing } from "@/lib/agent-profiles/schemas";
import {
  validatorCohortSchema,
  type ValidatorAssignment,
  type ValidatorCohort,
} from "@/lib/workflow-graph/config-schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
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
    authority: "blocking",

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
  queryClient.setQueryData(
    backendCatalogKeys.catalog(),
    listBackendCatalogEntries(),
  );
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
    const remove = screen.getByLabelText("Remove general");
    expect(remove).toBeDisabled();
    // The refusal has to say WHY, or a disabled button reads as a bug. The
    // message is the schema's own reason, restated where the author can act.
    expect(remove.getAttribute("title")).toContain("pass vacuously");
    expect(
      validatorCohortSchema.safeParse({ enabled: true, assignments: [] })
        .success,
    ).toBe(false);
  });
});

/**
 * R12.3: the roster carries the authority axis, and an advisory-only cohort is
 * a legal roster rather than a validation error.
 */
describe("CohortEditor authority", () => {
  function authorityBadges(): { id: string; text: string; tone: string }[] {
    return screen.getAllByTestId(/^cohort-assignment-/).map((row) => {
      const badge = within(row).getByTestId("cohort-authority-badge");
      return {
        id: row.getAttribute("data-assignment-id") ?? "",
        text: badge.textContent ?? "",
        tone: badge.getAttribute("data-authority") ?? "",
      };
    });
  }

  it("shows each roster member's authority as a badge distinct from its sibling's", () => {
    renderCohort({
      value: {
        enabled: true,
        assignments: [
          assignment("general"),
          assignment("security", { authority: "advisory" }),
        ],
      },
    });
    expect(authorityBadges()).toEqual([
      { id: "general", text: "Blocking", tone: "blocking" },
      { id: "security", text: "Advisory", tone: "advisory" },
    ]);
  });

  it("tone-codes the two authorities differently", () => {
    renderCohort({
      value: {
        enabled: true,
        assignments: [
          assignment("general"),
          assignment("security", { authority: "advisory" }),
        ],
      },
    });
    const [blocking, advisory] = screen.getAllByTestId(
      "cohort-authority-badge",
    );
    expect(blocking?.className).not.toBe(advisory?.className);
  });

  it("accepts an advisory-only roster without a validation error", () => {
    const advisoryOnly: ValidatorCohort = {
      enabled: true,
      assignments: [
        assignment("security", { authority: "advisory" }),
        assignment("types", { authority: "advisory" }),
      ],
    };
    renderCohort({ value: advisoryOnly });

    expect(rowIds()).toEqual(["security", "types"]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(validatorCohortSchema.safeParse(advisoryOnly).success).toBe(true);
  });

  it("switches one member's authority without touching its siblings", () => {
    const { onChange } = renderCohort();
    const row = screen.getByTestId("cohort-assignment-security");
    fireEvent.click(
      within(within(row).getByLabelText("Validator authority")).getByRole(
        "radio",
        { name: "advisory" },
      ),
    );
    const next = onChange.mock.calls[0]?.[0] as ValidatorCohort;
    expect(next.assignments[1]?.authority).toBe("advisory");
    expect(next.assignments[0]).toEqual(COHORT.assignments[0]);
  });

  it("adds the standard acceptance-criteria validator as blocking", () => {
    const { onChange } = renderCohort();
    fireEvent.click(screen.getByRole("button", { name: "Add validator" }));
    const next = onChange.mock.calls[0]?.[0] as ValidatorCohort;
    expect(next.assignments.at(-1)?.authority).toBe("blocking");
    expect(validatorCohortSchema.safeParse(next).success).toBe(true);
  });

  it("renders the seeded acceptance-criteria verifier as blocking", () => {
    const seeded = structuredClone(SEEDED_WORKFLOW_DEFAULTS.contextValidator);
    renderCohort({ value: seeded });
    const row = screen.getByTestId(
      `cohort-assignment-${seeded.assignments[0]?.id}`,
    );
    expect(within(row).getByTestId("cohort-authority-badge").textContent).toBe(
      "Blocking",
    );
    expect(
      within(within(row).getByLabelText("Validator authority")).getByRole(
        "radio",
        { name: "blocking" },
      ),
    ).toBeChecked();
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
  it("edits one assignment's instructions without touching its siblings", () => {
    const { onChange } = renderCohort();
    fireEvent.change(screen.getByLabelText("Mandate for security"), {
      target: { value: "auth boundaries" },
    });
    const next = onChange.mock.calls[0]?.[0] as ValidatorCohort;
    expect(next.assignments[1]?.focus).toBe("auth boundaries");
    expect(next.assignments[0]).toEqual(COHORT.assignments[0]);
  });

  // Clearing the field removes the steer; it does not store an empty one. The
  // roster is the composition all three surfaces render, so the removal has to
  // survive the wrapper between the textarea and the cohort the surface saves.
  it("removes one assignment's instructions when the author clears the field", () => {
    const { onChange } = renderCohort({
      value: {
        enabled: true,
        assignments: [
          assignment("general"),
          assignment("security", { focus: "auth boundaries" }),
        ],
      },
    });
    fireEvent.change(screen.getByLabelText("Mandate for security"), {
      target: { value: "" },
    });
    const next = onChange.mock.calls[0]?.[0] as ValidatorCohort;
    expect(next.assignments[1]).not.toHaveProperty("focus");
    expect(next.assignments[0]).toEqual(assignment("general"));
    expect(validatorCohortSchema.safeParse(next).success).toBe(true);
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
