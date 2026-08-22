// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  render as rtlRender,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import { agentProfileKeys } from "@/lib/agent-profiles/query-keys";
import type { AgentProfileLibraryListing } from "@/lib/agent-profiles/schemas";
import type { ValidatorAssignment } from "@/lib/workflow-graph/config-schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "../form-state";
import { WorkflowSection } from "./WorkflowSection";
import { makeController } from "./test-controller";

// The global-defaults form belongs to no project, so its pickers read the
// GLOBAL library listing — seeded here through the production query key so the
// scope wiring is what these assertions exercise.
const GLOBAL_LISTING: AgentProfileLibraryListing = {
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
      revision: 2,
      recommendedFor: ["workflow_validator"],
      tags: [],
      readOnly: false,
    },
  ],
  diagnostics: [],
};

function render(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(agentProfileKeys.globalList(), GLOBAL_LISTING);
  return rtlRender(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("WorkflowSection", () => {
  it("renders all eleven default sub-sections with DEFAULT badges when matching seed", () => {
    const { controller } = makeController();
    const { container } = render(<WorkflowSection controller={controller} />);
    const expected = [
      "Implementer",
      "Collaboration",
      "Context validator",
      "Script validator",
      "Agent validation",
      "Lane-merge validation",
      "Ask user questions",
      "Iteration policy",
      "Circuit breaker",
      "Plan repair",
      "Mutability",
    ];
    for (const title of expected) {
      expect(screen.getByText(new RegExp(`^${title}$`))).toBeVisible();
    }
    const subs = container.querySelectorAll("[data-subsection]");
    expect(subs.length).toBe(11);
    for (const el of subs) {
      expect(el.textContent).toContain("DEFAULT");
      expect(el.textContent).not.toContain("MODIFIED");
    }
  });

  it("flags the Collaboration block as MODIFIED and updates it via the controller", () => {
    const customDefaults: WorkflowDefaults = {
      ...structuredClone(SEEDED_WORKFLOW_DEFAULTS),
      collaboration: {
        ...structuredClone(SEEDED_WORKFLOW_DEFAULTS.collaboration),
        negotiationRounds: 9,
      },
    };
    const { controller, getState } = makeController({
      workflowDefaults: customDefaults,
    });
    const { container } = render(<WorkflowSection controller={controller} />);

    const collaboration = container.querySelector(
      '[data-subsection="collaboration"]',
    )!;
    expect(collaboration.textContent).toContain("MODIFIED");

    const threshold = collaboration.querySelector(
      '[data-field="workflowDefaults.collaboration.autonomousResolutionThreshold"]',
    )!;
    const blockingPill = Array.from(threshold.querySelectorAll("button")).find(
      (el) => (el.textContent ?? "").trim() === "blocking",
    ) as HTMLElement;
    fireEvent.click(blockingPill);

    expect(
      getState().workflowDefaults?.collaboration?.autonomousResolutionThreshold,
    ).toBe("blocking");
  });

  it("defaults global workflow collaboration off and enables it from Settings", () => {
    const { controller, getState } = makeController();
    render(<WorkflowSection controller={controller} />);
    const toggle = screen.getByRole("switch", {
      name: "Graph workflow collaboration enabled",
    });

    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);

    expect(getState().workflowDefaults?.collaboration).toHaveProperty(
      "enabled",
      true,
    );
  });

  it("flags a block as MODIFIED when its value differs from seeded defaults", () => {
    const customDefaults: WorkflowDefaults = {
      ...structuredClone(SEEDED_WORKFLOW_DEFAULTS),
      iterationPolicy: {
        maxIterations: 99,
        continuity: { enabled: true },
      },
    };
    const { controller } = makeController({ workflowDefaults: customDefaults });
    const { container } = render(<WorkflowSection controller={controller} />);
    const iteration = container.querySelector(
      '[data-subsection="iterationPolicy"]',
    )!;
    expect(iteration.textContent).toContain("MODIFIED");
    const implementer = container.querySelector(
      '[data-subsection="implementer"]',
    )!;
    expect(implementer.textContent).toContain("DEFAULT");
    expect(implementer.textContent).not.toContain("MODIFIED");
  });

  it("uses command selection as the only Script validator control", () => {
    const { controller } = makeController();
    const { container } = render(<WorkflowSection controller={controller} />);
    const scriptValidator = container.querySelector(
      '[data-subsection="scriptValidator"]',
    )! as HTMLElement;

    expect(scriptValidator.querySelector('[role="switch"]')).toBeNull();
    expect(scriptValidator.textContent).not.toContain("Enabled");
  });

  it("toggling Ask user questions updates only that block via the controller", () => {
    const { controller, getState } = makeController();
    const { container } = render(<WorkflowSection controller={controller} />);
    const askUserQuestions = container.querySelector(
      '[data-subsection="askUserQuestions"]',
    )! as HTMLElement;
    const toggle = askUserQuestions.querySelector(
      '[role="switch"]',
    )! as HTMLElement;
    fireEvent.click(toggle);
    expect(getState().workflowDefaults?.askUserQuestions?.enabled).toBe(true);
  });

  it("adds a script-validator command to the ordered list via the controller", () => {
    const { controller, getState } = makeController();
    const { container } = render(<WorkflowSection controller={controller} />);
    const scriptValidator = container.querySelector(
      '[data-subsection="scriptValidator"]',
    )! as HTMLElement;

    const input = scriptValidator.querySelector(
      'input[aria-label="Add script validator command"]',
    )! as HTMLInputElement;
    fireEvent.change(input, { target: { value: "typecheck" } });
    const addButton = Array.from(
      scriptValidator.querySelectorAll("button"),
    ).find((el) => el.textContent === "Add")!;
    fireEvent.click(addButton);

    expect(getState().workflowDefaults?.scriptValidator).toEqual({
      commands: ["typecheck"],
    });
  });

  it("renders the registry multi-select and round-trips an emptied selection as commands: []", () => {
    const seeded: WorkflowDefaults = {
      ...structuredClone(SEEDED_WORKFLOW_DEFAULTS),
      scriptValidator: { commands: ["typecheck"] },
    };
    const { controller, getState } = makeController({
      workflowDefaults: seeded,
    });
    const { container } = render(
      <WorkflowSection
        controller={controller}
        commandOptions={[
          {
            name: "typecheck",
            cost: 2,
            pathArgs: "forbid",
            changedScope: "full_fallback",
          },
          {
            name: "test",
            cost: 4,
            pathArgs: "paths",
            changedScope: "native",
          },
        ]}
      />,
    );
    const scriptValidator = container.querySelector(
      '[data-subsection="scriptValidator"]',
    )! as HTMLElement;

    // Multi-select replaces the free-form entry.
    expect(
      scriptValidator.querySelector(
        'input[aria-label="Add script validator command"]',
      ),
    ).toBeNull();

    const typecheckBox = Array.from(
      scriptValidator.querySelectorAll('[role="checkbox"]'),
    ).find((el) =>
      el.closest("li")?.textContent?.includes("typecheck"),
    )! as HTMLElement;
    expect(typecheckBox).toHaveAttribute("aria-checked", "true");

    // Unchecking the last command keeps the explicit `commands: []` block.
    fireEvent.click(typecheckBox);
    expect(getState().workflowDefaults?.scriptValidator).toEqual({
      commands: [],
    });
  });

  it("switches the agent-validation implementer selector to only-mode for that role alone", () => {
    const { controller, getState } = makeController();
    const { container } = render(<WorkflowSection controller={controller} />);
    const sub = container.querySelector(
      '[data-subsection="agentValidation"]',
    )! as HTMLElement;
    const implementerField = sub.querySelector(
      '[data-field="workflowDefaults.agentValidation.implementer"]',
    )! as HTMLElement;

    fireEvent.click(
      Array.from(implementerField.querySelectorAll('[role="radio"]')).find(
        (el) => el.textContent === "Only",
      )!,
    );

    expect(getState().workflowDefaults?.agentValidation).toEqual({
      implementer: { mode: "only", commands: [] },
      contextValidator: { mode: "only", commands: [] },
    });
  });

  it("switches lane-merge commands to a custom list via the controller", () => {
    const { controller, getState } = makeController();
    const { container } = render(<WorkflowSection controller={controller} />);
    const sub = container.querySelector(
      '[data-subsection="laneMergeValidation"]',
    )! as HTMLElement;

    fireEvent.click(
      Array.from(sub.querySelectorAll('[role="radio"]')).find(
        (el) => el.textContent === "Custom list",
      )!,
    );

    expect(getState().workflowDefaults?.laneMergeValidation).toEqual({
      strategy: "final-only",
      commands: { mode: "only", commands: [] },
    });
  });

  it("surfaces that an empty custom lane-merge list disables the gate", () => {
    const customDefaults: WorkflowDefaults = {
      ...structuredClone(SEEDED_WORKFLOW_DEFAULTS),
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "only", commands: [] },
      },
    };
    const { controller } = makeController({ workflowDefaults: customDefaults });
    const { container } = render(<WorkflowSection controller={controller} />);
    const sub = container.querySelector(
      '[data-subsection="laneMergeValidation"]',
    )! as HTMLElement;

    expect(sub.textContent).toContain("MODIFIED");
    expect(sub.textContent).toContain(
      "Empty list — lane-merge validation is disabled.",
    );
  });

  it("changes the lane-merge strategy while preserving the command selection", () => {
    const { controller, getState } = makeController();
    const { container } = render(<WorkflowSection controller={controller} />);
    const sub = container.querySelector(
      '[data-subsection="laneMergeValidation"]',
    )! as HTMLElement;
    const strategyField = sub.querySelector(
      '[data-field="workflowDefaults.laneMergeValidation.strategy"]',
    )! as HTMLElement;

    fireEvent.click(
      Array.from(strategyField.querySelectorAll("button")).find(
        (el) => (el.textContent ?? "").trim() === "every-merge",
      )!,
    );

    expect(getState().workflowDefaults?.laneMergeValidation).toEqual({
      strategy: "every-merge",
      commands: { mode: "project" },
    });
  });

  it("does not render the literal 'disabled' or 'use' kind labels in the validator", () => {
    const { controller } = makeController();
    const { container } = render(<WorkflowSection controller={controller} />);
    const validator = container.querySelector(
      '[data-subsection="contextValidator"]',
    )!;
    const texts = Array.from(validator.querySelectorAll("button")).map((el) =>
      (el.textContent ?? "").trim().toLowerCase(),
    );
    expect(texts).not.toContain("disabled");
    expect(texts).not.toContain("use");
  });

  /**
   * The cohort editor on the global-defaults (Settings) surface (R12.1). The
   * same component is asserted on the workflow-definition surface in
   * `src/components/workflow-config-panel/GatesScreens.test.tsx`.
   */
  describe("validator cohort editor", () => {
    function cohortDefaults(
      assignments: ValidatorAssignment[],
      enabled = true,
    ): WorkflowDefaults {
      return {
        ...structuredClone(SEEDED_WORKFLOW_DEFAULTS),
        contextValidator: { enabled, assignments },
      };
    }

    const SECURITY: ValidatorAssignment = {
      id: "security",
      profile: { tier: "global", id: "security-reviewer" },
      strategy: "task",
      authority: "blocking",
      continuity: { enabled: true },
      agent: { backend: "codex", model: "gpt-5.4", reasoningEffort: "high" },
    };

    const GENERAL: ValidatorAssignment = {
      id: "general",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "conversation",
      authority: "blocking",
      continuity: { enabled: true },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
    };

    function validatorBlock(container: HTMLElement): HTMLElement {
      return container.querySelector<HTMLElement>(
        '[data-subsection="contextValidator"]',
      )!;
    }

    it("lists the cohort in order with each assignment's tier badge", () => {
      const { controller } = makeController({
        workflowDefaults: cohortDefaults([GENERAL, SECURITY]),
      });
      const { container } = render(<WorkflowSection controller={controller} />);
      const block = validatorBlock(container);

      expect(
        within(block)
          .getAllByTestId(/^cohort-assignment-/)
          .map((row) => row.getAttribute("data-assignment-id")),
      ).toEqual(["general", "security"]);
      expect(
        within(block)
          .getAllByTestId("cohort-tier-badge")
          .map((badge) => badge.textContent),
      ).toEqual(["Built-in", "Global"]);
    });

    it("resolves each assignment's profile against the GLOBAL library listing", () => {
      const { controller } = makeController({
        workflowDefaults: cohortDefaults([SECURITY]),
      });
      const { container } = render(<WorkflowSection controller={controller} />);
      expect(
        within(validatorBlock(container)).getByLabelText("Agent profile")
          .textContent,
      ).toContain("Security Reviewer");
    });

    it("reorders the cohort through the controller", () => {
      const { controller, getState } = makeController({
        workflowDefaults: cohortDefaults([GENERAL, SECURITY]),
      });
      const { container } = render(<WorkflowSection controller={controller} />);
      fireEvent.click(
        within(validatorBlock(container)).getByLabelText("Move security up"),
      );
      expect(
        getState().workflowDefaults?.contextValidator?.assignments.map(
          (a) => a.id,
        ),
      ).toEqual(["security", "general"]);
    });

    it("adds a validator without colliding with an existing use-site id", () => {
      const { controller, getState } = makeController({
        workflowDefaults: cohortDefaults([GENERAL]),
      });
      const { container } = render(<WorkflowSection controller={controller} />);
      fireEvent.click(
        within(validatorBlock(container)).getByRole("button", {
          name: "Add validator",
        }),
      );
      const ids =
        getState().workflowDefaults?.contextValidator?.assignments.map(
          (a) => a.id,
        ) ?? [];
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    });

    it("edits one assignment's instructions and runtime", () => {
      const { controller, getState } = makeController({
        workflowDefaults: cohortDefaults([GENERAL, SECURITY]),
      });
      const { container } = render(<WorkflowSection controller={controller} />);
      const block = validatorBlock(container);

      fireEvent.change(within(block).getByLabelText("Mandate for security"), {
        target: { value: "auth boundaries" },
      });
      expect(
        getState().workflowDefaults?.contextValidator?.assignments[1]?.focus,
      ).toBe("auth boundaries");

      fireEvent.click(
        within(
          within(validatorBlock(container)).getByTestId(
            "cohort-assignment-general",
          ),
        ).getByRole("button", { name: /codex/i }),
      );
      expect(
        getState().workflowDefaults?.contextValidator?.assignments[0]?.agent
          .backend,
      ).toBe("codex");
    });

    it("clears one assignment's instructions", () => {
      const { controller, getState } = makeController({
        workflowDefaults: cohortDefaults([
          GENERAL,
          { ...SECURITY, focus: "auth boundaries" },
        ]),
      });
      const { container } = render(<WorkflowSection controller={controller} />);

      fireEvent.change(
        within(validatorBlock(container)).getByLabelText(
          "Mandate for security",
        ),
        { target: { value: "" } },
      );

      expect(
        getState().workflowDefaults?.contextValidator?.assignments[1],
      ).not.toHaveProperty("focus");
    });

    /**
     * R12.1/R12.2 on the Settings consumer: the axis reaches this surface
     * because the shared editor carries it, not because Settings re-implements
     * it. The same assertions run against the builder and the live Config tab.
     */
    it("exposes the authority axis through the shared editor", () => {
      const { controller, getState } = makeController({
        workflowDefaults: cohortDefaults([GENERAL, SECURITY]),
      });
      const { container } = render(<WorkflowSection controller={controller} />);
      const block = validatorBlock(container);

      expect(
        within(block)
          .getAllByTestId("cohort-authority-badge")
          .map((badge) => badge.getAttribute("data-authority")),
      ).toEqual(["blocking", "blocking"]);

      const row = within(block).getByTestId("cohort-assignment-security");
      fireEvent.click(
        within(within(row).getByLabelText("Validator authority")).getByRole(
          "radio",
          { name: "advisory" },
        ),
      );
      expect(
        getState().workflowDefaults?.contextValidator?.assignments[1]
          ?.authority,
      ).toBe("advisory");
    });

    it("labels the instructions field from each seat's authority", () => {
      const { controller } = makeController({
        workflowDefaults: cohortDefaults([
          GENERAL,
          { ...SECURITY, authority: "advisory" },
        ]),
      });
      const { container } = render(<WorkflowSection controller={controller} />);
      const block = validatorBlock(container);

      expect(
        within(block).getByLabelText("Mandate for general"),
      ).toBeInTheDocument();
      expect(
        within(block).getByLabelText("Focus for security"),
      ).toBeInTheDocument();
    });

    it("names the tier the global cohort is in use at", () => {
      const { controller } = makeController({
        workflowDefaults: cohortDefaults([GENERAL]),
      });
      const { container } = render(<WorkflowSection controller={controller} />);
      const provenance = within(validatorBlock(container)).getByTestId(
        "cohort-cascade",
      );
      expect(provenance).toHaveAttribute("data-cascade-state", "use");
      expect(provenance.textContent).toContain("every workflow");
    });

    it("keeps a switched-off cohort dormant, visible, and restorable", () => {
      const { controller, getState } = makeController({
        workflowDefaults: cohortDefaults([GENERAL, SECURITY]),
      });
      const { container } = render(<WorkflowSection controller={controller} />);

      fireEvent.click(
        within(validatorBlock(container)).getByLabelText(
          "Context validator enabled",
        ),
      );
      const off = getState().workflowDefaults?.contextValidator;
      expect(off?.enabled).toBe(false);
      expect(off?.assignments.map((a) => a.id)).toEqual([
        "general",
        "security",
      ]);
    });

    it("shows a disabled cohort's dormant assignments and its cascade state", () => {
      const { controller } = makeController({
        workflowDefaults: cohortDefaults([GENERAL, SECURITY], false),
      });
      const { container } = render(<WorkflowSection controller={controller} />);
      const block = validatorBlock(container);

      expect(within(block).getByTestId("cohort-dormant-notice")).toBeVisible();
      expect(
        within(block)
          .getAllByTestId(/^cohort-assignment-/)
          .map((row) => row.getAttribute("data-dormant")),
      ).toEqual(["true", "true"]);
      expect(within(block).getByTestId("cohort-cascade")).toHaveAttribute(
        "data-cascade-state",
        "disabled",
      );
    });

    it("restores every dormant assignment, in order, when re-enabled", () => {
      const { controller, getState } = makeController({
        workflowDefaults: cohortDefaults([GENERAL, SECURITY], false),
      });
      const { container } = render(<WorkflowSection controller={controller} />);
      fireEvent.click(
        within(validatorBlock(container)).getByLabelText(
          "Context validator enabled",
        ),
      );
      const restored = getState().workflowDefaults?.contextValidator;
      expect(restored?.enabled).toBe(true);
      expect(restored?.assignments).toEqual([GENERAL, SECURITY]);
    });
  });
});
