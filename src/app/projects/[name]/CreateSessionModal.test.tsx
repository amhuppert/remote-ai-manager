// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CreateSessionModal from "./CreateSessionModal";

const mutateMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/mutations", () => ({
  useCreateSessionMutation: () => ({ mutate: mutateMock, isPending: false }),
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

const defaultProps = {
  projectName: "my-project",
  open: true,
  onClose: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CreateSessionModal", () => {
  it("renders modal content when open=true (Req 2.2)", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    expect(screen.getByText("New Session")).toBeDefined();
    expect(screen.getByText("Session Name")).toBeDefined();
    expect(screen.getByText("Create Session")).toBeDefined();
  });

  it("returns null when open=false", () => {
    const { container } = renderWithQuery(
      <CreateSessionModal {...defaultProps} open={false} />,
    );
    expect(container.querySelector(".modal-overlay")).toBeNull();
  });

  it("auto-focuses input on open (Req 2.2)", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    vi.advanceTimersByTime(150);
    const input = screen.getByPlaceholderText("e.g. implement-auth");
    expect(document.activeElement).toBe(input);
  });

  it("shows branch name preview as user types (Req 2.3)", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("e.g. implement-auth");
    fireEvent.change(input, { target: { value: "My Feature" } });
    expect(screen.getByText("Branch: csm/my-feature")).toBeDefined();
  });

  it("sanitizes branch preview (removes special chars, lowercases)", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("e.g. implement-auth");
    fireEvent.change(input, { target: { value: "Hello World!!!" } });
    expect(screen.getByText("Branch: csm/hello-world")).toBeDefined();
  });

  it("disables create button when name is empty (Req 2.3)", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const createBtn = screen.getByText("Create Session");
    expect(createBtn.hasAttribute("disabled")).toBe(true);
  });

  it("enables create button when name has content", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("e.g. implement-auth");
    fireEvent.change(input, { target: { value: "test" } });
    const createBtn = screen.getByText("Create Session");
    expect(createBtn.hasAttribute("disabled")).toBe(false);
  });

  it("calls onClose on Escape key press (Req 2.3)", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when overlay background clicked", () => {
    const { container } = renderWithQuery(
      <CreateSessionModal {...defaultProps} />,
    );
    const overlay = container.querySelector(".modal-overlay")!;
    Object.defineProperty(overlay, "tagName", { value: "DIV" });
    fireEvent.click(overlay);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("submits on Enter key in input (Req 2.3)", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("e.g. implement-auth");
    fireEvent.change(input, { target: { value: "new-session" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mutateMock).toHaveBeenCalledWith(
      "new-session",
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
