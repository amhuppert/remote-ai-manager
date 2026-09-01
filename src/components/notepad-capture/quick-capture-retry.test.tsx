// @vitest-environment jsdom
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import {
  createHotkeyDispatcher,
  type HotkeyDispatcher,
} from "@/lib/hotkeys/dispatcher";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { useToastStoreForTesting } from "@/stores/toast.store";
import { createTestQueryClient } from "@/test/component-mocks";
import {
  installFakeMicrophone,
  type FakeMicrophone,
} from "@/test/fake-microphone";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import {
  installNotepadApi,
  type NotepadApiFixture,
} from "@/test/notepad-api-fixture";

import VoiceQuickCaptureHost from "./VoiceQuickCaptureHost";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/command-center",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const TRANSCRIPT = "The words that would have been lost.";

let api: FetchFixture;
let notepads: NotepadApiFixture;
let microphone: FakeMicrophone;
let dispatcher: HotkeyDispatcher;
let queryClient: QueryClient;
/** How many transcription attempts the voice service refuses before recovering. */
let refusalsRemaining = 0;

function seedRoutes(options: { voiceAvailable?: boolean } = {}): void {
  api.json("GET", "/api/voice/health", {
    available: options.voiceAvailable ?? true,
  });
  api.reply("POST", "/api/voice/transcribe", () => {
    if (refusalsRemaining > 0) {
      refusalsRemaining -= 1;
      return { status: 503, json: { error: "Voice service unavailable" } };
    }
    return { json: { text: TRANSCRIPT } };
  });
  notepads = installNotepadApi(api, [
    { id: "np-recent", name: "Field notes", content: "Existing content." },
  ]);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  refusalsRemaining = 0;
  useToastStoreForTesting.setState({ toasts: [] });
  useSessionDetailStore.getState().closeNotepad();
  api = installFetchFixture();
  microphone = installFakeMicrophone();
  dispatcher = createHotkeyDispatcher();
  queryClient = createTestQueryClient();
});

afterEach(() => {
  cleanup();
  useSessionDetailStore.getState().closeNotepad();
  microphone.restore();
  api.restore();
  vi.useRealTimers();
});

