// @vitest-environment jsdom
import { createRef, useState } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithQuery as render } from "@/test/component-mocks";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RichPromptInput, type RichPromptInputHandle } from "./RichPromptInput";

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
  URL.createObjectURL = () => "blob:rich-prompt-test";
  URL.revokeObjectURL = () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function RichPromptFixture({
  onSubmit,
  initialImages,
  onDocumentChange,
}: {
  onSubmit: ReturnType<typeof vi.fn>;
  onDocumentChange?: ReturnType<typeof vi.fn>;
  initialImages?: Array<{
    attachmentId: string;
    mediaType: "image/png";
    base64Data: string;
  }>;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  return (
    <RichPromptInput
      capabilityContext={{ projectName: "command-center" }}
      value={value}
      onValueChange={setValue}
      onSubmit={onSubmit}
      onDocumentChange={onDocumentChange}
      initialImages={initialImages}
      ariaLabel="Initial prompt"
      submitLabel="Create session"
    />
  );
}

describe("RichPromptInput", () => {
  it("submits the shared prompt document from a project-scoped pre-session editor", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<RichPromptFixture onSubmit={onSubmit} />);

    const editor = screen.getByTestId("prompt-input");
    await user.click(editor);
    await user.type(editor, "Create the richer input");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(onSubmit).toHaveBeenCalledWith({
      prompt: "Create the richer input",
      images: [],
    });
  });

  it("keeps the attach and voice affordances available without a session id", () => {
    render(<RichPromptFixture onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Attach image" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Create session" }),
    ).toBeDisabled();
  });

  it("serializes picker images in attachment order", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { container } = render(<RichPromptFixture onSubmit={onSubmit} />);
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.png", {
      type: "image/png",
    });

    fireEvent.change(fileInput, { target: { files: [first, second] } });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create session" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Create session" }));

    expect(onSubmit).toHaveBeenCalledWith({
      prompt: "",
      images: [
        expect.objectContaining({
          attachmentId: "img-1",
          mediaType: "image/png",
        }),
        expect.objectContaining({
          attachmentId: "img-2",
          mediaType: "image/png",
        }),
      ],
    });
  });

  it("retains previously selected images when an editing surface remounts", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <RichPromptFixture
        onSubmit={onSubmit}
        initialImages={[
          {
            attachmentId: "persisted-image",
            mediaType: "image/png",
            base64Data: "cGVyc2lzdGVk",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create session" }));

    expect(onSubmit).toHaveBeenCalledWith({
      prompt: "",
      images: [expect.objectContaining({ attachmentId: "persisted-image" })],
    });
  });

  it("submits an empty document when allowEmptySubmit is set", async () => {
    const onSubmit = vi.fn();
    const ref = createRef<RichPromptInputHandle>();
    render(
      <RichPromptInput
        ref={ref}
        capabilityContext={{ projectName: "command-center" }}
        value=""
        onValueChange={() => {}}
        onSubmit={onSubmit}
        ariaLabel="Description"
        submitLabel="Create ticket"
        allowEmptySubmit
      />,
    );

    act(() => ref.current?.primaryAction());

    expect(onSubmit).toHaveBeenCalledWith({ prompt: "", images: [] });
  });

  it("treats a reference-only document as submittable and reports canonical markup", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onDocumentChange = vi.fn();
    const { container } = render(
      <RichPromptFixture
        onSubmit={onSubmit}
        onDocumentChange={onDocumentChange}
      />,
    );
    const reference =
      '<ticket-ref project-name="command-center" ticket-number="12" ' +
      'identifier="command-center#12" title="Harden ticket context" ' +
      'read-command="cctl ticket get &apos;command-center#12&apos;" />';
    const editor = container.querySelector(".ProseMirror") as HTMLElement;

    fireEvent.paste(editor, {
      clipboardData: {
        items: [],
        files: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? reference : ""),
      },
    });

    const submit = screen.getByRole("button", { name: "Create session" });
    expect(submit).toBeEnabled();
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      prompt: reference,
      images: [],
    });

    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ prompt: reference, images: [] });
  });

  it("finalizes dictation before an external primary action serializes the document", async () => {
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
    const ref = createRef<RichPromptInputHandle>();
    const onSubmit = vi.fn();
    render(
      <RichPromptInput
        ref={ref}
        capabilityContext={{ projectName: "command-center" }}
        value="alpha"
        onValueChange={() => {}}
        onSubmit={onSubmit}
        ariaLabel="Initial prompt"
        submitLabel="Create session"
      />,
    );

    await userEvent.click(await screen.findByTitle("Voice input"));
    await screen.findByTitle("Stop recording");
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    act(() => ref.current?.primaryAction());

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        prompt: "\ndictatedalpha",
        images: [],
      }),
    );
  });

  it("submits transcribed text from the visible primary action when recording starts empty", async () => {
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
          : Response.json({ text: "dictated from empty" }),
      ),
    );
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const onSubmit = vi.fn();
    render(<RichPromptFixture onSubmit={onSubmit} />);

    await userEvent.click(await screen.findByTitle("Voice input"));
    await screen.findByTitle("Stop recording");
    const create = screen.getByRole("button", { name: "Create session" });
    expect(create).toBeEnabled();
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    await userEvent.click(create);

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        prompt: "dictated from empty",
        images: [],
      }),
    );
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
