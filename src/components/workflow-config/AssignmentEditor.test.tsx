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
import { backendCatalogKeys } from "@/lib/agent-backends/query-keys";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
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
  authority: "blocking",

  agent: {
    backend: "claude",
    modelSelection: {
      modelId: "sonnet",
      parameters: { effort: "medium" },
    },
  },
};

function renderAssignment(
  props: Partial<React.ComponentProps<typeof AssignmentEditor>> = {},
) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(
    backendCatalogKeys.catalog(),
    listBackendCatalogEntries(),
  );
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
  it("allows Cursor staffing and displays its instruction-only limits", () => {
    const { onChange } = renderAssignment();
    expect(screen.queryByRole("note")).toBeNull();
    const cursor = screen.getByRole("button", { name: "Cursor" });
    expect(cursor).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(cursor);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ backend: "cursor" }),
      }),
    );
    cleanup();
    renderAssignment({
      value: {
        ...VALIDATOR,
        agent: {
          backend: "cursor",
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "true" },
          },
        },
      },
    });
    expect(screen.getByRole("note")).toHaveTextContent(
      "Read-only and file ownership limits rely on instructions",
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "may edit outside its assigned paths",
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "Network and native tool-approval limits are not enforced.",
    );
    expect(screen.getByRole("button", { name: "Cursor" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

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

  it("edits the use-site instructions", () => {
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
    const hint = screen.getByTestId("assignment-instructions-hint");
    expect(hint.textContent).toContain("```");
    expect(hint.textContent).toContain("<<<CC_AGENT_PROFILE");
  });

  it("refuses instructions that would terminate the profile block, naming the sequence", () => {
    renderAssignment({ value: { ...VALIDATOR, focus: "see ```ts" } });
    const error = screen.getByTestId("assignment-instructions-error");
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

  it("renders no authority control for a use site that has no authority", () => {
    renderAssignment();
    expect(
      screen.queryByLabelText("Validator authority"),
    ).not.toBeInTheDocument();
  });

  it("shows the selected authority for a use site that has one", () => {
    renderAssignment({ authority: { value: "blocking", onChange: vi.fn() } });
    const control = screen.getByLabelText("Validator authority");
    expect(
      within(control).getByRole("radio", { name: "blocking" }),
    ).toBeChecked();
    expect(
      within(control).getByRole("radio", { name: "advisory" }),
    ).not.toBeChecked();
  });

  it("switches an assignment from blocking to advisory", () => {
    const onAuthorityChange = vi.fn();
    renderAssignment({
      authority: { value: "blocking", onChange: onAuthorityChange },
    });
    const control = screen.getByLabelText("Validator authority");
    fireEvent.click(within(control).getByRole("radio", { name: "advisory" }));
    expect(onAuthorityChange).toHaveBeenCalledWith("advisory");
  });
});

/**
 * R12.2: one instructions field, two forces. The label and help are the only
 * place an author sees which one they are writing, so both states are pinned.
 */
describe("AssignmentEditor instructions field", () => {
  it("presents the instructions as the assignment's authoritative mandate when blocking", () => {
    renderAssignment({ authority: { value: "blocking", onChange: vi.fn() } });
    expect(screen.getByText("Mandate")).toBeInTheDocument();
    expect(
      screen.getByTestId("assignment-instructions-hint").textContent,
    ).toContain("authoritative mandate");
    expect(screen.getByLabelText("Mandate for security")).toBeInTheDocument();
  });

  it("presents the instructions as a subordinate profile focus when advisory", () => {
    renderAssignment({ authority: { value: "advisory", onChange: vi.fn() } });
    expect(screen.getByText("Focus")).toBeInTheDocument();
    expect(
      screen.getByTestId("assignment-instructions-hint").textContent,
    ).toContain("Subordinate");
    expect(screen.getByLabelText("Focus for security")).toBeInTheDocument();
  });

  it("writes to the same field whichever face is on screen", () => {
    const { onChange } = renderAssignment({
      authority: { value: "blocking", onChange: vi.fn() },
    });
    fireEvent.change(screen.getByLabelText("Mandate for security"), {
      target: { value: "no unbounded queries" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ focus: "no unbounded queries" }),
    );
  });

  it("falls back to the subordinate face where there is no authority axis", () => {
    renderAssignment();
    expect(screen.getByLabelText("Focus for security")).toBeInTheDocument();
    expect(screen.queryByText("Mandate")).not.toBeInTheDocument();
  });

  it("falls back to the global library when no project scopes the picker", () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(
      backendCatalogKeys.catalog(),
      listBackendCatalogEntries(),
    );
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
    queryClient.setQueryData(
      backendCatalogKeys.catalog(),
      listBackendCatalogEntries(),
    );
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

  it("composes the shared assignment editor with authority", () => {
    renderValidator();
    expect(screen.getByLabelText("Agent profile")).toBeInTheDocument();
    expect(screen.getByLabelText("Mandate for security")).toBeInTheDocument();
    expect(screen.getByLabelText("Validator authority")).toBeInTheDocument();
  });

  it("writes the authority back onto the assignment", () => {
    const { onChange } = renderValidator();
    const authority = screen.getByLabelText("Validator authority");
    fireEvent.click(within(authority).getByRole("radio", { name: "advisory" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "security", authority: "advisory" }),
    );
  });

  it("defaults the built-in acceptance-criteria profile to blocking when selected", () => {
    const { onChange } = renderValidator({
      value: { ...VALIDATOR, authority: "advisory" },
      open: true,
    });
    fireEvent.click(screen.getByRole("option", { name: /General Reviewer/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: { tier: "builtin", id: "general-reviewer" },
        authority: "blocking",
      }),
    );
  });

  it("defaults every other profile to advisory when selected", () => {
    const { onChange } = renderValidator({
      value: {
        ...VALIDATOR,
        profile: { tier: "builtin", id: "general-reviewer" },
        authority: "blocking",
      },
      open: true,
    });
    fireEvent.click(screen.getByRole("option", { name: /House Style/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: { tier: "project", id: "house-style" },
        authority: "advisory",
      }),
    );
  });

  it("labels the instructions field from the seat's own authority", () => {
    renderValidator({ value: { ...VALIDATOR, authority: "advisory" } });
    expect(screen.getByLabelText("Focus for security")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Mandate for security"),
    ).not.toBeInTheDocument();
  });

  it("edits the instructions through the wrapper", () => {
    const { onChange } = renderValidator();
    fireEvent.change(screen.getByLabelText("Mandate for security"), {
      target: { value: "auth boundaries" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ focus: "auth boundaries" }),
    );
  });

  // The wrapper carries axes the shared editor does not own, so it has to add
  // them back WITHOUT merging over the edit: a merge would restore the very key
  // clearing the field deletes, and the author would watch the old text return.
  it("carries a cleared instructions field through the wrapper instead of restoring the old text", () => {
    const { onChange } = renderValidator({
      value: { ...VALIDATOR, focus: "auth boundaries" },
    });
    fireEvent.change(screen.getByLabelText("Mandate for security"), {
      target: { value: "" },
    });
    const next = onChange.mock.calls[0]?.[0] as ValidatorAssignment | undefined;
    expect(next).not.toHaveProperty("focus");
    expect(next).toMatchObject({
      id: "security",
      authority: "blocking",
    });
  });
});
