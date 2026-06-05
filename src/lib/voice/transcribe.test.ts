import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/logging", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/logging")>("@/lib/logging");
  return {
    ...actual,
    createLogger: () => logger,
  };
});

import { proxyTranscribe, _setTranscribeFetchForTesting } from "./transcribe";
import { _resetTimedForTesting } from "@/lib/logging/timed";

function makeAudioFile(): File {
  return new File(["audio-bytes"], "clip.wav", { type: "audio/wav" });
}

describe("proxyTranscribe", () => {
  beforeEach(() => {
    _resetTimedForTesting();
    process.env["CC_TIMING_INFO_MS"] = "0";
    process.env["CC_TIMING_WARN_MS"] = "100000";
    logger.info.mockClear();
    logger.debug.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
  });

  afterEach(() => {
    _setTranscribeFetchForTesting(undefined);
    _resetTimedForTesting();
    delete process.env["CC_TIMING_INFO_MS"];
    delete process.env["CC_TIMING_WARN_MS"];
  });

  it("returns cleanText from the upstream serve response on success", async () => {
    _setTranscribeFetchForTesting(
      async () =>
        new Response(
          JSON.stringify({
            rawText: "raw hello",
            cleanText: "Hello.",
            status: "ok",
            sessionId: 42,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    const result = await proxyTranscribe({
      audio: makeAudioFile(),
      projectPath: "/tmp/proj",
    });

    expect(result).toEqual({ ok: true, text: "Hello." });

    const completeCalls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.debug.mock.calls,
    ].filter(([msg]) => msg === "voice.transcribe.upstream.complete");

    expect(completeCalls.length).toBe(1);
    const fields = completeCalls[0]?.[1] as Record<string, unknown>;
    expect(typeof fields["durationMs"]).toBe("number");
    expect(fields["ok"]).toBe(true);
    expect(fields["status"]).toBe(200);
  });

  it("returns a 502 failure when the upstream success body is missing cleanText", async () => {
    _setTranscribeFetchForTesting(
      async () =>
        new Response(JSON.stringify({ text: "legacy shape" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await proxyTranscribe({
      audio: makeAudioFile(),
      projectPath: "/tmp/proj",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);

    const invalidCalls = logger.warn.mock.calls.filter(
      ([msg]) => msg === "voice.transcribe.upstream.invalid",
    );
    expect(invalidCalls.length).toBe(1);
  });

  it("emits voice.transcribe.upstream.complete with ok=false on upstream error", async () => {
    _setTranscribeFetchForTesting(
      async () =>
        new Response(JSON.stringify({ error: "bad" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await proxyTranscribe({
      audio: makeAudioFile(),
      projectPath: "/tmp/proj",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);

    const completeCalls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.debug.mock.calls,
    ].filter(([msg]) => msg === "voice.transcribe.upstream.complete");

    expect(completeCalls.length).toBe(1);
    const fields = completeCalls[0]?.[1] as Record<string, unknown>;
    expect(fields["ok"]).toBe(false);
    expect(fields["status"]).toBe(500);
  });

  it("emits voice.transcribe.upstream.error and returns failure when fetch throws", async () => {
    _setTranscribeFetchForTesting(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await proxyTranscribe({
      audio: makeAudioFile(),
      projectPath: "/tmp/proj",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);

    const errorCalls = logger.warn.mock.calls.filter(
      ([msg]) => msg === "voice.transcribe.upstream.error",
    );
    expect(errorCalls.length).toBe(1);
    const fields = errorCalls[0]?.[1] as Record<string, unknown>;
    expect(typeof fields["durationMs"]).toBe("number");
  });
});
