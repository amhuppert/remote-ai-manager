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
  onSave: vi.fn(),
  onReset: vi.fn(),
  onRelayout: vi.fn(),
  dirty: false,
  saving: false,
  hasValidationErrors: false,
};

describe("WorkflowToolbar", () => {
  describe("desktop (isMobile=false)", () => {
    it("shows all buttons inline", () => {
      render(<WorkflowToolbar {...defaultProps} />);
      expect(screen.getByText(/Add Context/)).toBeInTheDocument();
      expect(screen.getByText("Save Draft")).toBeInTheDocument();
      expect(screen.getByText("Reset")).toBeInTheDocument();
      expect(screen.getByText("Re-layout")).toBeInTheDocument();
      expect(screen.getByText("Delete")).toBeInTheDocument();
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
