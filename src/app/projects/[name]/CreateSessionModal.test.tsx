// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CreateSessionModal from "./CreateSessionModal";

const defaultProps = {
  projectName: "my-project",
  open: true,
  onClose: vi.fn(),
  onCreated: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CreateSessionModal", () => {
  it("renders modal content when open=true (Req 2.2)", () => {
    render(<CreateSessionModal {...defaultProps} />);
    expect(screen.getByText("New Session")).toBeDefined();
    expect(screen.getByText("Session Name")).toBeDefined();
    expect(screen.getByText("Create Session")).toBeDefined();
  });

  it("returns null when open=false", () => {
    const { container } = render(
      <CreateSessionModal {...defaultProps} open={false} />,
    );
    expect(container.querySelector(".modal-overlay")).toBeNull();
  });

  it("auto-focuses input on open (Req 2.2)", () => {
    render(<CreateSessionModal {...defaultProps} />);
    vi.advanceTimersByTime(150);
    const input = screen.getByPlaceholderText("e.g. implement-auth");
    expect(document.activeElement).toBe(input);
  });

  it("shows branch name preview as user types (Req 2.3)", () => {
    render(<CreateSessionModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("e.g. implement-auth");
    fireEvent.change(input, { target: { value: "My Feature" } });
    expect(screen.getByText("Branch: csm/my-feature")).toBeDefined();
  });

  it("sanitizes branch preview (removes special chars, lowercases)", () => {
    render(<CreateSessionModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("e.g. implement-auth");
    fireEvent.change(input, { target: { value: "Hello World!!!" } });
    expect(screen.getByText("Branch: csm/hello-world")).toBeDefined();
  });

  it("disables create button when name is empty (Req 2.3)", () => {
    render(<CreateSessionModal {...defaultProps} />);
    const createBtn = screen.getByText("Create Session");
    expect(createBtn.hasAttribute("disabled")).toBe(true);
  });

  it("enables create button when name has content", () => {
    render(<CreateSessionModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("e.g. implement-auth");
    fireEvent.change(input, { target: { value: "test" } });
    const createBtn = screen.getByText("Create Session");
    expect(createBtn.hasAttribute("disabled")).toBe(false);
  });

  it("calls onClose on Escape key press (Req 2.3)", () => {
    render(<CreateSessionModal {...defaultProps} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when overlay background clicked", () => {
    const { container } = render(<CreateSessionModal {...defaultProps} />);
    const overlay = container.querySelector(".modal-overlay")!;
    // Simulate clicking on overlay itself (target === currentTarget)
    Object.defineProperty(overlay, "tagName", { value: "DIV" });
    fireEvent.click(overlay);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("submits on Enter key in input (Req 2.3)", () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    render(<CreateSessionModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("e.g. implement-auth");
    fireEvent.change(input, { target: { value: "new-session" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/projects/my-project/sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
