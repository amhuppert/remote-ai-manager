import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import type { CliEnv, CliHost, FetchInit } from "../shared";

const env: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "token",
  CC_PROJECT: "cc",
  CC_SESSION: "feature",
  CC_CONVERSATION_SCOPE: "session",
  CC_CONVERSATION_ID: "conv-1",
  CC_WORKFLOW_EXECUTION_ID: "exec-1",
  CC_WORKFLOW_CONTEXT_ID: "api",
};

interface RecordedRequest {
  path: string;
  init: FetchInit;
}

interface TestHost extends CliHost {
  requests: RecordedRequest[];
  progress: string[];
  files: Map<string, string>;
  privateWrites: Array<{ path: string; content: string }>;
  removedFiles: string[];
  writePrivateTextFile(filePath: string, content: string): Promise<void>;
  removeFile(filePath: string): Promise<void>;
  emit(signal: "SIGINT" | "SIGTERM"): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hostWith(
  respond: (request: RecordedRequest, index: number) => Response,
  options: { signalOnSleep?: "SIGINT" | "SIGTERM" } = {},
): TestHost {
  const requests: RecordedRequest[] = [];
  const progress: string[] = [];
  const files = new Map<string, string>();
  const privateWrites: Array<{ path: string; content: string }> = [];
  const removedFiles: string[] = [];
  let signalListener: ((signal: "SIGINT" | "SIGTERM") => void) | null = null;
  let signalSent = false;
  return {
    requests,
    progress,
    files,
    privateWrites,
    removedFiles,
    async fetch(url, init) {
      const request = { path: new URL(url).pathname, init };
      requests.push(request);
      return respond(request, requests.length - 1);
    },
    readTextFile: async (filePath) => files.get(filePath) ?? null,
    readFileBytes: async () => null,
    async writePrivateTextFile(filePath, content) {
      privateWrites.push({ path: filePath, content });
      files.set(filePath, content);
    },
    async removeFile(filePath) {
      removedFiles.push(filePath);
      files.delete(filePath);
    },
    async sleep() {
      if (options.signalOnSleep && !signalSent) {
        signalSent = true;
        signalListener?.(options.signalOnSleep);
      }
    },
    writeStdout(text) {
      progress.push(text);
    },
    onSignal(listener) {
      signalListener = listener;
      return () => {
        signalListener = null;
      };
    },
    emit(signal) {
      signalListener?.(signal);
    },
    platform: "darwin",
    homedir: "/Users/test",
  };
}

const listBody = {
  commands: [
    {
      name: "test",
      cost: 4,
      description: "Run focused tests",
      pathArgs: "paths",
      changedScope: "native",
      timeoutMs: 600_000,
      enabled: true,
      command: "scripts/validate/test.sh",
    },
    {
      name: "format",
      cost: 1,
      description: null,
      pathArgs: "forbid",
      changedScope: "full_fallback",
      timeoutMs: null,
      enabled: false,
      command: "scripts/validate/format.sh",
    },
  ],
  capacity: { limit: 8, inUse: 3, queueDepth: 1 },
  runs: [],
};

describe("cctl validate list", () => {
  it("renders policy enablement and capacity without exposing executables", async () => {
    const host = hostWith(() => json(listBody));

    const result = await runCli(["validate", "list"], env, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test");
    expect(result.stdout).toContain("cost 4");
    expect(result.stdout).toContain("enabled");
    expect(result.stdout).toContain("changed native");
    expect(result.stdout).toContain("changed → full");
    expect(result.stdout).toContain("3 of 8 capacity units in use");
    expect(result.stdout).not.toContain("scripts/validate");
    expect(host.requests[0]?.path).toBe(
      "/api/projects/cc/sessions/feature/conversations/conv-1/validation",
    );
  });
});

describe("cctl validate run", () => {
  it("forwards only '--' paths and lane identity, then renews the lease while polling", async () => {
    const host = hostWith((_request, index) => {
      if (index === 0) {
        return json(
          {
            kind: "accepted",
            runId: "vrun-1",
            status: "queued",
            position: 2,
            lease: {
              runId: "vrun-1",
              token: "lease-1",
              expiresAt: "2026-08-05T12:00:00.000Z",
            },
            requestedScope: "changed",
            effectiveScope: "changed",
          },
          202,
        );
      }
      if (index === 1) {
        return json({
          runId: "vrun-1",
          status: "queued",
          position: 1,
          result: null,
          requestedScope: "changed",
          effectiveScope: "changed",
        });
      }
      if (index === 2) {
        return json({
          runId: "vrun-1",
          status: "running",
          position: null,
          result: null,
          requestedScope: "changed",
          effectiveScope: "changed",
        });
      }
      return json({
        runId: "vrun-1",
        status: "passed",
        position: null,
        requestedScope: "changed",
        effectiveScope: "changed",
        result: {
          kind: "passed",
          runId: "vrun-1",
          exitCode: 0,
          output: "1 test passed",
        },
      });
    });

    const result = await runCli(
      ["validate", "run", "test", "--wait", "--", "src/example.test.ts"],
      { ...env, CC_VALIDATION_RUN_ID: undefined },
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 test passed");
    expect(host.progress.join("")).toContain("queue position 3");
    expect(host.progress.join("")).toContain("queue position 2");
    expect(JSON.parse(host.requests[0]?.init.body ?? "{}")).toEqual({
      commandName: "test",
      scope: "changed",
      wait: true,
      scopePaths: ["src/example.test.ts"],
      workflowExecutionId: "exec-1",
      workflowContextId: "api",
    });
    for (const request of host.requests.slice(1)) {
      expect(request.init.headers["x-cc-validation-lease-token"]).toBe(
        "lease-1",
      );
    }
    expect(host.privateWrites).toEqual([
      expect.objectContaining({ content: "lease-1\n" }),
    ]);
    expect(host.removedFiles).toEqual([host.privateWrites[0]?.path]);
  });

  it("sends explicit full scope for the same logical command", async () => {
    const host = hostWith(() =>
      json({
        kind: "not_started",
        result: {
          kind: "skipped_by_policy",
          message: "Skipped by policy.",
        },
      }),
    );

    const result = await runCli(
      ["validate", "run", "test", "--scope", "full"],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(host.requests[0]?.init.body ?? "{}")).toMatchObject({
      commandName: "test",
      scope: "full",
    });
  });

  it.each([
    {
      name: "unknown scope",
      args: ["validate", "run", "test", "--scope", "partial"],
    },
    {
      name: "full scope with paths",
      args: [
        "validate",
        "run",
        "test",
        "--scope",
        "full",
        "--",
        "src/example.test.ts",
      ],
    },
  ])("rejects $name before any request", async ({ args }) => {
    const host = hostWith(() => json({}));

    const result = await runCli(args, env, host);

    expect(result.exitCode).toBe(2);
    expect(host.requests).toEqual([]);
  });

  it("reports fail-fast capacity with both numbers and a hint", async () => {
    const host = hostWith(() =>
      json({
        kind: "not_started",
        result: {
          kind: "capacity_unavailable",
          cost: 8,
          inUse: 3,
          limit: 8,
          queueDepth: 0,
          blockedByOlderWaiter: false,
        },
      }),
    );

    const result = await runCli(["validate", "run", "test"], env, host);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Validation "test" was not started');
    expect(result.stderr).toContain("costs 8");
    expect(result.stderr).toContain("3 of 8");
    expect(result.stderr).toContain("--wait");
    expect(result.stderr).toContain("hint:");
  });

  it("names older FIFO waiters and queue depth when raw capacity is not the blocker", async () => {
    const host = hostWith(() =>
      json({
        kind: "not_started",
        result: {
          kind: "capacity_unavailable",
          cost: 1,
          inUse: 1,
          limit: 8,
          queueDepth: 2,
          blockedByOlderWaiter: true,
        },
      }),
    );

    const result = await runCli(["validate", "run", "typecheck"], env, host);

    expect(result.stderr).toContain("2 older waiters");
    expect(result.stderr).toContain("queue depth 2");
  });

  it("renders policy skip as a server-authored instruction and exits zero", async () => {
    const instruction =
      'Skipped "format": workflow policy disables it. Do not run it by other means.';
    const host = hostWith(() =>
      json({
        kind: "not_started",
        result: { kind: "skipped_by_policy", message: instruction },
      }),
    );

    const result = await runCli(
      ["validate", "run", "format", "--json"],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      code: "validation_policy_skipped",
      instruction,
    });
  });

  it("rejects unknown commands as usage and oversized costs as operation failures", async () => {
    const unknownHost = hostWith(() =>
      json({
        kind: "not_started",
        result: {
          kind: "command_not_found",
          name: "nope",
          knownCommands: ["test", "format"],
        },
      }),
    );
    const unknown = await runCli(
      ["validate", "run", "nope", "--json"],
      env,
      unknownHost,
    );
    expect(unknown.exitCode).toBe(2);
    expect(JSON.parse(unknown.stdout)).toMatchObject({
      code: "validation_command_not_found",
    });

    const oversizedHost = hostWith(() =>
      json({
        kind: "not_started",
        result: {
          kind: "cost_exceeds_limit",
          name: "test",
          cost: 9,
          limit: 8,
        },
      }),
    );
    const oversized = await runCli(
      ["validate", "run", "test", "--wait", "--json"],
      env,
      oversizedHost,
    );
    expect(oversized.exitCode).toBe(1);
    expect(JSON.parse(oversized.stdout)).toMatchObject({
      code: "validation_cost_exceeds_limit",
      cost: 9,
      limit: 8,
    });
  });

  it("preserves a queued cost-limit rejection as the stable configured-cost outcome", async () => {
    const host = hostWith((_request, index) => {
      if (index === 0) {
        return json(
          {
            kind: "accepted",
            runId: "vrun-oversized",
            status: "queued",
            position: 0,
            lease: {
              runId: "vrun-oversized",
              token: "lease-oversized",
              expiresAt: "2026-08-05T12:00:00.000Z",
            },
            requestedScope: "changed",
            effectiveScope: "changed",
          },
          202,
        );
      }
      return json({
        runId: "vrun-oversized",
        status: "cost_exceeds_limit",
        position: null,
        requestedScope: "changed",
        effectiveScope: "changed",
        result: {
          kind: "cost_exceeds_limit",
          name: "test",
          cost: 9,
          limit: 8,
        },
      });
    });

    const result = await runCli(
      ["validate", "run", "test", "--wait", "--json"],
      env,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "validation_cost_exceeds_limit",
      name: "test",
      cost: 9,
      limit: 8,
    });
    expect(result.stderr).toContain("lower-worker command profile");
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "cancels explicitly on %s before returning",
    async (signal) => {
      const host = hostWith(
        (request, index) => {
          if (index === 0) {
            return json(
              {
                kind: "accepted",
                runId: "vrun-1",
                status: "queued",
                position: 0,
                lease: {
                  runId: "vrun-1",
                  token: "lease-1",
                  expiresAt: "2026-08-05T12:00:00.000Z",
                },
                requestedScope: "changed",
                effectiveScope: "changed",
              },
              202,
            );
          }
          if (request.path.endsWith("/cancel")) {
            return json({ cancelled: true });
          }
          return json({
            runId: "vrun-1",
            status: "queued",
            position: 0,
            result: null,
            requestedScope: "changed",
            effectiveScope: "changed",
          });
        },
        { signalOnSleep: signal },
      );

      const result = await runCli(
        ["validate", "run", "test", "--wait", "--json"],
        env,
        host,
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "validation_cancelled_by_signal",
        signal,
      });
      const cancel = host.requests.find((request) =>
        request.path.endsWith("/validation/vrun-1/cancel"),
      );
      expect(cancel?.init.headers["x-cc-validation-lease-token"]).toBe(
        "lease-1",
      );
    },
  );

  it("maps validation failure output and the underlying exit code without redefining cctl's exit", async () => {
    const host = hostWith((_request, index) => {
      if (index === 0) {
        return json(
          {
            kind: "accepted",
            runId: "vrun-failed",
            status: "running",
            position: null,
            lease: {
              runId: "vrun-failed",
              token: "lease-failed",
              expiresAt: "2026-08-05T12:00:00.000Z",
            },
            requestedScope: "changed",
            effectiveScope: "changed",
          },
          202,
        );
      }
      return json({
        runId: "vrun-failed",
        status: "failed",
        position: null,
        requestedScope: "changed",
        effectiveScope: "changed",
        result: {
          kind: "failed",
          runId: "vrun-failed",
          exitCode: 7,
          output: "focused assertion failed",
        },
      });
    });

    const result = await runCli(
      ["validate", "run", "test", "--json"],
      env,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "validation_failed",
      validationExitCode: 7,
      output: "focused assertion failed",
    });
  });

  it("keeps server-side path validation as a structured usage error", async () => {
    const host = hostWith(() =>
      json(
        {
          error: 'Path argument "--pool" was refused (option_token)',
          code: "validation_path_args_rejected",
          issues: [
            {
              path: "scopePaths.0",
              message: "forwarded values must be relative worktree paths",
            },
          ],
        },
        400,
      ),
    );

    const result = await runCli(
      ["validate", "run", "test", "--json", "--", "--pool"],
      env,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "validation_path_args_rejected",
      issues: [
        {
          path: "scopePaths.0",
          message: "forwarded values must be relative worktree paths",
        },
      ],
    });
  });
});

