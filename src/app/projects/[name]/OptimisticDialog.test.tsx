// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OptimisticDialog from "./OptimisticDialog";

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
  useVoiceRecorder: vi.fn(() => ({
    isRecording: false,
    isProcessing: false,
    elapsedTime: 0,
    isAvailable: false,
    toggleRecording: vi.fn(),
    stopRecording: vi.fn(),
  })),
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

describe("OptimisticDialog", () => {
  it("renders with Quick Task title", () => {
    renderWithQuery(<OptimisticDialog {...defaultProps} />);
    expect(screen.getByText("Quick Task")).toBeDefined();
  });

  it("returns null when open=false", () => {
    const { container } = renderWithQuery(
      <OptimisticDialog {...defaultProps} open={false} />,
    );
    expect(container.querySelector(".modal-overlay")).toBeNull();
  });

  it("shows instructions label and textarea", () => {
    renderWithQuery(<OptimisticDialog {...defaultProps} />);
    expect(screen.getByText("What should Claude do?")).toBeDefined();
    expect(
      screen.getByPlaceholderText("e.g. Fix the typo in the login page header"),
    ).toBeDefined();
  });

  it("shows form hint about merge behavior", () => {
    renderWithQuery(<OptimisticDialog {...defaultProps} />);
    expect(
      screen.getByText(
        "Claude will complete this task and merge the result into main",
      ),
    ).toBeDefined();
  });

  it("auto-focuses textarea when opened", () => {
    renderWithQuery(<OptimisticDialog {...defaultProps} />);
    vi.advanceTimersByTime(150);
    const textarea = screen.getByPlaceholderText(
      "e.g. Fix the typo in the login page header",
    );
    expect(document.activeElement).toBe(textarea);
  });

  it("disables submit when instructions are empty", () => {
    renderWithQuery(<OptimisticDialog {...defaultProps} />);
    const submitBtn = screen.getByText("Submit");
    expect(submitBtn.hasAttribute("disabled")).toBe(true);
  });

  it("enables submit when instructions have content", () => {
    renderWithQuery(<OptimisticDialog {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(
      "e.g. Fix the typo in the login page header",
    );
    fireEvent.change(textarea, { target: { value: "Fix the bug" } });
    const submitBtn = screen.getByText("Submit");
    expect(submitBtn.hasAttribute("disabled")).toBe(false);
  });

  it("submits optimistic request on Enter", () => {
    renderWithQuery(<OptimisticDialog {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(
      "e.g. Fix the typo in the login page header",
    );
    fireEvent.change(textarea, { target: { value: "Fix the login bug" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mutateMock).toHaveBeenCalledWith(
      { mode: "optimistic", instructions: "Fix the login bug" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("closes dialog on successful submission", () => {
    renderWithQuery(<OptimisticDialog {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(
      "e.g. Fix the typo in the login page header",
    );
    fireEvent.change(textarea, { target: { value: "Fix something" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    const onSuccess = mutateMock.mock.calls[0]?.[1]?.onSuccess;
    act(() => {
      onSuccess?.();
    });

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("closes on Escape key", () => {
    renderWithQuery(<OptimisticDialog {...defaultProps} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when overlay background is clicked", () => {
    const { container } = renderWithQuery(
      <OptimisticDialog {...defaultProps} />,
    );
    const overlay = container.querySelector(".modal-overlay")!;
    fireEvent.click(overlay);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });
});
