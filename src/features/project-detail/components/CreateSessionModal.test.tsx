// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithQuery } from "@/test/component-mocks";
import CreateSessionModal from "./CreateSessionModal";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { useImageAttachments } from "@/hooks/use-image-attachments";

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
  "@/hooks/useAppHotkey",
  async () => (await import("@/test/component-mocks")).appHotkeyMock,
);
vi.mock(
  "@/components/VoiceRecordButton",
  async () => (await import("@/test/component-mocks")).voiceRecordButtonMock,
);

// File-specific mocks
const mutateMock = vi.fn();

vi.mock("@/lib/sessions/mutations", () => ({
  useCreateSessionMutation: () => ({ mutate: mutateMock, isPending: false }),
}));

const addImageMock = vi
  .fn()
  .mockResolvedValue({ attachment: null, error: null });
const removeImageMock = vi.fn();
const clearImagesMock = vi.fn();

vi.mock("@/hooks/use-image-attachments", () => ({
  useImageAttachments: vi.fn(() => ({
    pendingImages: [],
    addImage: addImageMock,
    removeImage: removeImageMock,
    clearImages: clearImagesMock,
    isAtLimit: false,
  })),
}));

vi.mock("@/components/ImageAttachmentPreview", () => ({
  default: ({
    images,
    onRemove,
  }: {
    images: { id: string; fileName: string }[];
    onRemove: (id: string) => void;
  }) =>
    images.length > 0 ? (
      <div data-testid="image-preview">
        {images.map((img) => (
          <button key={img.id} onClick={() => onRemove(img.id)}>
            Remove {img.fileName}
          </button>
        ))}
      </div>
    ) : null,
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

/** Switch modal to Focus mode by clicking the Focus button */
function switchToFocusMode() {
  fireEvent.click(screen.getByText("Focus"));
}

/** Switch modal to Optimistic mode by clicking the Optimistic button */
function switchToOptimisticMode() {
  fireEvent.click(screen.getByText("Optimistic"));
}

describe("CreateSessionModal", () => {
  it("renders modal with fast mode by default", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    expect(screen.getByText("New Session")).toBeInTheDocument();
    expect(screen.getByText("Session name")).toBeInTheDocument();
    expect(screen.getByText("Create Session")).toBeInTheDocument();
  });

  it("renders no dialog when open=false", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} open={false} />);
    expect(screen.queryByText("New Session")).toBeNull();
    // Radix portals the content only while open, so no dialog is in the DOM.
    expect(screen.queryByRole("dialog")).toBeNull();
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
    ).toBeInTheDocument();
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
      { mode: "fast", sessionName: "My Session", tddEnabled: true },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("switches to focus mode and shows objective textarea", () => {
    renderWithQuery(<CreateSessionModal {...defaultProps} />);
    switchToFocusMode();
    expect(
      screen.getByText("What do you want to work on?"),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(
        "e.g. Add user authentication with JWT tokens",
      ),
    ).toBeInTheDocument();
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
      { mode: "focus", objective: "Add user authentication", tddEnabled: true },
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

  describe("stop-and-submit gesture (Enter while recording)", () => {
    /**
     * Helper: build a useVoiceRecorder mock whose `isRecording` flips to false
     * when `toggleRecording` is invoked, mirroring real recorder behavior so
     * that downstream re-renders see the updated state.
     */
    function installRecordingMock(): {
      capturedOnResult: () => ((text: string) => void) | undefined;
      toggleRecording: ReturnType<typeof vi.fn>;
    } {
      let onResult: ((text: string) => void) | undefined;
      let recording = true;
      const toggleRecording = vi.fn(() => {
        recording = false;
      });
      vi.mocked(useVoiceRecorder).mockImplementation(((opts: {
        onResult: (text: string) => void;
      }) => {
        onResult = opts.onResult;
        return {
          isRecording: recording,
          isProcessing: false,
          elapsedTime: 0,
          isAvailable: true,
          toggleRecording,
          stopRecording: vi.fn(),
        };
      }) as typeof useVoiceRecorder);
      return { capturedOnResult: () => onResult, toggleRecording };
    }

    afterEach(() => {
      // Restore the default mock so subsequent tests don't inherit isRecording: true
      vi.mocked(useVoiceRecorder).mockImplementation(() => ({
        isRecording: false,
        isProcessing: false,
        elapsedTime: 0,
        isAvailable: false,
        toggleRecording: vi.fn(),
        stopRecording: vi.fn(),
      }));
    });

    it("auto-creates session when Enter is pressed while recording in focus mode", () => {
      const { capturedOnResult, toggleRecording } = installRecordingMock();

      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToFocusMode();

      const textarea = screen.getByPlaceholderText(
        "e.g. Add user authentication with JWT tokens",
      );
      act(() => {
        fireEvent.keyDown(textarea, { key: "Enter" });
      });

      expect(toggleRecording).toHaveBeenCalledTimes(1);
      expect(mutateMock).not.toHaveBeenCalled();

      const onResult = capturedOnResult();
      expect(onResult).toBeDefined();
      act(() => {
        onResult!("Add user authentication");
      });

      expect(mutateMock).toHaveBeenCalledWith(
        {
          mode: "focus",
          objective: "Add user authentication",
          tddEnabled: true,
        },
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
    });

    it("Alt+V to stop recording does NOT auto-create the session (only Enter does)", () => {
      const { capturedOnResult } = installRecordingMock();

      vi.mocked(useAppHotkey).mockClear();

      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToFocusMode();

      const vtCall = vi
        .mocked(useAppHotkey)
        .mock.calls.find(([id]) => id === "voiceToggle");
      expect(vtCall).toBeDefined();
      act(() => {
        vtCall![1]({} as KeyboardEvent);
      });

      act(() => {
        capturedOnResult()!("Add user authentication");
      });

      expect(mutateMock).not.toHaveBeenCalled();
    });
  });

  describe("optimistic mode", () => {
    it("shows Optimistic button in mode toggle", () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      expect(screen.getByText("Optimistic")).toBeInTheDocument();
    });

    it("switches to optimistic mode and shows instructions textarea", () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
      expect(screen.getByText("What should Claude do?")).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(
          "e.g. Fix the typo in the login page header",
        ),
      ).toBeInTheDocument();
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

    it("auto-focuses textarea in optimistic mode", () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
      vi.advanceTimersByTime(150);
      const textarea = screen.getByPlaceholderText(
        "e.g. Fix the typo in the login page header",
      );
      expect(document.activeElement).toBe(textarea);
    });

    it("enables create button when instructions have content", () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
      const textarea = screen.getByPlaceholderText(
        "e.g. Fix the typo in the login page header",
      );
      fireEvent.change(textarea, { target: { value: "Fix the bug" } });
      const createBtn = screen.getByText("Create Session");
      expect(createBtn.hasAttribute("disabled")).toBe(false);
    });

    it("disables create button when instructions are empty", () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
      const createBtn = screen.getByText("Create Session");
      expect(createBtn.hasAttribute("disabled")).toBe(true);
    });

    it("submits instructions on Enter key", () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
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

    it("closes dialog without navigation after successful optimistic creation", () => {
      renderWithQuery(<CreateSessionModal {...defaultProps} />);
      switchToOptimisticMode();
      const textarea = screen.getByPlaceholderText(
        "e.g. Fix the typo in the login page header",
      );
      fireEvent.change(textarea, { target: { value: "Fix the bug" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

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

      it("does NOT render attach image button in fast mode", () => {
        renderWithQuery(<CreateSessionModal {...defaultProps} />);
        expect(screen.queryByTitle("Attach image")).toBeNull();
      });

      it("does NOT render attach image button in focus mode", () => {
        renderWithQuery(<CreateSessionModal {...defaultProps} />);
        switchToFocusMode();
        expect(screen.queryByTitle("Attach image")).toBeNull();
      });

      it("calls addImage when an image is pasted in optimistic mode", async () => {
        renderWithQuery(<CreateSessionModal {...defaultProps} />);
        switchToOptimisticMode();
        const textarea = screen.getByPlaceholderText(
          "e.g. Fix the typo in the login page header",
        );

        const file = new File(["fake-image"], "screenshot.png", {
          type: "image/png",
        });
        const pasteEvent = new Event("paste", { bubbles: true });
        Object.defineProperty(pasteEvent, "clipboardData", {
          value: {
            items: [
              {
                type: "image/png",
                getAsFile: () => file,
              },
            ],
          },
        });

        fireEvent(textarea, pasteEvent);

        expect(addImageMock).toHaveBeenCalledWith(file);
      });

      it("enables submit with images even when text is empty", () => {
        vi.mocked(useImageAttachments).mockReturnValue({
          pendingImages: [
            {
              id: "img-1",
              fileName: "test.png",
              mediaType: "image/png",
              base64Data: "abc123",
              previewUrl: "blob:test",
              sizeBytes: 1000,
            },
          ],
          addImage: addImageMock,
          removeImage: removeImageMock,
          clearImages: clearImagesMock,
          isAtLimit: false,
        });

        renderWithQuery(<CreateSessionModal {...defaultProps} />);
        switchToOptimisticMode();
        const createBtn = screen.getByText("Create Session");
        expect(createBtn.hasAttribute("disabled")).toBe(false);
      });

      it("includes images in mutation payload when submitting", () => {
        vi.mocked(useImageAttachments).mockReturnValue({
          pendingImages: [
            {
              id: "img-1",
              fileName: "test.png",
              mediaType: "image/png",
              base64Data: "abc123",
              previewUrl: "blob:test",
              sizeBytes: 1000,
            },
          ],
          addImage: addImageMock,
          removeImage: removeImageMock,
          clearImages: clearImagesMock,
          isAtLimit: false,
        });

        renderWithQuery(<CreateSessionModal {...defaultProps} />);
        switchToOptimisticMode();
        const textarea = screen.getByPlaceholderText(
          "e.g. Fix the typo in the login page header",
        );
        fireEvent.change(textarea, {
          target: { value: "Fix with this screenshot" },
        });
        fireEvent.keyDown(textarea, { key: "Enter" });

        expect(mutateMock).toHaveBeenCalledWith(
          {
            mode: "optimistic",
            instructions: "Fix with this screenshot",
            images: [
              {
                attachmentId: "img-1",
                mediaType: "image/png",
                base64Data: "abc123",
              },
            ],
            tddEnabled: true,
          },
          expect.objectContaining({ onSuccess: expect.any(Function) }),
        );
      });

      it("renders ImageAttachmentPreview when images are pending", () => {
        vi.mocked(useImageAttachments).mockReturnValue({
          pendingImages: [
            {
              id: "img-1",
              fileName: "test.png",
              mediaType: "image/png",
              base64Data: "abc123",
              previewUrl: "blob:test",
              sizeBytes: 1000,
            },
          ],
          addImage: addImageMock,
          removeImage: removeImageMock,
          clearImages: clearImagesMock,
          isAtLimit: false,
        });

        renderWithQuery(<CreateSessionModal {...defaultProps} />);
        switchToOptimisticMode();
        expect(screen.getByTestId("image-preview")).toBeInTheDocument();
      });

      it("clears images when dialog reopens", () => {
        const { rerender } = renderWithQuery(
          <CreateSessionModal {...defaultProps} open={true} />,
        );
        switchToOptimisticMode();

        // Close — rerender needs explicit QueryClientProvider since
        // renderWithQuery doesn't use testing-library's wrapper option
        rerender(
          <QueryClientProvider
            client={
              new QueryClient({
                defaultOptions: { queries: { retry: false } },
              })
            }
          >
            <CreateSessionModal {...defaultProps} open={false} />
          </QueryClientProvider>,
        );

        clearImagesMock.mockClear();

        // Reopen
        rerender(
          <QueryClientProvider
            client={
              new QueryClient({
                defaultOptions: { queries: { retry: false } },
              })
            }
          >
            <CreateSessionModal {...defaultProps} open={true} />
          </QueryClientProvider>,
        );

        expect(clearImagesMock).toHaveBeenCalled();
      });
    });
  });
});
