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

vi.mock("@/hooks/useVoiceRecorder", () => ({
  useVoiceRecorder: () => ({
    isRecording: false,
    isProcessing: false,
    elapsedTime: 0,
    isAvailable: false,
    toggleRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}));

vi.mock("@/components/VoiceRecordButton", () => ({
  VoiceRecordButton: () => null,
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
  it("renders modal content when open=true", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    expect(screen.getByText("New Session")).toBeDefined();
    expect(screen.getByText("What do you want to work on?")).toBeDefined();
    expect(screen.getByText("Create Session")).toBeDefined();
  });

  it("returns null when open=false", () => {
    const { container } = renderWithQuery(
      <CreateSessionModal {...defaultProps} open={false} />,
    );
    expect(container.querySelector(".modal-overlay")).toBeNull();
  });

  it("auto-focuses textarea on open", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    vi.advanceTimersByTime(150);
    const textarea = screen.getByPlaceholderText(
      "e.g. Add user authentication with JWT tokens",
    );
    expect(document.activeElement).toBe(textarea);
  });

  it("shows auto-generation hint", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    expect(
      screen.getByText("Session name and branch will be auto-generated"),
    ).toBeDefined();
  });

  it("shows character count", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    expect(screen.getByText("0/500")).toBeDefined();

    const textarea = screen.getByPlaceholderText(
      "e.g. Add user authentication with JWT tokens",
    );
    fireEvent.change(textarea, { target: { value: "test objective" } });
    expect(screen.getByText("14/500")).toBeDefined();
  });

  it("disables create button when objective is empty", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const createBtn = screen.getByText("Create Session");
    expect(createBtn.hasAttribute("disabled")).toBe(true);
  });

  it("enables create button when objective has content", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(
      "e.g. Add user authentication with JWT tokens",
    );
    fireEvent.change(textarea, { target: { value: "Add auth" } });
    const createBtn = screen.getByText("Create Session");
    expect(createBtn.hasAttribute("disabled")).toBe(false);
  });

  it("calls onClose on Escape key press", () => {
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

  it("submits objective on Enter key in textarea", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(
      "e.g. Add user authentication with JWT tokens",
    );
    fireEvent.change(textarea, {
      target: { value: "Add user authentication" },
    });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mutateMock).toHaveBeenCalledWith(
      "Add user authentication",
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("allows multiline with Shift+Enter", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(
      "e.g. Add user authentication with JWT tokens",
    );
    fireEvent.change(textarea, { target: { value: "line 1" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(mutateMock).not.toHaveBeenCalled();
  });
});
