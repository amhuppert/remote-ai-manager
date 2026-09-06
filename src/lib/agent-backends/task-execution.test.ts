import { describe, expect, it } from "vitest";
import type { AgentTaskRequest, AgentTaskRunner } from "./task";
import type { ExecutionCatalogEntry } from "./execution-admission";
import { runAdmittedTask } from "./task-execution";

function setup() {
  const received: AgentTaskRequest[] = [];
  const runner: AgentTaskRunner = {
    backend: "cursor",
    async run(request) {
      received.push(request);
      return {
        text: request.prompt.toUpperCase(),
        error: null,
        timedOut: false,
        usage: null,
        failure: null,
        continuationDisposition: "retain",
      };
    },
  };
  const entry: ExecutionCatalogEntry = {
    id: "cursor",
    label: "Cursor",
    facets: { conversation: false, tasks: true },
    execution: {
      conversation: null,
      tasks: {
        classes: ["nongoverned-task"],
        profiles: ["isolated-one-shot"],
        instructionDelivery: "user-message",
        fsWriteRestriction: "unsupported",
      },
    },
  };
  return { received, runner, entry };
}

function request(): AgentTaskRequest {
  return {
    executionClass: "nongoverned-task",
    executionProfile: "isolated-one-shot",
    workingDirectory: "/repo",
    prompt: "summarize",
    modelSelection: { modelId: "model", parameters: {} },
    timeoutMs: 0,
    autonomous: true,
  };
}

describe("admitted task dispatch", () => {
  it("does not admit an ownership policy under auxiliary intent even when enforcement exists", async () => {
    const harness = setup();
    harness.entry.execution.tasks!.fsWriteRestriction = "enforced";
    await expect(
      runAdmittedTask(
        "cursor",
        {
          ...request(),
          fsWritePolicy: { mode: "allowlist", allowWrite: [], denyWrite: [] },
        },
        harness,
      ),
    ).rejects.toThrow("Ownership policies require governed-execution");
    expect(harness.received).toEqual([]);
  });
  it("runs an admitted task and preserves its result", async () => {
    const harness = setup();
    expect((await runAdmittedTask("cursor", request(), harness)).text).toBe(
      "SUMMARIZE",
    );
    expect(harness.received).toEqual([request()]);
  });

  it("refuses a governed request before provider execution", async () => {
    const harness = setup();
    await expect(
      runAdmittedTask(
        "cursor",
        { ...request(), executionClass: "governed-execution" },
        harness,
      ),
    ).rejects.toMatchObject({ code: "backend-role-unsupported" });
    expect(harness.received).toEqual([]);
  });

  it("refuses undeclared profiles and supplied policies before execution", async () => {
    const harness = setup();
    await expect(
      runAdmittedTask(
        "cursor",
        { ...request(), executionProfile: "standard" },
        harness,
      ),
    ).rejects.toMatchObject({ code: "backend-task-profile-unsupported" });
    await expect(
      runAdmittedTask(
        "cursor",
        {
          ...request(),
          fsWritePolicy: { mode: "allowlist", allowWrite: [], denyWrite: [] },
        },
        harness,
      ),
    ).rejects.toMatchObject({ code: "backend-fs-policy-unsupported" });
    expect(harness.received).toEqual([]);
  });

  it("does not dispatch a resolver's substitute backend", async () => {
    const harness = setup();
    harness.runner = { ...harness.runner, backend: "claude" };
    await expect(runAdmittedTask("cursor", request(), harness)).rejects.toThrow(
      "backend mismatch",
    );
    expect(harness.received).toEqual([]);
  });
});
