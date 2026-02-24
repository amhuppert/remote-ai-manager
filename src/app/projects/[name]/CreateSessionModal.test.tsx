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

/** Switch modal to Focus mode by clicking the Focus button */
function switchToFocusMode() {
  fireEvent.click(screen.getByText("Focus"));
}

describe("CreateSessionModal", () => {
  it("renders modal with fast mode by default", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    expect(screen.getByText("New Session")).toBeDefined();
    expect(screen.getByText("Session name")).toBeDefined();
    expect(screen.getByText("Create Session")).toBeDefined();
  });

  it("returns null when open=false", () => {
    const { container } = renderWithQuery(
      <CreateSessionModal {...defaultProps} open={false} />,
    );
    expect(container.querySelector(".modal-overlay")).toBeNull();
  });

  it("auto-focuses name input in fast mode", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    vi.advanceTimersByTime(150);
    const input = screen.getByPlaceholderText("e.g. Copy To Clipboard");
    expect(document.activeElement).toBe(input);
  });

  it("shows branch hint in fast mode", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    expect(
      screen.getByText("Branch name will be derived from the session name"),
    ).toBeDefined();
  });

  it("disables create button when name is empty in fast mode", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const createBtn = screen.getByText("Create Session");
    expect(createBtn.hasAttribute("disabled")).toBe(true);
  });

  it("enables create button when name has content in fast mode", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("e.g. Copy To Clipboard");
    fireEvent.change(input, { target: { value: "My Session" } });
    const createBtn = screen.getByText("Create Session");
    expect(createBtn.hasAttribute("disabled")).toBe(false);
  });

  it("submits session name on Enter in fast mode", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("e.g. Copy To Clipboard");
    fireEvent.change(input, { target: { value: "My Session" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mutateMock).toHaveBeenCalledWith(
      { mode: "fast", sessionName: "My Session" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("switches to focus mode and shows objective textarea", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    switchToFocusMode();
    expect(screen.getByText("What do you want to work on?")).toBeDefined();
    expect(
      screen.getByPlaceholderText(
        "e.g. Add user authentication with JWT tokens",
      ),
    ).toBeDefined();
  });

  it("auto-focuses textarea in focus mode", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    switchToFocusMode();
    vi.advanceTimersByTime(150);
    const textarea = screen.getByPlaceholderText(
      "e.g. Add user authentication with JWT tokens",
    );
    expect(document.activeElement).toBe(textarea);
  });

  it("enables create button when objective has content in focus mode", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    switchToFocusMode();
    const textarea = screen.getByPlaceholderText(
      "e.g. Add user authentication with JWT tokens",
    );
    fireEvent.change(textarea, { target: { value: "Add auth" } });
    const createBtn = screen.getByText("Create Session");
    expect(createBtn.hasAttribute("disabled")).toBe(false);
  });

  it("submits objective on Enter key in focus mode", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    switchToFocusMode();
    const textarea = screen.getByPlaceholderText(
      "e.g. Add user authentication with JWT tokens",
    );
    fireEvent.change(textarea, {
      target: { value: "Add user authentication" },
    });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mutateMock).toHaveBeenCalledWith(
      { mode: "focus", objective: "Add user authentication" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("allows multiline with Shift+Enter in focus mode", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    switchToFocusMode();
    const textarea = screen.getByPlaceholderText(
      "e.g. Add user authentication with JWT tokens",
    );
    fireEvent.change(textarea, { target: { value: "line 1" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(mutateMock).not.toHaveBeenCalled();
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
});
