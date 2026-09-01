// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import {
  createHotkeyDispatcher,
  type HotkeyDispatcher,
} from "@/lib/hotkeys/dispatcher";
import { createTestQueryClient } from "@/test/component-mocks";
import {
  installFakeMicrophone,
  type FakeMicrophone,
} from "@/test/fake-microphone";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";

import VoiceQuickCaptureHost from "./VoiceQuickCaptureHost";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

let api: FetchFixture;
let microphone: FakeMicrophone;
let dispatcher: HotkeyDispatcher;
let queryClient: QueryClient;

beforeEach(() => {
  pathname = "/";
  api = installFetchFixture();
  api.json("GET", "/api/voice/health", { available: true });
  api.json("GET", "/api/notepads", { notepads: [] });
  microphone = installFakeMicrophone();
  dispatcher = createHotkeyDispatcher();
  queryClient = createTestQueryClient();
});

afterEach(() => {
  cleanup();
  microphone.restore();
  api.restore();
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

/** Drive the command exactly as the launcher and the keyboard both do. */
async function invokeQuickCapture(): Promise<void> {
  await act(async () => {
    dispatcher.invoke("voiceQuickCapture");
  });
}

/** One press reaches the destination pool — the capture waits, not the user. */
async function invokeUntilPoolFetched(): Promise<void> {
  await invokeQuickCapture();
  await waitFor(() => {
    expect(api.requestsTo("GET", "/api/notepads")).not.toHaveLength(0);
  });
}

describe("VoiceQuickCaptureHost hotkey registration (R25.1)", () => {
  it("registers the quick-capture command, so the launcher and help modal list it", () => {
    mountHost();

    const command = dispatcher
      .getCommands()
      .find((view) => view.definition.id === "voiceQuickCapture");

    expect(command?.registered).toBe(true);
    expect(command?.available).toBe(true);
    expect(command?.definition.allowInEditable).toBe(true);
  });

  it("stays registered while the voice service is unavailable", async () => {
    api.json("GET", "/api/voice/health", { available: false });
    mountHost();

    await act(async () => {});

    expect(
      dispatcher
        .getCommands()
        .find((view) => view.definition.id === "voiceQuickCapture")?.registered,
    ).toBe(true);
  });
});

describe("VoiceQuickCaptureHost ambient project derivation (R25.1)", () => {
  it("reads the project out of a session route and loads that project's notepads", async () => {
    pathname = "/projects/command-center/notepad-slice";
    mountHost();

    await invokeUntilPoolFetched();

    const request = api.requestsTo("GET", "/api/notepads")[0];
    expect(request?.searchParams.get("project")).toBe("command-center");
  });

  it("falls back to the global pool when the route names no project", async () => {
    pathname = "/conversations";
    mountHost();

    await invokeUntilPoolFetched();

    const request = api.requestsTo("GET", "/api/notepads")[0];
    expect(request?.searchParams.get("scope")).toBe("global");
    expect(request?.searchParams.get("project")).toBeNull();
  });

  it("fetches no notepad listing until capture is first invoked", async () => {
    pathname = "/projects/command-center";
    mountHost();

    await act(async () => {});

    expect(api.requestsTo("GET", "/api/notepads")).toHaveLength(0);
  });
});

describe("VoiceQuickCaptureHost voice availability (R25.1)", () => {
  it("polls the voice health endpoint on mount", async () => {
    mountHost();

    await waitFor(() => {
      expect(api.requestsTo("GET", "/api/voice/health")).not.toHaveLength(0);
    });
  });

  it("starts recording through the microphone when the hotkey fires", async () => {
    mountHost();

    await invokeUntilPoolFetched();

    await waitFor(() => {
      expect(microphone.startCount()).toBe(1);
    });
  });

  it("refuses to record while the voice service is down, and says so", async () => {
    api.json("GET", "/api/voice/health", { available: false });
    mountHost();
    await waitFor(() => {
      expect(api.requestsTo("GET", "/api/voice/health")).not.toHaveLength(0);
    });

    await invokeQuickCapture();
    await act(async () => {});

    expect(microphone.startCount()).toBe(0);
    expect(api.requestsTo("GET", "/api/notepads")).toHaveLength(0);
  });
});
