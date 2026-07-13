// @vitest-environment jsdom
import { StrictMode, createElement, type PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVoiceRecorder } from "./useVoiceRecorder";

class FakeMediaRecorder {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function streamWithTrack() {
  const stop = vi.fn();
  return {
    stream: { getTracks: () => [{ stop }] } as unknown as MediaStream,
    stop,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useVoiceRecorder cancellation", () => {
  it("can start recording after StrictMode replays its effects", async () => {
    const { stream } = streamWithTrack();
    const recorderConstructor = vi.fn();
    class Recorder extends FakeMediaRecorder {
      constructor() {
        super();
        recorderConstructor();
      }
    }
    vi.stubGlobal("MediaRecorder", Recorder);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ available: true })),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => stream },
    });
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(StrictMode, null, children);

    const { result } = renderHook(
      () =>
        useVoiceRecorder({
          projectName: "command-center",
          onResult: vi.fn(),
          onError: vi.fn(),
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isAvailable).toBe(true));
    await act(async () => {
      await (result.current.toggleRecording() as unknown as Promise<void>);
    });

    expect(recorderConstructor).toHaveBeenCalledOnce();
    expect(result.current.isRecording).toBe(true);
  });

  it("stops a late microphone stream without starting a recorder after disable", async () => {
    const permission = deferred<MediaStream>();
    const { stream, stop } = streamWithTrack();
    const recorderConstructor = vi.fn();
    class Recorder extends FakeMediaRecorder {
      constructor() {
        super();
        recorderConstructor();
      }
    }
    vi.stubGlobal("MediaRecorder", Recorder);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ available: true })),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => permission.promise },
    });

    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useVoiceRecorder({
          projectName: "command-center",
          enabled,
          onResult: vi.fn(),
          onError: vi.fn(),
        }),
      { initialProps: { enabled: true } },
    );

    let startPromise!: Promise<void>;
    act(() => {
      startPromise =
        result.current.toggleRecording() as unknown as Promise<void>;
    });
    rerender({ enabled: false });
    await act(async () => {
      permission.resolve(stream);
      await startPromise;
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(recorderConstructor).not.toHaveBeenCalled();
    expect(result.current.isRecording).toBe(false);
  });

  it("aborts deferred transcription and discards its result after unmount", async () => {
    const { stream, stop } = streamWithTrack();
    const onResult = vi.fn();
    const onError = vi.fn();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => stream },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/api/voice/health")) {
          return Response.json({ available: true });
        }
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const { result, unmount } = renderHook(() =>
      useVoiceRecorder({
        projectName: "command-center",
        onResult,
        onError,
      }),
    );
    await act(async () => {
      await (result.current.toggleRecording() as unknown as Promise<void>);
    });
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    act(() => result.current.stopRecording());
    unmount();
    await act(async () => Promise.resolve());

    expect(stop).toHaveBeenCalledOnce();
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
