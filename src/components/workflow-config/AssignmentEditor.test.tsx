// @vitest-environment jsdom
/**
 * The one assignment editor every workflow surface renders (R12/D11).
 *
 * Driven through the production library query key so the profile picker's
 * wiring is what is exercised here, not a hand-passed option list.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { agentProfileKeys } from "@/lib/agent-profiles/query-keys";
import type { AgentProfileLibraryListing } from "@/lib/agent-profiles/schemas";
import type {
  AgentAssignment,
  ValidatorAssignment,
} from "@/lib/workflow-graph/config-schemas";
import { AssignmentEditor } from "./AssignmentEditor";
import { ContextValidatorEditor } from "./FieldEditors";

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
      ref: { tier: "project", id: "house-style" },
      name: "House Style",
      description: "Writes the way this repo writes.",
      revision: 2,
      recommendedFor: ["workflow_implementer"],
      tags: [],
      readOnly: false,
    },
  ],
  diagnostics: [],
};

const VALIDATOR: ValidatorAssignment = {
  id: "security",
  profile: { tier: "project", id: "house-style" },
  strategy: "conversation",
  continuity: { enabled: true },
  agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
};

function renderAssignment(
  props: Partial<React.ComponentProps<typeof AssignmentEditor>> = {},
) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(agentProfileKeys.projectList(PROJECT), LISTING);
  const onChange = vi.fn();
  const value: AgentAssignment = props.value ?? VALIDATOR;
  const view = renderWithQuery(
    <AssignmentEditor
      value={value}
      onChange={onChange}
      libraryProjectName={PROJECT}
      audience="workflow_validator"
      {...props}
    />,
    queryClient,
  );
  return { onChange, queryClient, ...view };
}

describe("AssignmentEditor", () => {
  it("shows the assigned profile and its tier badge from the library listing", () => {
    renderAssignment();
    const trigger = screen.getByLabelText("Agent profile");
    expect(trigger.textContent).toContain("House Style");
    expect(trigger.textContent).toContain("Project");
  });

  it("replaces the profile reference when a different profile is picked", () => {
    const { onChange } = renderAssignment({ open: true });
    fireEvent.click(screen.getByRole("option", { name: /General Reviewer/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "security",
        profile: { tier: "builtin", id: "general-reviewer" },
      }),
    );
  });

  it("edits the use-site focus", () => {
    const { onChange } = renderAssignment();
    fireEvent.change(screen.getByLabelText("Focus for security"), {
      target: { value: "auth boundaries" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ focus: "auth boundaries" }),
    );
  });

  it("drops the focus key rather than storing an empty steer", () => {
    const { onChange } = renderAssignment({
      value: { ...VALIDATOR, focus: "auth boundaries" },
    });
    fireEvent.change(screen.getByLabelText("Focus for security"), {
      target: { value: "   " },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("focus");
  });

  it("surfaces the composer's refusal rules inline before they are tripped", () => {
    renderAssignment();
    const hint = screen.getByTestId("assignment-focus-hint");
    expect(hint.textContent).toContain("```");
    expect(hint.textContent).toContain("<<<CC_AGENT_PROFILE");
  });

  it("refuses a focus that would terminate the profile block, naming the sequence", () => {
    renderAssignment({ value: { ...VALIDATOR, focus: "see ```ts" } });
    const error = screen.getByTestId("assignment-focus-error");
    expect(error.textContent).toContain("```");
    expect(screen.getByLabelText("Focus for security")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("edits the runtime without disturbing the profile reference", () => {
    const { onChange } = renderAssignment();
    fireEvent.click(screen.getByRole("button", { name: /codex/i }));
    const next = onChange.mock.calls[0]?.[0] as AgentAssignment | undefined;
    expect(next?.agent.backend).toBe("codex");
    expect(next?.profile).toEqual({ tier: "project", id: "house-style" });
  });

  it("renders no strategy selector for a use site that has no strategy", () => {
    renderAssignment();
    expect(
      screen.queryByLabelText("Validator execution strategy"),
    ).not.toBeInTheDocument();
  });

  it("renders the strategy selector for a use site that has one", () => {
    renderAssignment({
      strategy: { value: "conversation", onChange: vi.fn() },
    });
    expect(
      screen.getByLabelText("Validator execution strategy"),
    ).toBeInTheDocument();
  });

  it("falls back to the global library when no project scopes the picker", () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(agentProfileKeys.globalList(), LISTING);
    renderWithQuery(
      <AssignmentEditor
        value={VALIDATOR}
        onChange={vi.fn()}
        audience="workflow_validator"
      />,
      queryClient,
    );
    expect(screen.getByLabelText("Agent profile").textContent).toContain(
      "House Style",
    );
  });
});

describe("ContextValidatorEditor", () => {
  function renderValidator(
    props: Partial<React.ComponentProps<typeof ContextValidatorEditor>> = {},
  ) {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(agentProfileKeys.projectList(PROJECT), LISTING);
    const onChange = vi.fn();
    const view = renderWithQuery(
      <ContextValidatorEditor
        value={VALIDATOR}
        onChange={onChange}
        libraryProjectName={PROJECT}
        {...props}
      />,
      queryClient,
    );
    return { onChange, ...view };
  }

  it("composes the shared assignment editor with strategy and continuity", () => {
    renderValidator();
    expect(screen.getByLabelText("Agent profile")).toBeInTheDocument();
    expect(screen.getByLabelText("Focus for security")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Validator execution strategy"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Continuity enabled for security"),
    ).toBeInTheDocument();
  });

  it("switches the execution strategy", () => {
    const { onChange } = renderValidator();
    const strategy = screen.getByLabelText("Validator execution strategy");
    fireEvent.click(within(strategy).getByRole("radio", { name: "task" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "task" }),
    );
  });
});
