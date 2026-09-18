import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditCodexRun } from "./codex-native-evidence";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const line = (value: unknown) => JSON.stringify(value) + "\n";
const native = (type: string, payload: object) => line({ type, payload });
const event = (type: string, turn_id: string) =>
  native("event_msg", { type, turn_id });
function fixture(nativeBytes: string | null, advertised = true) {
  const root = mkdtempSync(path.join(tmpdir(), "native-probe-"));
  roots.push(root);
  const file = path.join(root, "native.jsonl");
  if (nativeBytes !== null) writeFileSync(file, nativeBytes);
  const frame = (record: unknown, capture = false) =>
    line({
      type: "codex_app_server",
      raw: { record: JSON.stringify(record) },
      ...(capture
        ? {
            origin: {
              source: "checkpoint_capture",
              checkpointCapture: {
                captureId: "capture-private",
                operationId: "operation-private",
                part: "activity",
              },
            },
          }
        : {}),
    });
  const transcript = path.join(root, "cc.jsonl");
  writeFileSync(
    transcript,
    frame({
      result: {
        thread: { id: "thread-private", ...(advertised ? { path: file } : {}) },
      },
    }) +
      frame({
        method: "turn/started",
        params: {
          threadId: "thread-private",
          turn: { id: "ordinary-private" },
        },
      }) +
      frame(
        {
          method: "turn/started",
          params: {
            threadId: "thread-private",
            turn: { id: "capture-private-turn" },
          },
        },
        true,
      ),
  );
  return { root, transcript, evidence: path.join(root, "evidence") };
}

describe("independent Codex native evidence", () => {
  it("archives exact native windows and sees silent capture calls independently of notifications", () => {
    const ordinary =
      event("task_started", "ordinary-private") +
      native("response_item", {
        type: "custom_tool_call",
        name: "exec",
        input: "ordinary-tool-positive.txt CODEX-WRITABLE-CONTROL-731 \u2028",
      }) +
      event("task_complete", "ordinary-private");
    const capture =
      event("task_started", "capture-private-turn") +
      native("response_item", {
        type: "function_call",
        name: "shell",
        arguments: "secret",
      }) +
      event("task_complete", "capture-private-turn");
    const f = fixture(ordinary + capture);
    const result = auditCodexRun(f.transcript, f.evidence);
    expect(result.windows).toMatchObject([
      {
        kind: "ordinary",
        coverage: "complete",
        positiveControl: true,
        callKinds: ["custom_tool_call"],
        bytes: Buffer.byteLength(ordinary),
        startOffset: 0,
      },
      {
        kind: "capture",
        coverage: "complete",
        positiveControl: false,
        callKinds: ["function_call"],
        bytes: Buffer.byteLength(capture),
        startOffset: Buffer.byteLength(ordinary),
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private|secret|native.jsonl/);
    const windows = readdirSync(path.join(f.evidence, "native")).filter(
      (name) => name.endsWith(".jsonl"),
    );
    expect(windows).toHaveLength(2);
    const contents = windows.map((name) => {
      const file = path.join(f.evidence, "native", name);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      return readFileSync(file, "utf8");
    });
    expect(contents).toEqual(expect.arrayContaining([ordinary, capture]));
  });
  it.each([true, false])(
    "distinguishes unreadable advertised path from absent facility (%s)",
    (advertised) => {
      const f = fixture(null, advertised);
      expect(auditCodexRun(f.transcript, f.evidence).windows).toMatchObject([
        { coverage: advertised ? "incomplete" : "unavailable" },
        { coverage: advertised ? "incomplete" : "unavailable" },
      ]);
    },
  );
  it("keeps call evidence when a matching terminal is missing", () => {
    const f = fixture(
      event("task_started", "capture-private-turn") +
        native("response_item", { type: "custom_tool_call", name: "exec" }),
    );
    expect(auditCodexRun(f.transcript, f.evidence).windows[1]).toMatchObject({
      coverage: "incomplete",
      callKinds: ["custom_tool_call"],
    });
  });
  it.each(["wrong-terminal", "overlap"])(
    "rejects %s while preserving the inspected call",
    (failure) => {
      const tail =
        failure === "overlap"
          ? event("task_started", "other-turn") +
            event("task_complete", "capture-private-turn")
          : event("task_complete", "other-turn");
      const f = fixture(
        event("task_started", "capture-private-turn") +
          native("response_item", { type: "function_call", name: "shell" }) +
          tail,
      );
      expect(auditCodexRun(f.transcript, f.evidence).windows[1]).toMatchObject({
        coverage: "incomplete",
        callKinds: ["function_call"],
      });
    },
  );
  it("reports a capture with no observed provider start as incomplete", () => {
    const f = fixture(null);
    writeFileSync(
      f.transcript,
      line({
        type: "checkpoint_capture_control",
        origin: {
          source: "checkpoint_capture",
          checkpointCapture: {
            captureId: "capture-private",
            operationId: "operation-private",
          },
        },
      }),
    );
    expect(auditCodexRun(f.transcript, f.evidence).windows).toMatchObject([
      { kind: "capture", coverage: "incomplete", bytes: 0 },
    ]);
  });

  it("retains a previously disclosed native path when later thread results omit it", () => {
    const f = fixture(
      event("task_started", "capture-private-turn") +
        event("task_complete", "capture-private-turn"),
    );
    writeFileSync(
      f.transcript,
      readFileSync(f.transcript, "utf8") +
        line({
          type: "codex_app_server",
          raw: {
            record: JSON.stringify({
              result: { thread: { id: "thread-private" } },
            }),
          },
        }),
    );
    expect(auditCodexRun(f.transcript, f.evidence).windows[1]).toMatchObject({
      coverage: "complete",
    });
  });
});
