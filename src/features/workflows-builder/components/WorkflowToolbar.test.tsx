// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import WorkflowToolbar from "./WorkflowToolbar";

const defaultProps = {
  workflowName: "Test Workflow",
  revision: 2 as number | null,
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onAddContext: vi.fn(),
  onNewLane: vi.fn(),
  onSave: vi.fn(),
  onReset: vi.fn(),
  onRelayout: vi.fn(),
  dirty: false,
  saving: false,
  hasValidationErrors: false,
};

describe("WorkflowToolbar", () => {
  describe("desktop (isMobile=false)", () => {
    // README §2.2: drawing an empty lane is client-only UI, so the action is
    // always available — there is no draft state that could make it illegal.
    it("draws a new lane on request whether or not the draft is dirty", async () => {
      const onNewLane = vi.fn();
      render(<WorkflowToolbar {...defaultProps} onNewLane={onNewLane} />);

      await userEvent.click(screen.getByRole("button", { name: /New Lane/i }));

      expect(onNewLane).toHaveBeenCalledTimes(1);
    });

    it("shows all buttons inline", () => {
      render(<WorkflowToolbar {...defaultProps} />);
      expect(screen.getByText(/Add Context/)).toBeInTheDocument();
      expect(screen.getByText("New Lane")).toBeInTheDocument();
      expect(screen.getByText("Save Draft")).toBeInTheDocument();
      expect(screen.getByText("Reset")).toBeInTheDocument();
      expect(screen.getByText("Re-layout")).toBeInTheDocument();
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });

    // README §5: launching a template belongs to the session/template flow, and
    // the status cluster IS the validation surface.
    it("offers no Launch and no separate Validate action", () => {
      render(<WorkflowToolbar {...defaultProps} />);
      expect(
        screen.queryByRole("button", { name: /launch/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /^validate$/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe("inline rename", () => {
    it("commits on Enter", async () => {
      const user = userEvent.setup();
      const onRename = vi.fn();
      render(<WorkflowToolbar {...defaultProps} onRename={onRename} />);

      await user.click(screen.getByRole("button", { name: /Test Workflow/ }));
      const input = screen.getByRole("textbox", { name: /workflow name/i });
      await user.clear(input);
      await user.type(input, "Renamed{Enter}");

      expect(onRename).toHaveBeenCalledWith("Renamed");
    });

    it("cancels on Escape and keeps the original name", async () => {
      const user = userEvent.setup();
      const onRename = vi.fn();
      render(<WorkflowToolbar {...defaultProps} onRename={onRename} />);

      await user.click(screen.getByRole("button", { name: /Test Workflow/ }));
      const input = screen.getByRole("textbox", { name: /workflow name/i });
      await user.clear(input);
      await user.type(input, "Discarded{Escape}");

      expect(onRename).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: /Test Workflow/ }),
      ).toBeInTheDocument();
    });
  });

  describe("save states (README §5, B3)", () => {
    it("reads 'All changes saved' and disables Save and Reset when clean", () => {
      render(<WorkflowToolbar {...defaultProps} />);
      expect(screen.getByText("All changes saved")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save Draft" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    });

    it("reads 'Unsaved changes' and enables Save and Reset when dirty", () => {
      render(<WorkflowToolbar {...defaultProps} dirty />);
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save Draft" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();
    });

    it("reads 'Saving...' on the primary action while a save is in flight", () => {
      render(<WorkflowToolbar {...defaultProps} dirty saving />);
      expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    });

    it("blocks Save with a titled reason while validation errors exist", () => {
      render(<WorkflowToolbar {...defaultProps} dirty hasValidationErrors />);
      const save = screen.getByRole("button", { name: "Save Draft" });
      expect(save).toBeDisabled();
      expect(save).toHaveAttribute(
        "title",
        "Fix the validation errors before saving",
      );
    });

    it("blocks Save with a titled reason while the output schema is unacceptable", () => {
      render(<WorkflowToolbar {...defaultProps} dirty saveBlocked />);
      const save = screen.getByRole("button", { name: "Save Draft" });
      expect(save).toBeDisabled();
      expect(save).toHaveAttribute(
        "title",
        "The output schema is not accepted by the engine",
      );
    });
  });

  describe("status cluster", () => {
    it("marks the saved and unsaved states with a dot and the error state with an alert icon", () => {
      const { rerender } = render(<WorkflowToolbar {...defaultProps} />);
      expect(
        screen.getByTestId("workflow-save-status-dot"),
      ).toBeInTheDocument();

      rerender(<WorkflowToolbar {...defaultProps} dirty />);
      expect(
        screen.getByTestId("workflow-save-status-dot"),
      ).toBeInTheDocument();

      rerender(<WorkflowToolbar {...defaultProps} hasValidationErrors />);
      expect(screen.getByText("Validation errors")).toBeInTheDocument();
      expect(
        screen.getByTestId("workflow-save-status-alert"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("workflow-save-status-dot"),
      ).not.toBeInTheDocument();
    });
  });

  describe("icons are drawn, not typed (design-system rule)", () => {
    it("labels Workflow settings with an SVG rather than a Unicode glyph", () => {
      render(
        <WorkflowToolbar {...defaultProps} onOpenWorkflowSettings={vi.fn()} />,
      );
      const settings = screen.getByRole("button", {
        name: /workflow settings/i,
      });
      expect(settings.querySelector("svg")).not.toBeNull();
      expect(settings.textContent).not.toContain("⚙");
    });
  });

  describe("delete confirmation", () => {
    it("asks before deleting and only deletes on confirm", async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn();
      render(<WorkflowToolbar {...defaultProps} onDelete={onDelete} />);

      await user.click(screen.getByRole("button", { name: /^delete$/i }));
      expect(onDelete).not.toHaveBeenCalled();

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toBeInTheDocument();
      await user.click(
        screen.getByRole("button", { name: /delete workflow/i }),
      );
      expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it("does not delete when the confirmation is cancelled", async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn();
      render(<WorkflowToolbar {...defaultProps} onDelete={onDelete} />);

      await user.click(screen.getByRole("button", { name: /^delete$/i }));
      await screen.findByRole("alertdialog");
      await user.click(screen.getByRole("button", { name: /cancel/i }));

      expect(onDelete).not.toHaveBeenCalled();
    });
  });

  describe("mobile (isMobile=true)", () => {
    it("shows primary actions and overflow trigger", () => {
      render(<WorkflowToolbar {...defaultProps} isMobile />);
      expect(screen.getByText(/Add Context/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Save/i })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /More workflow actions/i }),
      ).toBeInTheDocument();
    });

    it("does not show Reset, Re-layout, Delete inline", () => {
      render(<WorkflowToolbar {...defaultProps} isMobile />);
      // These should be hidden inside the overflow menu
      expect(screen.queryByText("Reset")).not.toBeInTheDocument();
      expect(screen.queryByText("Re-layout")).not.toBeInTheDocument();
      expect(screen.queryByText("Delete")).not.toBeInTheDocument();
    });

    it("opens overflow menu with secondary actions on click", async () => {
      const user = userEvent.setup();
      render(<WorkflowToolbar {...defaultProps} isMobile />);

      await user.click(
        screen.getByRole("button", { name: /More workflow actions/i }),
      );

      expect(screen.getByText("Reset")).toBeInTheDocument();
      expect(screen.getByText("Re-layout")).toBeInTheDocument();
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });

    it("calls the correct handler from overflow menu", async () => {
      const user = userEvent.setup();
      const onReset = vi.fn();
      render(
        <WorkflowToolbar {...defaultProps} isMobile dirty onReset={onReset} />,
      );

      await user.click(
        screen.getByRole("button", { name: /More workflow actions/i }),
      );
      await user.click(screen.getByText("Reset"));
      expect(onReset).toHaveBeenCalledTimes(1);
    });

    it("shows save status", () => {
      render(<WorkflowToolbar {...defaultProps} isMobile dirty />);
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    });

    it("shows validation error status", () => {
      render(
        <WorkflowToolbar {...defaultProps} isMobile hasValidationErrors />,
      );
      expect(screen.getByText("Validation errors")).toBeInTheDocument();
    });

    it("confirms before deleting from the overflow menu", async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn();
      render(
        <WorkflowToolbar {...defaultProps} isMobile onDelete={onDelete} />,
      );

      await user.click(
        screen.getByRole("button", { name: /More workflow actions/i }),
      );
      await user.click(screen.getByText("Delete"));
      expect(onDelete).not.toHaveBeenCalled();

      await screen.findByRole("alertdialog");
      await user.click(
        screen.getByRole("button", { name: /delete workflow/i }),
      );
      expect(onDelete).toHaveBeenCalledTimes(1);
    });
  });

  describe("delete pending feedback", () => {
    it("shows Deleting… and disables the desktop delete button while deletion is in flight", () => {
      render(<WorkflowToolbar {...defaultProps} deleting />);
      const deleteBtn = screen.getByRole("button", { name: /deleting…/i });
      expect(deleteBtn).toBeDisabled();
      expect(screen.queryByText("Delete")).not.toBeInTheDocument();
    });

    it("shows Deleting… and disables the overflow delete item on mobile while deletion is in flight", async () => {
      const user = userEvent.setup();
      render(<WorkflowToolbar {...defaultProps} isMobile deleting />);
      await user.click(
        screen.getByRole("button", { name: /More workflow actions/i }),
      );
      const deleteItem = screen.getByRole("button", { name: /deleting…/i });
      expect(deleteItem).toBeDisabled();
    });
  });
});
