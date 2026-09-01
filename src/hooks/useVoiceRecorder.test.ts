// @vitest-environment jsdom
import { StrictMode, createElement, type PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installFakeMicrophone,
  type FakeMicrophone,
} from "@/test/fake-microphone";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import {
  useVoiceRecorder,
  type TranscriptionRequest,
} from "./useVoiceRecorder";

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

  it("omits projectName from the transcription body when the consumer has none", async () => {
    const { stream } = streamWithTrack();
    const bodies: FormData[] = [];
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
        if (init?.body instanceof FormData) bodies.push(init.body);
        return Response.json({ text: "captured" });
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const { result } = renderHook(() =>
      useVoiceRecorder({ onResult: vi.fn(), onError: vi.fn() }),
    );
    await act(async () => {
      await (result.current.toggleRecording() as unknown as Promise<void>);
    });
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    await act(async () => {
      result.current.stopRecording();
      await Promise.resolve();
    });

    expect(bodies).toHaveLength(1);
    // Absent, not blank: the route distinguishes the two.
    expect(bodies[0]?.has("projectName")).toBe(false);
    expect(bodies[0]?.get("audio")).toBeInstanceOf(File);
  });

  it("still names the project when the consumer has one", async () => {
    const { stream } = streamWithTrack();
    const bodies: FormData[] = [];
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
        if (init?.body instanceof FormData) bodies.push(init.body);
        return Response.json({ text: "captured" });
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const { result } = renderHook(() =>
      useVoiceRecorder({
        projectName: "command-center",
        onResult: vi.fn(),
        onError: vi.fn(),
      }),
    );
    await act(async () => {
      await (result.current.toggleRecording() as unknown as Promise<void>);
    });
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    await act(async () => {
      result.current.stopRecording();
      await Promise.resolve();
    });

    expect(bodies[0]?.get("projectName")).toBe("command-center");
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

describe("useVoiceRecorder failure retention (R25.4)", () => {
  let api: FetchFixture;
  let microphone: FakeMicrophone;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api = installFetchFixture();
    api.json("GET", "/api/voice/health", { available: true });
    microphone = installFakeMicrophone();
  });

  afterEach(() => {
    microphone.restore();
    api.restore();
    vi.useRealTimers();
  });

  /**
   * Stands in for the transcription boundary alone. Every line of recorder code
   * — the MediaRecorder lifecycle, the blob, what is retained across a failure —
   * still runs, so a retry that quietly re-recorded or re-read its context would
   * fail these assertions.
   */
  function transcriptionStub(): {
    requests: TranscriptionRequest[];
    transcribe: (request: TranscriptionRequest) => Promise<string>;
    recover: () => void;
  } {
    const requests: TranscriptionRequest[] = [];
    let failure: string | null = "voice server offline";
    return {
      requests,
      transcribe: async (request) => {
        requests.push(request);
        if (failure !== null) throw new Error(failure);
        return "the retained words";
      },
      recover: () => {
        failure = null;
      },
    };
  }

  type Recorder = ReturnType<typeof useVoiceRecorder>;

  async function recordOnce(result: { current: Recorder }): Promise<void> {
    await waitFor(() => expect(result.current.isAvailable).toBe(true));
    await act(async () => {
      await (result.current.toggleRecording() as unknown as Promise<void>);
    });
    // Past MIN_RECORDING_DURATION, which the recorder measures with Date.now().
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await act(async () => {
      result.current.stopRecording();
      await Promise.resolve();
    });
  }

  function renderRecorder(
    stub: ReturnType<typeof transcriptionStub>,
    handlers: { onResult: () => void; onError: () => void },
  ) {
    let contextReads = 0;
    return renderHook(() =>
      useVoiceRecorder({
        projectName: "command-center",
        getContext: () => `context read ${(contextReads += 1)}`,
        transcribe: stub.transcribe,
        onResult: handlers.onResult,
        onError: handlers.onError,
      }),
    );
  }

  it("keeps the recorded audio when transcription fails", async () => {
    const stub = transcriptionStub();
    const onError = vi.fn();
    const { result } = renderRecorder(stub, { onResult: vi.fn(), onError });

    await recordOnce(result);

    await waitFor(() => expect(stub.requests).toHaveLength(1));
    expect(onError).toHaveBeenCalledWith("voice server offline");
    await waitFor(() =>
      expect(result.current.hasRetryableRecording).toBe(true),
    );
    expect(result.current.isProcessing).toBe(false);
  });

  it("re-posts the same audio and context on retry, without recording again", async () => {
    const stub = transcriptionStub();
    const onResult = vi.fn();
    const { result } = renderRecorder(stub, { onResult, onError: vi.fn() });

    await recordOnce(result);
    await waitFor(() =>
      expect(result.current.hasRetryableRecording).toBe(true),
    );

    stub.recover();
    await act(async () => {
      result.current.retryTranscription();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith("the retained words"),
    );
    expect(stub.requests).toHaveLength(2);
    // The very bytes that were recorded, not a fresh capture of them.
    expect(stub.requests[1]?.audio).toBe(stub.requests[0]?.audio);
    expect(stub.requests[1]?.audio.size).toBe("spoken audio".length);
    expect(stub.requests[1]?.context).toBe("context read 1");
    expect(microphone.startCount()).toBe(1);
    await waitFor(() =>
      expect(result.current.hasRetryableRecording).toBe(false),
    );
  });

  it("drops the recording only when the user discards it", async () => {
    const stub = transcriptionStub();
    const { result } = renderRecorder(stub, {
      onResult: vi.fn(),
      onError: vi.fn(),
    });

    await recordOnce(result);
    await waitFor(() =>
      expect(result.current.hasRetryableRecording).toBe(true),
    );

    act(() => result.current.discardRecording());

    expect(result.current.hasRetryableRecording).toBe(false);
    stub.recover();
    await act(async () => {
      result.current.retryTranscription();
      await Promise.resolve();
    });
    expect(stub.requests).toHaveLength(1);
  });

  it("keeps the retained recording when another recording starts", async () => {
    const stub = transcriptionStub();
    const { result } = renderRecorder(stub, {
      onResult: vi.fn(),
      onError: vi.fn(),
    });

    await recordOnce(result);
    await waitFor(() =>
      expect(result.current.hasRetryableRecording).toBe(true),
    );
    await act(async () => {
      await (result.current.toggleRecording() as unknown as Promise<void>);
    });

    // Merely starting again is not the user throwing the failed clip away.
    expect(result.current.isRecording).toBe(true);
    expect(result.current.hasRetryableRecording).toBe(true);
  });
});