describe("cctl validate status and cancel", () => {
  it("renders active runs when status has no run id", async () => {
    const host = hostWith(() =>
      json({
        ...listBody,
        runs: [
          {
            runId: "vrun-2",
            commandName: "test",
            status: "queued",
            cost: 4,
            source: "agent_cli",
            projectPath: "/repos/cc",
            conversationId: "conv-2",
            requestedScope: "changed",
            effectiveScope: "changed",
            position: 1,
          },
        ],
      }),
    );
    const result = await runCli(["validate", "status"], env, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("vrun-2");
    expect(result.stdout).toContain("queue position 2");
    expect(result.stdout).toContain("scope changed");
  });

  it("polls one run and maps a standalone cancel request", async () => {
    const statusHost = hostWith(() =>
      json({
        runId: "vrun-2",
        status: "failed",
        position: null,
        requestedScope: "changed",
        effectiveScope: "changed",
        result: {
          kind: "failed",
          runId: "vrun-2",
          exitCode: 5,
          output: "failed output",
        },
      }),
    );
    const status = await runCli(
      ["validate", "status", "vrun-2", "--json"],
      env,
      statusHost,
    );
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      ok: true,
      runId: "vrun-2",
      status: "failed",
      requestedScope: "changed",
      effectiveScope: "changed",
    });

    const cancelHost = hostWith(() => json({ cancelled: true }));
    const leasePath =
      "/Users/test/Library/Application Support/cc/validation-lease-vrun-2.token";
    cancelHost.files.set(leasePath, "lease-2\n");
    const cancel = await runCli(
      ["validate", "cancel", "vrun-2"],
      env,
      cancelHost,
    );
    expect(cancel.exitCode).toBe(0);
    expect(cancel.stdout).toContain("cancelled validation run vrun-2");
    expect(
      cancelHost.requests[0]?.init.headers["x-cc-validation-lease-token"],
    ).toBe("lease-2");
    expect(cancelHost.removedFiles).toContain(leasePath);
  });
});
