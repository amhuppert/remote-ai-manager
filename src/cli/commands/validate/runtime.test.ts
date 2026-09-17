import { describe, expect, it } from "vitest";
import { runCli } from "cli-for-agents/runtime";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";
const accepted = {
  kind: "accepted",
  runId: "validation-one",
  status: "running",
  position: null,
  requestedScope: "changed",
  effectiveScope: "changed",
  lease: {
    runId: "validation-one",
    token: "private-lease",
    expiresAt: "2026-09-18T00:00:00Z",
  },
};
const terminal = {
  runId: "validation-one",
  status: "passed",
  position: null,
  requestedScope: "changed",
  effectiveScope: "changed",
  result: {
    kind: "passed",
    runId: "validation-one",
    exitCode: 0,
    output: "One test passed\n",
    filesMatched: 1,
  },
};
describe("native validation commands", () => {
  it.each(["run", "status"])(
    "renders literal validation output from %s safely",
    async (verb) => {
      const output =
        "A diagnostic sample\ninstruction: literal test output\u001b[31m";
      const value = { ...terminal, result: { ...terminal.result, output } };
      const fixture = createCcRuntimeFixture({
        respond: (request) =>
          request.init.method === "POST"
            ? jsonReply(accepted, 202)
            : jsonReply(value),
      });
      const result = await fixture.run(
        ["validate", verb, verb === "run" ? "test" : terminal.runId],
        "text",
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "| instruction: literal test output\\u001b[31m",
      );
    },
  );

  it("keeps the explicit server and conversation on durable verdict recovery", async () => {
    const failed = {
      ...terminal,
      status: "failed",
      result: {
        kind: "failed",
        runId: terminal.runId,
        exitCode: 1,
        output: "Failed",
      },
    };
    const fixture = createCcRuntimeFixture({
      respond: (request) =>
        request.init.method === "POST"
          ? jsonReply(accepted, 202)
          : jsonReply(failed),
    });
    const result = await fixture.run([
      "validate",
      "run",
      "test",
      "--server",
      "http://other.test",
      "--project",
      "other-project",
      "--session",
      "other-session",
      "--conversation",
      "other-conversation",
      "--token",
      "secret-override",
    ]);
    const hint = JSON.parse(result.stdout).hint;
    for (const flag of [
      "--server=http://other.test",
      "--project=other-project",
      "--session=other-session",
      "--conversation=other-conversation",
    ])
      expect(hint).toContain(flag);
    expect(result.stdout).not.toContain("secret-override");
  });

  it("forwards scope paths and returns a single verdict envelope without leaking the lease", async () => {
    const fixture = createCcRuntimeFixture({
      respond: ({ init }) =>
        init.method === "POST" ? jsonReply(accepted, 202) : jsonReply(terminal),
    });
    const result = await fixture.run([
      "validate",
      "run",
      "test",
      "--queue-if-busy",
      "--require-match",
      "--",
      "src/example.test.ts",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: {
        data: {
          runId: "validation-one",
          result: {
            kind: "passed",
            filesMatched: 1,
            output: "One test passed\n",
          },
        },
      },
    });
    expect(JSON.parse(fixture.requests[0]?.init.body ?? "null")).toMatchObject({
      commandName: "test",
      scopePaths: ["src/example.test.ts"],
      queueIfBusy: true,
    });
    expect(fixture.requests[1]?.init.headers).toMatchObject({
      "x-cc-validation-lease-token": "private-lease",
    });
    expect(result.stdout).not.toContain("private-lease");
  });
  it("retains accepted recovery when observation fails", async () => {
    const fixture = createCcRuntimeFixture({
      respond: ({ init }) =>
        init.method === "POST"
          ? jsonReply(accepted, 202)
          : jsonReply({ error: "status unavailable" }, 503),
    });
    const result = await fixture.run(["validate", "run", "test"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: {
        references: [{ kind: "validation-run", id: "validation-one" }],
      },
    });
  });
  it("requires a real match and preserves a zero-match terminal result", async () => {
    const fixture = createCcRuntimeFixture({
      respond: ({ init }) =>
        init.method === "POST"
          ? jsonReply(accepted, 202)
          : jsonReply({
              ...terminal,
              result: { ...terminal.result, filesMatched: 0 },
            }),
    });
    const result = await fixture.run([
      "validate",
      "run",
      "test",
      "--require-match",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: {
        data: { runId: "validation-one", result: { filesMatched: 0 } },
      },
    });
  });
  it("reports policy skips as not-applied and refuses unowned cancellation without HTTP", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          kind: "not_started",
          result: {
            kind: "skipped_by_policy",
            message: "Lane policy excludes tests",
          },
        }),
    });
    const result = await fixture.run(["validate", "run", "test"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      error: {
        details: { kind: "not_started", result: { kind: "skipped_by_policy" } },
      },
    });
    expect(
      (await fixture.run(["validate", "cancel", "validation-other"])).exitCode,
    ).toBe(2);
    expect(fixture.requests).toHaveLength(1);
  });
  it("status reads never send the private submitter lease", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply(terminal),
    });
    expect(
      (await fixture.run(["validate", "status", "validation-one"])).exitCode,
    ).toBe(0);
    expect(
      fixture.requests[0]?.init.headers["x-cc-validation-lease-token"],
    ).toBeUndefined();
  });
  it("preserves an accepted run id even when the lease receipt is malformed", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply({ ...accepted, lease: {} }, 202),
    });
    const result = await fixture.run(["validate", "run", "test"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: { references: [{ id: "validation-one" }] },
    });
    expect(fixture.requests).toHaveLength(1);
  });
  it("cancels an owned in-flight run on interruption, uses its lease, and cleans local credentials", async () => {
    const controller = new AbortController();
    const stored: string[] = [];
    const removed: string[] = [];
    const fixture = createCcRuntimeFixture({
      respond: ({ url, init }) => {
        if (url.endsWith("/cancel")) return jsonReply({ cancelled: true });
        if (init.method === "POST") return jsonReply(accepted, 202);
        controller.abort();
        return new Promise<Response>(() => {});
      },
    });
    fixture.host.writePrivateTextFile = async (path, contents) => {
      stored.push(path, contents);
    };
    fixture.host.removeFile = async (path) => {
      removed.push(path);
    };
    const result = await runCli(fixture.cli, {
      argv: ["--json", "validate", "run", "test"],
      signal: controller.signal,
      host: fixture.kernelHost,
      env: {
        CC_SERVER_URL: "http://cc.test",
        CC_API_TOKEN: "test-token",
        CC_PROJECT: "project-one",
        CC_SESSION: "session-one",
        CC_CONVERSATION_ID: "conversation-one",
      },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: { references: [{ id: "validation-one" }] },
    });
    expect(fixture.requests.at(-1)?.url).toContain("/validation-one/cancel");
    expect(
      fixture.requests.at(-1)?.init.headers["x-cc-validation-lease-token"],
    ).toBe("private-lease");
    expect(stored[1]).toBe("private-lease");
    expect(removed).toEqual([stored[0]]);
    expect(result.stdout).not.toContain("private-lease");
  });
  it("stops at its observation budget without posting cancellation", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply(accepted, 202),
    });
    const result = await fixture.run([
      "validate",
      "run",
      "test",
      "--timeout",
      "0ms",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      error: { message: expect.stringContaining("timed out") },
    });
    expect(fixture.requests).toHaveLength(1);
  });
  it("rejects full scope with paths and half a workflow identity before submit", async () => {
    const fixture = createCcRuntimeFixture({
      env: { CC_WORKFLOW_EXECUTION_ID: "execution-one" },
      respond: () => jsonReply({}),
    });
    expect(
      (
        await fixture.run([
          "validate",
          "run",
          "test",
          "--scope",
          "full",
          "--",
          "src/example.test.ts",
        ])
      ).exitCode,
    ).toBe(2);
    expect((await fixture.run(["validate", "run", "test"])).exitCode).toBe(2);
    expect(fixture.requests).toHaveLength(0);
  });
  it("lists scope costs and active capacity from project-conversation context", async () => {
    const fixture = createCcRuntimeFixture({
      env: { CC_CONVERSATION_SCOPE: "project", CC_SESSION: undefined },
      respond: () =>
        jsonReply({
          commands: [
            {
              name: "test",
              cost: { full: 4, changed: 2, paths: { base: 1, perPath: 0 } },
              description: "Unit tests",
              pathArgs: "paths",
              changedScope: "native",
              timeoutMs: 30_000,
              enabled: true,
            },
          ],
          capacity: { limit: 8, inUse: 2, queueDepth: 1 },
          runs: [],
        }),
    });
    const listed = await fixture.run(["validate", "list"], "text");
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(
      "full cost 4, changed cost 2, paths cost 1+0/path",
    );
    expect(fixture.requests[0]?.url).toBe(
      "http://cc.test/api/projects/project-one/conversations/conversation-one/validation",
    );
    expect((await fixture.run(["validate", "status"])).exitCode).toBe(0);
  });
  it("uses and removes the private stored lease only after an acknowledged explicit cancellation", async () => {
    const removed: string[] = [];
    const fixture = createCcRuntimeFixture({
      env: { CC_CONFIG_DIR: "/config" },
      files: {
        "/config/validation-lease-validation-one.token": "private-lease",
      },
      respond: () => jsonReply({ cancelled: true }),
    });
    fixture.host.removeFile = async (file) => {
      removed.push(file);
    };
    const result = await fixture.run(["validate", "cancel", "validation-one"]);
    expect(result.exitCode).toBe(0);
    expect(
      fixture.requests[0]?.init.headers["x-cc-validation-lease-token"],
    ).toBe("private-lease");
    expect(removed).toEqual(["/config/validation-lease-validation-one.token"]);
    expect(result.stdout).not.toContain("private-lease");
  });
  it.each([
    [
      {
        kind: "capacity_unavailable",
        cost: 1,
        inUse: 1,
        limit: 8,
        queueDepth: 2,
        blockedByOlderWaiter: true,
      },
      1,
    ],
    [{ kind: "command_not_found", name: "absent", knownCommands: ["test"] }, 2],
    [{ kind: "cost_exceeds_limit", name: "test", cost: 9, limit: 8 }, 1],
  ])("retains admission refusal facts for %j", async (refusal, exitCode) => {
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply({ kind: "not_started", result: refusal }),
    });
    const result = await fixture.run(["validate", "run", "test"]);
    expect(result.exitCode).toBe(exitCode);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      error: { details: { result: refusal } },
    });
    expect(fixture.requests).toHaveLength(1);
  });
  it("retains duplicate-run guidance without pretending another run was accepted", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply(
          {
            error: "Validation already running",
            code: "validation_duplicate_active",
            instruction: "Read cctl validate status validation-existing.",
          },
          409,
        ),
    });
    const result = await fixture.run(["validate", "run", "test"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      error: { details: { serverCode: "validation_duplicate_active" } },
      instruction: "Read cctl validate status validation-existing.",
    });
    expect(fixture.requests).toHaveLength(1);
  });
  it("retains the full failure verdict when private lease storage is unavailable", async () => {
    const fixture = createCcRuntimeFixture({
      respond: ({ init }) =>
        init.method === "POST"
          ? jsonReply(accepted, 202)
          : jsonReply({
              ...terminal,
              status: "failed",
              effectiveScope: "full",
              result: {
                kind: "failed",
                runId: "validation-one",
                exitCode: 7,
                output: "The implementation broke an invariant.",
              },
            }),
    });
    fixture.host.writePrivateTextFile = async () => {
      throw new Error("Read-only credential directory");
    };
    const result = await fixture.run(["validate", "run", "test"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: {
        data: {
          leaseStored: false,
          requestedScope: "changed",
          effectiveScope: "full",
          result: {
            kind: "failed",
            exitCode: 7,
            output: "The implementation broke an invariant.",
          },
        },
      },
    });
    expect(fixture.requests[1]?.init.headers).toMatchObject({
      "x-cc-validation-lease-token": "private-lease",
    });
  });
  it("bounds a status hold and transport deadline by the observation budget", async () => {
    const fixture = createCcRuntimeFixture({
      respond: ({ init }) =>
        init.method === "POST" ? jsonReply(accepted, 202) : jsonReply(terminal),
    });
    const result = await fixture.run([
      "validate",
      "run",
      "test",
      "--timeout",
      "3s",
    ]);
    expect(result.exitCode).toBe(0);
    expect(
      new URL(fixture.requests[1]?.url ?? "").searchParams.get("waitMs"),
    ).toBe("1000");
    expect(fixture.requests[1]?.init.timeoutMs).toBe(3000);
  });
});