function mountHost(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <HotkeyProvider dispatcher={dispatcher}>
        <VoiceQuickCaptureHost />
      </HotkeyProvider>
    </QueryClientProvider>,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function pressHotkey(): Promise<void> {
  await act(async () => {
    dispatcher.invoke("voiceQuickCapture");
  });
  await settle();
}

/** One press, one recording — the capture resolves everything behind it. */
async function pressToRecord(): Promise<void> {
  await pressHotkey();
  await waitFor(() => {
    expect(microphone.startCount()).toBe(1);
  });
}

/** Record past the minimum-duration floor and stop, exactly as the user does. */
async function captureOnce(): Promise<void> {
  mountHost();
  await pressToRecord();
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  await pressHotkey();
}

function transcribeRequests() {
  return api.requestsTo("POST", "/api/voice/transcribe");
}

function contentWrites() {
  return api.requestsTo("POST", "/api/notepads/np-recent/content");
}

function audioOf(index: number): File | null {
  const audio = transcribeRequests()[index]?.formBody?.get("audio");
  return audio instanceof File ? audio : null;
}

function pill(): HTMLElement {
  return screen.getByRole("region", { name: /voice quick capture/i });
}

describe("transcription failure retains the recording (R25.4)", () => {
  it("keeps the surface up with Retry and Discard rather than losing the speech", async () => {
    seedRoutes();
    refusalsRemaining = 1;

    await captureOnce();

    await waitFor(() => {
      expect(transcribeRequests()).toHaveLength(1);
    });
    const failed = await screen.findByText(/your recording is still here/i);
    expect(failed).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /discard/i })).toBeTruthy();
    expect(contentWrites()).toHaveLength(0);
  });

  it("retries with the same audio and context, and lands once the service recovers", async () => {
    seedRoutes();
    refusalsRemaining = 1;

    await captureOnce();
    await screen.findByText(/your recording is still here/i);

    await act(async () => {
      screen.getByRole("button", { name: /retry/i }).click();
    });

    await waitFor(() => {
      expect(transcribeRequests()).toHaveLength(2);
    });
    // Identical bytes, resent — the user never speaks twice.
    expect(audioOf(1)?.size).toBe(audioOf(0)?.size);
    expect(audioOf(1)?.size).toBeGreaterThan(0);
    expect(audioOf(1)?.type).toBe(audioOf(0)?.type);
    expect(transcribeRequests()[1]?.formBody?.get("context")).toBe(
      transcribeRequests()[0]?.formBody?.get("context"),
    );
    expect(microphone.startCount()).toBe(1);

    await waitFor(() => {
      expect(contentWrites()).toHaveLength(1);
    });
    expect(contentWrites()[0]?.jsonBody).toEqual({
      operation: "append",
      content: TRANSCRIPT,
    });
    expect(notepads.read("np-recent")?.content).toBe(
      `Existing content.\n\n${TRANSCRIPT}`,
    );
    const confirmation = await screen.findByRole("status", {
      name: /capture landed/i,
    });
    expect(confirmation.textContent).toContain("Field notes");
  });

  it("retries from the hotkey rather than recording over the retained audio", async () => {
    seedRoutes();
    refusalsRemaining = 1;

    await captureOnce();
    await screen.findByText(/your recording is still here/i);

    await pressHotkey();

    // The press sends the failed clip again; it does not open the microphone
    // over speech nobody discarded.
    await waitFor(() => {
      expect(transcribeRequests()).toHaveLength(2);
    });
    expect(microphone.startCount()).toBe(1);
    expect(audioOf(1)?.size).toBe(audioOf(0)?.size);
    await waitFor(() => {
      expect(contentWrites()).toHaveLength(1);
    });
  });

  it("keeps the transcription when the write fails, and lands it on retry", async () => {
    seedRoutes();
    let writeRefusals = 1;
    api.reply("POST", "/api/notepads/np-recent/content", (request) => {
      if (writeRefusals > 0) {
        writeRefusals -= 1;
        return { status: 500, json: { error: "Write failed" } };
      }
      return {
        json: {
          notepad: {
            ...notepads.put({
              id: "np-recent",
              content: `Existing content.\n\n${String((request.jsonBody as { content: string }).content)}`,
              revision: 4,
            }),
          },
        },
      };
    });

    await captureOnce();

    // Transcribed words are as unlosable as the audio was: the surface holds
    // them rather than reporting the failure and dropping them.
    await screen.findByText(/your words are still here/i);
    await act(async () => {
      screen.getByRole("button", { name: /retry/i }).click();
    });

    await waitFor(() => {
      expect(contentWrites()).toHaveLength(2);
    });
    expect(transcribeRequests()).toHaveLength(1);
    expect(notepads.read("np-recent")?.content).toBe(
      `Existing content.\n\n${TRANSCRIPT}`,
    );
    await screen.findByRole("status", { name: /capture landed/i });
  });

  it("keeps the recording when the service transcribes it to nothing", async () => {
    seedRoutes();
    // A 200 carrying no words is not a success worth throwing audio away for:
    // the user spoke, and only they get to decide the recording is worthless.
    api.json("POST", "/api/voice/transcribe", { text: "   " });

    await captureOnce();

    expect(await screen.findByRole("button", { name: /retry/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /discard/i })).toBeTruthy();
    expect(contentWrites()).toHaveLength(0);
  });

  it("keeps a recording the recorder judged too short, and sends it on retry", async () => {
    seedRoutes();

    mountHost();
    await pressToRecord();
    // Under the recorder's minimum-duration floor. Half a second is an
    // arbitrary line, and a short word spoken deliberately falls the wrong
    // side of it — so the bytes are held, not binned.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    await pressHotkey();

    expect(await screen.findByRole("button", { name: /retry/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /discard/i })).toBeTruthy();
    expect(transcribeRequests()).toHaveLength(0);

    await act(async () => {
      screen.getByRole("button", { name: /retry/i }).click();
    });

    await waitFor(() => {
      expect(transcribeRequests()).toHaveLength(1);
    });
    expect(audioOf(0)?.size).toBeGreaterThan(0);
    await waitFor(() => {
      expect(contentWrites()).toHaveLength(1);
    });
  });

  it("drops the recording only when the user discards it", async () => {
    seedRoutes();
    refusalsRemaining = 1;

    await captureOnce();
    await screen.findByText(/your recording is still here/i);

    await act(async () => {
      screen.getByRole("button", { name: /discard/i }).click();
    });
    await settle();

    expect(screen.queryByRole("region", { name: /voice quick capture/i })).toBe(
      null,
    );
    expect(transcribeRequests()).toHaveLength(1);
    expect(contentWrites()).toHaveLength(0);
    expect(microphone.openTrackCount()).toBe(0);
  });

  it("records again once the failed clip has been discarded", async () => {
    seedRoutes();
    refusalsRemaining = 1;

    await captureOnce();
    await screen.findByText(/your recording is still here/i);
    await act(async () => {
      screen.getByRole("button", { name: /discard/i }).click();
    });
    await settle();

    await pressHotkey();

    await waitFor(() => {
      expect(microphone.startCount()).toBe(2);
    });
  });

  it("discards from the pill's Escape key as an explicit act", async () => {
    seedRoutes();
    refusalsRemaining = 1;

    await captureOnce();
    await screen.findByText(/your recording is still here/i);

    await act(async () => {
      pill().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();

    expect(screen.queryByRole("region", { name: /voice quick capture/i })).toBe(
      null,
    );
  });
});

describe("an unavailable voice service before start (R25.4)", () => {
  it("waits for the answer rather than calling a healthy service down", async () => {
    let answerHealth = (): void => {};
    const healthAnswered = new Promise<void>((resolve) => {
      answerHealth = resolve;
    });
    api.reply("GET", "/api/voice/health", async () => {
      await healthAnswered;
      return { json: { available: true } };
    });
    api.json("POST", "/api/voice/transcribe", { text: TRANSCRIPT });
    notepads = installNotepadApi(api, [
      { id: "np-recent", name: "Field notes", content: "Existing content." },
    ]);

    mountHost();
    await pressHotkey();

    // "Not answered yet" is not "down". Saying so would be a lie the user
    // acts on by giving up.
    expect(useToastStoreForTesting.getState().toasts).toEqual([]);

    answerHealth();
    await waitFor(() => {
      expect(microphone.startCount()).toBe(1);
    });
  });

  it("says so instead of failing silently, and starts no recording", async () => {
    seedRoutes({ voiceAvailable: false });

    mountHost();
    await waitFor(() => {
      expect(api.requestsTo("GET", "/api/voice/health")).not.toHaveLength(0);
    });
    await pressHotkey();

    expect(microphone.startCount()).toBe(0);
    expect(useToastStoreForTesting.getState().toasts).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/voice transcription is unavailable/i),
      }),
    ]);
    expect(screen.queryByRole("region", { name: /voice quick capture/i })).toBe(
      null,
    );
  });
});
