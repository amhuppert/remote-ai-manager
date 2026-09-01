/**
 * A deterministic microphone for jsdom: `navigator.mediaDevices.getUserMedia`
 * plus a `MediaRecorder` that emits exactly the bytes a test hands it.
 *
 * jsdom implements neither, so voice surfaces could otherwise only be tested by
 * substituting `useVoiceRecorder` itself — which proves nothing about the
 * recorder's blob handling, the multipart body, or the retry path. Faking the
 * browser capture APIs instead keeps every line of production voice code in the
 * exercise, up to and including the `fetch` the recorder issues.
 */

interface FakeTrack {
  stop(): void;
}

interface RecorderInstance {
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
}

export interface FakeMicrophone {
  /** The bytes the next `stop()` delivers as the recording. */
  setAudio(text: string): void;
  /** How many recordings have been started since installation. */
  startCount(): number;
  /** Live media tracks the caller has not stopped — a leak check. */
  openTrackCount(): number;
  restore(): void;
}

interface MutableGlobals {
  MediaRecorder?: unknown;
  navigator: Navigator;
}

export function installFakeMicrophone(): FakeMicrophone {
  const globals = globalThis as unknown as MutableGlobals;
  const hadRecorder = "MediaRecorder" in globals;
  const previousRecorder = globals.MediaRecorder;
  const previousMediaDevices = Object.getOwnPropertyDescriptor(
    globals.navigator,
    "mediaDevices",
  );

  let audioText = "spoken audio";
  let startCount = 0;
  let openTracks = 0;

  class FakeMediaRecorder implements RecorderInstance {
    static isTypeSupported(mimeType: string): boolean {
      return mimeType === "audio/webm;codecs=opus";
    }

    readonly mimeType: string;
    state: "inactive" | "recording" = "inactive";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor(_stream: unknown, options?: { mimeType?: string }) {
      this.mimeType = options?.mimeType ?? "audio/webm";
    }

    start(): void {
      this.state = "recording";
      startCount += 1;
    }

    stop(): void {
      if (this.state !== "recording") return;
      this.state = "inactive";
      // The production recorder registers its handlers immediately before
      // calling stop(), so delivering synchronously here matches the single
      // flush-on-stop chunk the real recorder produces without a timeslice.
      this.ondataavailable?.({
        data: new Blob([audioText], { type: this.mimeType }),
      });
      this.onstop?.();
    }
  }

  globals.MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(globals.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async (): Promise<{ getTracks(): FakeTrack[] }> => {
        openTracks += 1;
        let stopped = false;
        const track: FakeTrack = {
          stop: () => {
            if (stopped) return;
            stopped = true;
            openTracks -= 1;
          },
        };
        return { getTracks: () => [track] };
      },
    },
  });

  return {
    setAudio: (text: string) => {
      audioText = text;
    },
    startCount: () => startCount,
    openTrackCount: () => openTracks,
    restore: () => {
      if (hadRecorder) {
        globals.MediaRecorder = previousRecorder;
      } else {
        delete globals.MediaRecorder;
      }
      if (previousMediaDevices) {
        Object.defineProperty(
          globals.navigator,
          "mediaDevices",
          previousMediaDevices,
        );
      } else {
        Reflect.deleteProperty(globals.navigator, "mediaDevices");
      }
    },
  };
}
