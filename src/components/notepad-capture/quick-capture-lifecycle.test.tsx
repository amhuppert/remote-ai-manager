// @vitest-environment jsdom
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import { voiceOwnership } from "@/hooks/use-multiline-voice";
import {
  createHotkeyDispatcher,
  type HotkeyDispatcher,
} from "@/lib/hotkeys/dispatcher";
import { useSessionDetailStore } from "@/stores/session-detail.store";
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

let pathname = "/projects/command-center";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

let api: FetchFixture;
let notepads: NotepadApiFixture;
let microphone: FakeMicrophone;
let dispatcher: HotkeyDispatcher;
let queryClient: QueryClient;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  pathname = "/projects/command-center";
  useSessionDetailStore.getState().closeNotepad();
  api = installFetchFixture();
  api.json("GET", "/api/voice/health", { available: true });
  api.json("POST", "/api/voice/transcribe", { text: "a captured thought" });
  notepads = installNotepadApi(api, [
    { id: "np-1", name: "Field notes", content: "Existing content." },
  ]);
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

/** Get past the recorder's minimum-duration floor without waiting in real time. */
async function recordFor(seconds: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(seconds * 1000);
  });
}

/**
 * One press starts one recording. The press is the user's whole contribution —
 * anything the capture still has to find out (is the service up, which notepad)
 * happens behind it, never by asking them to press again.
 */
async function pressToRecord(): Promise<void> {
  await pressHotkey();
  await waitFor(() => {
    expect(microphone.startCount()).toBe(1);
  });
}

async function startRecording(): Promise<void> {
  mountHost();
  await pressToRecord();
  await recordFor(2);
}

function pill(): HTMLElement {
  return screen.getByRole("region", { name: /voice quick capture/i });
}

describe("recording pill surface (R25.3)", () => {
  it("names the destination notepad and lives on document.body", async () => {
    await startRecording();

    const surface = await screen.findByText(/Field notes/);
    expect(pill()).toBeTruthy();
    // The docked conversation stage's transform is the containing block for
    // any fixed descendant, so the pill must not be nested inside the tree it
    // was rendered from.
    expect(surface.closest("body")).toBe(document.body);
    expect(document.body.contains(pill())).toBe(true);
    expect(pill().parentElement).toBe(document.body);
  });

  it("has the destination in hand the moment the microphone opens", async () => {
    mountHost();
    await pressToRecord();

    // Not a placeholder that fills in later: the listing and the notepad's
    // content are both read before recording begins (D21).
    expect(pill().textContent).toContain("Recording to Field notes");
    expect(pill().textContent).not.toContain("…");
  });

  it("keeps the destination it named when the open notepad changes mid-recording", async () => {
    notepads.put({
      id: "np-other",
      name: "Other notes",
      updatedAt: "2026-08-30T09:00:00.000Z",
    });
    await startRecording();
    expect(pill().textContent).toContain("Field notes");

    await act(async () => {
      useSessionDetailStore.getState().openNotepad("np-other");
    });
    await settle();

    expect(pill().textContent).toContain("Field notes");
    expect(pill().textContent).not.toContain("Other notes");
  });

  it("shows elapsed recording time", async () => {
    await startRecording();

    await waitFor(() => {
      expect(screen.getByText("0:02")).toBeTruthy();
    });
  });

  it("records on the first press, before the health check has answered", async () => {
    let answerHealth = (): void => {};
    const healthAnswered = new Promise<void>((resolve) => {
      answerHealth = resolve;
    });
    api.reply("GET", "/api/voice/health", async () => {
      await healthAnswered;
      return { json: { available: true } };
    });

    mountHost();
    // The user presses once, while the health probe is still in flight. A
    // not-yet-known service is not a down service, so the press is honoured.
    await pressHotkey();
    expect(microphone.startCount()).toBe(0);

    answerHealth();

    await waitFor(() => {
      expect(microphone.startCount()).toBe(1);
    });
    expect(pill().textContent).toContain("Recording to Field notes");
  });

  it("never names a destination that is already gone", async () => {
    notepads.put({
      id: "np-older",
      name: "Older notes",
      updatedAt: "2026-08-30T09:00:00.000Z",
    });
    // "Field notes" is the most recent, so it resolves first — but it is
    // deleted in the window between the listing and the content read.
    api.reply("GET", /^\/api\/notepads\/[^/]+$/, (request) => {
      const id = request.pathname.split("/")[3] ?? "";
      if (id === "np-1") {
        notepads.remove("np-1");
        return { status: 404, json: { error: "Notepad not found" } };
      }
      const notepad = notepads.read(id);
      return notepad === undefined
        ? { status: 404, json: { error: "Notepad not found" } }
        : { json: { notepad } };
    });

    mountHost();
    await pressToRecord();

    // Naming a notepad the capture already knows is gone would be a lie the
    // user only discovers when the words land somewhere else.
    expect(pill().textContent).toContain("Older notes");
    expect(pill().textContent).not.toContain("Field notes");
  });

  it("shows no pill before the hotkey fires", async () => {
    mountHost();
    await settle();

    expect(screen.queryByRole("region", { name: /voice quick capture/i })).toBe(
      null,
    );
  });
});

