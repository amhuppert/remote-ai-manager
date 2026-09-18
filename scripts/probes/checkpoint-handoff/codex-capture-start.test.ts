import { describe, expect, it } from "vitest";
import { codexCaptureStarted } from "./codex-capture-start";

const frame = (captureId: string, method: string, turnId = "turn-1") =>
  JSON.stringify({
    type: "codex_app_server",
    origin: { source: "checkpoint_capture", checkpointCapture: { captureId } },
    raw: {
      record: JSON.stringify({
        method,
        params: { turn: { id: turnId }, threadId: "source" },
      }),
    },
  });

describe("Codex live capture interruption precondition", () => {
  it("waits for the owned provider turn rather than durable admission or unrelated activity", () => {
    expect(codexCaptureStarted('{"stage":"running"}\n', "capture")).toBe(false);
    expect(codexCaptureStarted(frame("other", "turn/started"), "capture")).toBe(
      false,
    );
    expect(
      codexCaptureStarted(frame("capture", "thread/started"), "capture"),
    ).toBe(false);
    expect(
      codexCaptureStarted(frame("capture", "turn/started", ""), "capture"),
    ).toBe(false);
    expect(
      codexCaptureStarted(frame("capture", "turn/started"), "capture"),
    ).toBe(true);
  });
});
