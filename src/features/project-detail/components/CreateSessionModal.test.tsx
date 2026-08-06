// @vitest-environment jsdom
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/test/component-mocks";
import CreateSessionModal from "./CreateSessionModal";

// Shared mocks
vi.mock(
  "next/navigation",
  async () => (await import("@/test/component-mocks")).nextNavigationMock,
);

// File-specific mocks
const mutateMock = vi.fn();

vi.mock("@/lib/sessions/mutations", () => ({
  useCreateSessionMutation: () => ({ mutate: mutateMock, isPending: false }),
}));

const defaultProps = {
  projectName: "my-project",
  open: true,
  onClose: vi.fn(),
};

beforeAll(() => {
  document.elementFromPoint = () => document.body;
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Switch modal to Optimistic mode by clicking the Optimistic button */
function switchToOptimisticMode() {
  fireEvent.click(screen.getByText("Optimistic"));
}

function getPromptInput(): HTMLElement {
  return screen.getByTestId("prompt-input");
}

async function enterPrompt(text: string): Promise<void> {
  const user = userEvent.setup();
  const editor = getPromptInput();
  await user.click(editor);
  await user.type(editor, text);
}

describe("CreateSessionModal", () => {
  it("renders modal with normal mode by default", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    expect(screen.getByText("New Session")).toBeInTheDocument();
    expect(screen.getByText("Session name")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create Session" }),
    ).toBeInTheDocument();
  });

  it("offers exactly two creation modes: Normal and Optimistic", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    expect(screen.getByText("Normal")).toBeInTheDocument();
    expect(screen.getByText("Optimistic")).toBeInTheDocument();
  });

  it("does not present a Focus creation mode or affordance", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    expect(screen.queryByText("Focus")).toBeNull();
    expect(screen.queryByText("Fast")).toBeNull();
  });

  it("renders no dialog when open=false", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} open={false} />);
    expect(screen.queryByText("New Session")).toBeNull();
    // Radix portals the content only while open, so no dialog is in the DOM.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("auto-focuses name input in normal mode", async () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("e.g. Copy To Clipboard");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("shows branch hint in normal mode", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    expect(
      screen.getByText("Branch name will be derived from the session name"),
    ).toBeInTheDocument();
  });

  it("disables create button when name is empty in normal mode", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const createBtn = screen.getByRole("button", { name: "Create Session" });
    expect(createBtn.hasAttribute("disabled")).toBe(true);
  });

  it("enables create button when name has content in normal mode", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("e.g. Copy To Clipboard");
    fireEvent.change(input, { target: { value: "My Session" } });
    const createBtn = screen.getByRole("button", { name: "Create Session" });
    expect(createBtn.hasAttribute("disabled")).toBe(false);
  });

  it("submits a normal-mode session on Enter", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("e.g. Copy To Clipboard");
    fireEvent.change(input, { target: { value: "My Session" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mutateMock).toHaveBeenCalledWith(
      {
        mode: "normal",
        sessionName: "My Session",
        tddEnabled: true,
        // Untouched picker means the Standard Agent explicitly, not an absent
        // selection the server has to guess at (R7.1).
        profile: { tier: "builtin", id: "standard-agent" },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  // R7.1: the session-kickoff path shows the picker on its Standard Agent
  // default, and the runtime cascade stays a separate concern from identity.
  it("offers a Standard-Agent-defaulted agent profile picker", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);

    expect(
      screen.getByRole("combobox", { name: /agent profile/i }),
    ).toHaveTextContent("Standard Agent");
  });

  it("calls onClose on Escape key press", () => {
    // Radix's DismissableLayer owns Escape now → onOpenChange(false) → onClose.
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when an outside interaction occurs", () => {
    // Radix closes on outside pointer-down by default; this form opts out via
    // onInteractOutside preventDefault, so a background interaction must NOT close.
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  describe("optimistic mode", () => {
    it("shows Optimistic button in mode toggle", () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      expect(screen.getByText("Optimistic")).toBeInTheDocument();
    });

    it("switches to optimistic mode and shows the rich instructions editor", () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
      expect(screen.getByText("What should Claude do?")).toBeInTheDocument();
      expect(getPromptInput()).toBeInTheDocument();
    });

    it("associates the instructions label with the rich editor", () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();

      expect(getPromptInput()).toHaveAttribute(
        "id",
        "session-instructions-input",
      );
    });

    it("shows optimistic-specific form hint", () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
      expect(
        screen.getByText(
          "Claude will complete this task and merge the result into main",
        ),
      ).toBeInTheDocument();
    });

    it("auto-focuses the rich editor in optimistic mode", async () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
      await waitFor(() =>
        expect(document.activeElement).toBe(getPromptInput()),
      );
    });

    it("enables create button when instructions have content", async () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
      await enterPrompt("Fix the bug");
      const createBtn = screen.getByRole("button", { name: "Create Session" });
      expect(createBtn.hasAttribute("disabled")).toBe(false);
    });

    it("disables create button when instructions are empty", () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
      const createBtn = screen.getByRole("button", { name: "Create Session" });
      expect(createBtn.hasAttribute("disabled")).toBe(true);
    });

    it("keeps plain Enter in the editor and submits on Ctrl+Enter", async () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
      await enterPrompt("Fix the login bug");
      const editor = getPromptInput();
      fireEvent.keyDown(editor, { key: "Enter" });

      expect(mutateMock).not.toHaveBeenCalled();

      fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

      expect(mutateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "optimistic",
          instructions: "Fix the login bug",
          tddEnabled: true,
        }),
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
    });

    it("allows multiline with Shift+Enter in optimistic mode", async () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
      await enterPrompt("line 1");
      fireEvent.keyDown(getPromptInput(), { key: "Enter", shiftKey: true });
      expect(mutateMock).not.toHaveBeenCalled();
    });

    it("closes dialog without navigation after successful optimistic creation", async () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
      await enterPrompt("Fix the bug");
      fireEvent.keyDown(getPromptInput(), { key: "Enter", ctrlKey: true });

      // Simulate successful creation
      const onSuccess = mutateMock.mock.calls[0]?.[1]?.onSuccess;
      act(() => {
        onSuccess?.({
          sessionName: "fix-bug",
          conversations: [{ id: "conv-1" }],
        });
      });

      // onClose should be called (fire-and-forget — no navigation)
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    describe("image support", () => {
      it("renders attach image button in optimistic mode", () => {
        renderWithQuery(<CreateSessionModal {...defaultProps} />);
        switchToOptimisticMode();
        expect(screen.getByTitle("Attach image")).toBeInTheDocument();
      });

      it("hides the attach image button in normal mode", () => {
        renderWithQuery(<CreateSessionModal {...defaultProps} />);
        expect(screen.getByTitle("Attach image")).not.toBeVisible();
      });

      it("retains the rich draft when toggling to normal mode and back", async () => {
        URL.createObjectURL = vi.fn(() => "blob:optimistic-draft");
        URL.revokeObjectURL = vi.fn();
        renderWithQuery(<CreateSessionModal {...defaultProps} />);
        switchToOptimisticMode();
        await enterPrompt("Use the reference image");
        const fileInput = document.querySelector(
          'input[type="file"]',
        ) as HTMLInputElement;
        fireEvent.change(fileInput, {
          target: {
            files: [
              new File(["image"], "reference.png", { type: "image/png" }),
            ],
          },
        });
        expect(await screen.findByAltText("reference.png")).toBeVisible();

        fireEvent.click(screen.getByRole("button", { name: "Normal" }));
        fireEvent.click(screen.getByRole("button", { name: "Optimistic" }));
        fireEvent.click(screen.getByRole("button", { name: "Create Session" }));

        await waitFor(() => expect(mutateMock).toHaveBeenCalledOnce());
        expect(mutateMock).toHaveBeenCalledWith(
          expect.objectContaining({
            instructions: "Use the reference image",
            images: [expect.objectContaining({ mediaType: "image/png" })],
          }),
          expect.anything(),
        );
      });
    });
  });
});
