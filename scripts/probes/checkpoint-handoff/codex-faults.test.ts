import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { observeCodexFaultProcess } from "./codex-faults";
import type { AppServerProcessHost } from "@/lib/agent-backends/codex/app-server-client";

function fixture() {
  let start = "original";
  let group = 71;
  let exit: (() => void) | undefined;
  const signals: NodeJS.Signals[] = [];
  const host: AppServerProcessHost = {
    spawn: () => ({
      pid: 71,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onExit(listener) {
        exit = () => listener(0, null);
        return () => {};
      },
      onError: () => () => {},
    }),
    startTicks: async () => start,
    processGroupId: () => group,
    isGroupAlive: () => true,
    signalGroup: (_, signal) => {
      signals.push(signal);
    },
  };
  const observer = observeCodexFaultProcess(host);
  return {
    observer,
    signals,
    spawn: () => observer.host.spawn({ cwd: ".", env: {} }),
    replace: () => {
      start = "replacement";
    },
    ungroup: () => {
      group = 72;
    },
    exit: () => exit?.(),
  };
}

describe("owned Codex fault process", () => {
  it("never signals an unspawned, replaced or exited process", async () => {
    const f = fixture();
    expect(await f.observer.signal("SIGTERM")).toBe(false);
    f.spawn();
    f.replace();
    expect(await f.observer.signal("SIGTERM")).toBe(false);
    expect(f.signals).toEqual([]);
  });
  it("retains actual suspension/resumption and collection evidence", async () => {
    const f = fixture();
    f.spawn();
    expect(await f.observer.signal("SIGSTOP")).toBe(true);
    expect(await f.observer.signal("SIGCONT")).toBe(true);
    f.exit();
    expect(await f.observer.signal("SIGKILL")).toBe(false);
    expect(f.observer.evidence()).toEqual({
      pid: 71,
      exitObserved: true,
      signals: ["SIGSTOP", "SIGCONT"],
      childrenInspectionAvailable: null,
      childrenCleared: null,
    });
  });
  it("refuses signalling when the owned child no longer leads its group", async () => {
    const f = fixture();
    f.spawn();
    f.ungroup();
    expect(await f.observer.signal("SIGTERM")).toBe(false);
    expect(f.signals).toEqual([]);
  });
});

import { challengeCodexCaptureInput } from "./codex-faults";
import { CHECKPOINT_CAPTURE_LIMITS } from "@/lib/conversation-checkpoints/budget";
import type { CaptureHandoffInput } from "@/lib/agent-backends/conversation";

it("changes only the explicitly challenged input while preserving capture policy and ownership", () => {
  const request: CaptureHandoffInput = {
    captureId: "bounded-capture",
    mode: "instruction-only",
    promptText: "Original capture prompt",
    outputSchema: { type: "object" },
    limits: CHECKPOINT_CAPTURE_LIMITS,
    signal: new AbortController().signal,
    onTranscript: async () => {},
  };
  for (const fault of ["tool-violation", "output-limit-challenge"] as const) {
    const altered = challengeCodexCaptureInput(
      request,
      fault,
      "/scratch/owned-canary.txt",
    );
    expect(altered.promptText).not.toBe(request.promptText);
    expect({ ...altered, promptText: request.promptText }).toEqual(request);
    expect(altered.limits).toBe(request.limits);
    expect(Buffer.byteLength(altered.promptText)).toBeLessThan(
      request.limits.inputBytes,
    );
  }
});