describe("recording pill lifecycle (R25.1, R25.3)", () => {
  it("stops and transcribes when the hotkey fires again", async () => {
    await startRecording();

    await pressHotkey();

    await waitFor(() => {
      expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(1);
    });
  });

  it("stops and transcribes on Enter", async () => {
    await startRecording();

    await act(async () => {
      fireEvent.keyDown(pill(), { key: "Enter" });
    });

    await waitFor(() => {
      expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(1);
    });
  });

  it("stops and transcribes from the Stop control", async () => {
    await startRecording();

    await act(async () => {
      screen.getByRole("button", { name: /stop/i }).click();
    });

    await waitFor(() => {
      expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(1);
    });
  });

  it("discards the recording on Escape without transcribing", async () => {
    await startRecording();

    await act(async () => {
      fireEvent.keyDown(pill(), { key: "Escape" });
    });
    await settle();

    expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: /voice quick capture/i })).toBe(
      null,
    );
    // Cancelling must also release the microphone, not just hide the surface.
    expect(microphone.openTrackCount()).toBe(0);
  });

  it("discards the recording from the Cancel control", async () => {
    await startRecording();

    await act(async () => {
      screen.getByRole("button", { name: /cancel/i }).click();
    });
    await settle();

    expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: /voice quick capture/i })).toBe(
      null,
    );
  });

  it("discards without transcribing when cancelled during the context read", async () => {
    let releaseContextRead = (): void => {};
    const contextRead = new Promise<void>((resolve) => {
      releaseContextRead = resolve;
    });
    let reads = 0;
    // The first read is the one at record start; the second is the context
    // read that stopping triggers, and it is the one we hold open.
    api.reply("GET", /^\/api\/notepads\/[^/]+$/, async (request) => {
      reads += 1;
      if (reads > 1) await contextRead;
      const notepad = notepads.read(request.pathname.split("/")[3] ?? "");
      return notepad === undefined
        ? { status: 404, json: { error: "Notepad not found" } }
        : { json: { notepad } };
    });

    await startRecording();
    await pressHotkey();

    // Cancel lands while the stop is still gathering context. It must win:
    // the audio is discarded, not posted behind the user's back.
    await act(async () => {
      fireEvent.keyDown(pill(), { key: "Escape" });
    });
    releaseContextRead();
    await settle();
    await settle();

    expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: /voice quick capture/i })).toBe(
      null,
    );
    expect(microphone.openTrackCount()).toBe(0);
  });

  it("replaces a landed confirmation with the recording surface", async () => {
    await startRecording();
    await pressHotkey();
    await screen.findByRole("status", { name: /capture landed/i });

    await pressHotkey();
    await waitFor(() => {
      expect(microphone.startCount()).toBe(2);
    });

    // A live microphone always has its own surface: destination, elapsed time,
    // and a way to stop, never hidden behind the previous capture's toast.
    expect(pill().textContent).toContain("Recording to");
    expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
    expect(screen.queryByRole("status", { name: /capture landed/i })).toBe(
      null,
    );
  });
});

describe("project-less transcription (no-project-transcription)", () => {
  it("posts no project name when the route puts the user in no project", async () => {
    pathname = "/conversations";
    notepads.put({
      id: "np-global",
      scope: "global",
      projectPath: null,
      name: "Scratch",
    });
    await startRecording();

    await pressHotkey();

    await waitFor(() => {
      expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(1);
    });
    const body = api.requestsTo("POST", "/api/voice/transcribe")[0]?.formBody;
    expect(body?.has("projectName")).toBe(false);
    expect(body?.get("audio")).toBeInstanceOf(File);
  });

  it("names the project when the route has one", async () => {
    await startRecording();

    await pressHotkey();

    await waitFor(() => {
      expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(1);
    });
    expect(
      api
        .requestsTo("POST", "/api/voice/transcribe")[0]
        ?.formBody?.get("projectName"),
    ).toBe("command-center");
  });
});

describe("app-wide voice ownership (D22)", () => {
  it("takes the microphone over from the surface that already owns voice", async () => {
    const incumbentStopped = vi.fn(() => {
      voiceOwnership.release("composer");
    });
    voiceOwnership.claim({ id: "composer", stop: incumbentStopped });

    mountHost();
    await pressToRecord();

    // The user asked to capture here, so capture happens here — the incumbent
    // is stopped and this surface records rather than dropping the press.
    expect(incumbentStopped).toHaveBeenCalled();
    expect(voiceOwnership.currentId()).not.toBe("composer");
  });

  it("yields the microphone when another surface claims voice mid-recording", async () => {
    await startRecording();
    expect(voiceOwnership.currentId()).not.toBe(null);

    await act(async () => {
      voiceOwnership.claim({ id: "composer", stop: () => {} });
    });
    await settle();

    expect(screen.queryByRole("region", { name: /voice quick capture/i })).toBe(
      null,
    );
    expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(0);
    expect(microphone.openTrackCount()).toBe(0);
  });

  it("releases ownership once the recording ends", async () => {
    await startRecording();

    await act(async () => {
      fireEvent.keyDown(pill(), { key: "Escape" });
    });
    await settle();

    expect(voiceOwnership.currentId()).toBe(null);
  });
});
