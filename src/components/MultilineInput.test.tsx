// @vitest-environment jsdom
import { createRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MultilineInput } from "./MultilineInput";

function ControlledInput({
  onPrimaryAction,
  onKeyDown,
  voiceProjectName,
  initialValue = "alpha beta\ngamma",
  isMac = false,
  readOnly = false,
  disabled = false,
}: {
  onPrimaryAction?: (value: string) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  voiceProjectName?: string;
  initialValue?: string;
  isMac?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  return (
    <MultilineInput
      aria-label="Instructions"
      value={value}
      onValueChange={setValue}
      onPrimaryAction={onPrimaryAction}
      onKeyDown={onKeyDown}
      voiceProjectName={voiceProjectName}
      isMac={isMac}
      readOnly={readOnly}
      disabled={disabled}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MultilineInput", () => {
  it("applies the shared shortcut vocabulary through a native textarea", () => {
    render(<ControlledInput />);
    const input = screen.getByRole("textbox", {
      name: "Instructions",
    }) as HTMLTextAreaElement;
    fireEvent.focus(input);
    input.setSelectionRange(10, 10);

    fireEvent.keyDown(input, { key: "w", ctrlKey: true });
    expect(input).toHaveValue("alpha \ngamma");
    expect(input.selectionStart).toBe(6);
    expect(input.selectionEnd).toBe(6);

    input.setSelectionRange(7, 7);
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    expect(input).toHaveValue("alpha \n");
  });

  it.each([
    ["a", { ctrlKey: true }, 8, 0],
    ["e", { ctrlKey: true }, 8, 10],
    ["b", { altKey: true }, 10, 6],
    ["f", { altKey: true }, 0, 5],
  ])(
    "applies value-preserving %s movement directly to the textarea",
    (key, modifiers, initialPosition, expectedPosition) => {
      render(<ControlledInput />);
      const input = screen.getByRole("textbox", {
        name: "Instructions",
      }) as HTMLTextAreaElement;
      input.setSelectionRange(initialPosition, initialPosition);

      fireEvent.keyDown(input, { key, ...modifiers });

      expect(input).toHaveValue("alpha beta\ngamma");
      expect(input.selectionStart).toBe(expectedPosition);
      expect(input.selectionEnd).toBe(expectedPosition);
    },
  );

  it("does not modify an empty leading line", () => {
    render(<ControlledInput initialValue={"\nalpha"} />);
    const input = screen.getByRole("textbox", {
      name: "Instructions",
    }) as HTMLTextAreaElement;
    expect(input.value).toBe("\nalpha");
    input.setSelectionRange(0, 0);

    fireEvent.keyDown(input, { key: "d", altKey: true });

    expect(input.value).toBe("\nalpha");
    expect(input.selectionStart).toBe(0);
  });

  it("uses only the platform submit chord and never submits on plain Enter", () => {
    const onPrimaryAction = vi.fn();
    render(<ControlledInput onPrimaryAction={onPrimaryAction} />);
    const input = screen.getByRole("textbox", { name: "Instructions" });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPrimaryAction).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(onPrimaryAction).toHaveBeenCalledOnce();

    fireEvent.keyDown(input, {
      key: "Enter",
      ctrlKey: true,
      metaKey: true,
    });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(onPrimaryAction).toHaveBeenCalledOnce();
  });

  it("uses only Cmd+Enter on macOS", () => {
    const onPrimaryAction = vi.fn();
    render(<ControlledInput onPrimaryAction={onPrimaryAction} isMac />);
    const input = screen.getByRole("textbox", { name: "Instructions" });

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, shiftKey: true });
    expect(onPrimaryAction).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onPrimaryAction).toHaveBeenCalledOnce();
  });

  it("does not replace the caller's Escape behavior", () => {
    const onKeyDown = vi.fn();
    render(<ControlledInput onKeyDown={onKeyDown} />);
    const input = screen.getByRole("textbox", { name: "Instructions" });

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onKeyDown).toHaveBeenCalledOnce();
  });

  it("forwards the textarea ref and preserves disabled and read-only states", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(
      <MultilineInput
        ref={ref}
        aria-label="Read-only instructions"
        value="draft"
        onValueChange={() => {}}
        disabled
        readOnly
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "Read-only instructions",
    });
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("readonly");
    expect(ref.current).toBe(input);
  });

  it("provides the shared voice affordance when a project is available", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ available: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ControlledInput voiceProjectName="example-project" />);

    expect(await screen.findByTitle("Voice input")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/voice/health");
  });

  it("reserves textarea space for an explicitly unavailable voice control", () => {
    render(
      <MultilineInput
        aria-label="Global instructions"
        value="draft"
        onValueChange={() => {}}
        voiceProjectName={null}
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "Global instructions" }),
    ).toHaveClass("pr-12", "pb-12");
    expect(
      screen.getByTitle("Voice input requires a project-scoped workflow"),
    ).toBeDisabled();
  });

  it("finalizes active dictation before the primary chord receives the value", async () => {
    class Recorder {
      static isTypeSupported(): boolean {
        return true;
      }
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      start(): void {
        this.state = "recording";
      }
      stop(): void {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"]) } as BlobEvent);
        this.onstop?.();
      }
    }
    const trackStop = vi.fn();
    vi.stubGlobal("MediaRecorder", Recorder);
    vi.stubGlobal("navigator", {
      ...navigator,
      platform: "Linux",
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: trackStop }],
        }),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("/api/voice/health")
          ? Response.json({ available: true })
          : Response.json({ text: "dictated" }),
      ),
    );
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const onPrimaryAction = vi.fn();
    const user = userEvent.setup();
    render(
      <ControlledInput
        voiceProjectName="example-project"
        initialValue="alpha"
        onPrimaryAction={onPrimaryAction}
      />,
    );

    await user.click(await screen.findByTitle("Voice input"));
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const input = screen.getByRole("textbox", {
      name: "Instructions",
    }) as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    await waitFor(() =>
      expect(onPrimaryAction).toHaveBeenCalledWith("alpha\ndictated"),
    );
    expect(trackStop).toHaveBeenCalledOnce();
  });

  it("clears a pending submit intent when dictation is cancelled by disable", async () => {
    class Recorder {
      static isTypeSupported(): boolean {
        return true;
      }
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      start(): void {
        this.state = "recording";
      }
      stop(): void {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"]) } as BlobEvent);
        this.onstop?.();
      }
    }
    let firstTranscriptionReject!: (reason?: unknown) => void;
    const firstTranscription = new Promise<Response>((_resolve, reject) => {
      firstTranscriptionReject = reject;
    });
    let transcriptionCount = 0;
    vi.stubGlobal("MediaRecorder", Recorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/api/voice/health")) {
          return Response.json({ available: true });
        }
        transcriptionCount += 1;
        if (transcriptionCount === 1) {
          init?.signal?.addEventListener("abort", () =>
            firstTranscriptionReject(new DOMException("Aborted", "AbortError")),
          );
          return await firstTranscription;
        }
        return Response.json({ text: "later" });
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const onPrimaryAction = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <ControlledInput
        voiceProjectName="example-project"
        initialValue="alpha"
        onPrimaryAction={onPrimaryAction}
      />,
    );

    await user.click(await screen.findByTitle("Voice input"));
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const input = screen.getByRole("textbox", {
      name: "Instructions",
    }) as HTMLTextAreaElement;
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(transcriptionCount).toBe(1));

    rerender(
      <ControlledInput
        voiceProjectName="example-project"
        initialValue="alpha"
        onPrimaryAction={onPrimaryAction}
        disabled
      />,
    );
    rerender(
      <ControlledInput
        voiceProjectName="example-project"
        initialValue="alpha"
        onPrimaryAction={onPrimaryAction}
      />,
    );
    (input as HTMLTextAreaElement).setSelectionRange(
      (input as HTMLTextAreaElement).value.length,
      (input as HTMLTextAreaElement).value.length,
    );
    await user.click(await screen.findByTitle("Voice input"));
    vi.spyOn(Date, "now").mockReturnValue(3_000);
    await user.click(screen.getByTitle("Stop recording"));

    await waitFor(() => expect(input).toHaveValue("alpha\nlater"));
    expect(onPrimaryAction).not.toHaveBeenCalled();
  });

  it("cancels a queued post-result action when disabled before the next frame", async () => {
    class Recorder {
      static isTypeSupported(): boolean {
        return true;
      }
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      start(): void {
        this.state = "recording";
      }
      stop(): void {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"]) } as BlobEvent);
        this.onstop?.();
      }
    }
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("MediaRecorder", Recorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("/api/voice/health")
          ? Response.json({ available: true })
          : Response.json({ text: "dictated" }),
      ),
    );
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const onPrimaryAction = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <ControlledInput
        voiceProjectName="example-project"
        initialValue="alpha"
        onPrimaryAction={onPrimaryAction}
      />,
    );

    await user.click(await screen.findByTitle("Voice input"));
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const input = screen.getByRole("textbox", {
      name: "Instructions",
    }) as HTMLTextAreaElement;
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(input).toHaveValue("alpha\ndictated"));
    expect(frames).toHaveLength(1);

    rerender(
      <ControlledInput
        voiceProjectName="example-project"
        initialValue="alpha"
        onPrimaryAction={onPrimaryAction}
        disabled
      />,
    );
    frames[0]?.(0);

    expect(onPrimaryAction).not.toHaveBeenCalled();
  });
});
