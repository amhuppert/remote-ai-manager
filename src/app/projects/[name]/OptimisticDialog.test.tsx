// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import OptimisticDialog from "./OptimisticDialog";

// Shared mocks
vi.mock(
  "next/navigation",
  async () => (await import("@/test/component-mocks")).nextNavigationMock,
);
vi.mock(
  "@/hooks/useVoiceRecorder",
  async () => (await import("@/test/component-mocks")).voiceRecorderMock,
);
vi.mock(
  "@/components/VoiceRecordButton",
  async () => (await import("@/test/component-mocks")).voiceRecordButtonMock,
);

// File-specific mocks
const mutateMock = vi.fn();

vi.mock("@/lib/mutations", () => ({
  useCreateSessionMutation: () => ({ mutate: mutateMock, isPending: false }),
}));

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
    expect(screen.getByText("Quick Task")).toBeInTheDocument();
  });

  it("returns null when open=false", () => {
    renderWithQuery(<OptimisticDialog {...defaultProps} open={false} />);
    expect(screen.queryByTestId("modal-overlay")).toBeNull();
  });

  it("shows instructions label and textarea", () => {
    renderWithQuery(<OptimisticDialog {...defaultProps} />);
    expect(screen.getByText("What should Claude do?")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("e.g. Fix the typo in the login page header"),
    ).toBeInTheDocument();
  });

  it("shows form hint about merge behavior", () => {
    renderWithQuery(<OptimisticDialog {...defaultProps} />);
    expect(
      screen.getByText(
        "Claude will complete this task and merge the result into main",
      ),
    ).toBeInTheDocument();
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
      expect.objectContaining({
        mode: "optimistic",
        instructions: "Fix the login bug",
        tddEnabled: true,
      }),
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
    renderWithQuery(<OptimisticDialog {...defaultProps} />);
    const overlay = screen.getByTestId("modal-overlay");
    fireEvent.click(overlay);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });
});
