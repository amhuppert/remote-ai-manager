import { describe, expect, it } from "vitest";
import { restartCaptureStarts } from "./restart-capture-evidence";
const frame = (record: unknown, captureId = "owned") =>
  JSON.stringify({
    type: "codex_app_server",
    origin: { source: "checkpoint_capture", checkpointCapture: { captureId } },
    raw: { record: JSON.stringify(record) },
  }) + "\n";
const started = (id: string) => ({
  method: "turn/started",
  params: { threadId: "source-thread", turn: { id } },
});
describe("restart capture initialization evidence", () => {
  it("requires a capture-owned native Codex start, not ordinary or other attempt activity", () => {
    const archive =
      frame(started("other"), "unrelated") +
      frame({ method: "thread/started", params: {} }) +
      frame(started("capture-turn"));
    expect(restartCaptureStarts(archive, "owned", "instruction-only")).toEqual({
      count: 1,
      turnIds: ["capture-turn"],
    });
  });
  it("retains duplicate native starts as replay evidence", () => {
    expect(
      restartCaptureStarts(
        frame(started("first")) + frame(started("second")),
        "owned",
        "instruction-only",
      ),
    ).toEqual({ count: 2, turnIds: ["first", "second"] });
  });
  it("does not treat a partial or malformed transport record as initialization", () => {
    expect(
      restartCaptureStarts(
        frame({ method: "turn/started", params: { turn: {} } }),
        "owned",
        "instruction-only",
      ),
    ).toEqual({ count: 0, turnIds: [] });
  });
  it("retains Claude inventory initialization behavior", () => {
    const archive =
      JSON.stringify({
        origin: {
          source: "checkpoint_capture",
          checkpointCapture: { captureId: "owned" },
        },
        raw: {
          type: "system",
          subtype: "init",
          tools: [],
          mcp_servers: [],
          plugins: [],
          session_id: "source",
        },
      }) + "\n";
    expect(restartCaptureStarts(archive, "owned", "tool-disabled")).toEqual({
      count: 1,
      turnIds: [],
    });
  });
});
