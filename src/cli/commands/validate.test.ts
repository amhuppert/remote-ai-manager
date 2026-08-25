import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import type { CliEnv, CliHost, FetchInit } from "../shared";
import { validateHelpEntries } from "./validate.help";

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
  /** Full request URL — the only place query parameters are observable. */
  url: string;
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
      const request = { url, path: new URL(url).pathname, init };
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

const costTableListBody = {
  commands: [
    {
      name: "per-file",
      cost: { full: 5, paths: { base: 2, perPath: 1 } },
      description: null,
      pathArgs: "paths",
      changedScope: "native",
      timeoutMs: null,
      enabled: true,
    },
    {
      name: "no-paths-block",
      cost: { full: 6, changed: 4 },
      description: null,
      pathArgs: "paths",
      changedScope: "native",
      timeoutMs: null,
      enabled: true,
    },
    {
      name: "flat-scoped",
      cost: { full: 9, changed: 5, paths: { base: 2, perPath: 0 } },
      description: null,
      pathArgs: "paths",
      changedScope: "native",
      timeoutMs: null,
      enabled: true,
    },
    {
      name: "no-path-args",
      cost: { full: 8, changed: 3 },
      description: null,
      pathArgs: "forbid",
      changedScope: "native",
      timeoutMs: null,
      enabled: true,
    },
    {
      name: "full-only",
      cost: { full: 7 },
      description: null,
      pathArgs: "forbid",
      changedScope: "full_fallback",
      timeoutMs: null,
      enabled: true,
    },
  ],
  capacity: { limit: 8, inUse: 0, queueDepth: 0 },
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

  it("renders a scope-aware cost table with omitted weights resolved", async () => {
    const host = hostWith(() => json(costTableListBody));

    const result = await runCli(["validate", "list"], env, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cost 5 (changed 5, paths 2+1/path)");
    expect(result.stdout).toContain("cost 6 (changed 4, paths 4 flat)");
    expect(result.stdout).toContain("cost 9 (changed 5, paths 2 flat)");
    expect(result.stdout).toContain("cost 8 (changed 3)");
  });

  it("omits a scoped weight for a command with no changed variant", async () => {
    const host = hostWith(() => json(costTableListBody));

    const result = await runCli(["validate", "list"], env, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("full-only  cost 7  changed → full");
    expect(result.stdout).not.toContain("cost 7 (");
  });

  // The help text teaches the cost line by quoting a sample rendering, so the
  // sample is pinned to renderer output rather than to a second copy of the
  // format that can drift from what the command actually prints.
  it("quotes a rendering the renderer actually produces in its help text", async () => {
    const host = hostWith(() => json(costTableListBody));

    const result = await runCli(["validate", "list"], env, host);

    const rendered = /cost 5 \([^)]*\)/.exec(result.stdout)?.[0];
    if (rendered === undefined) {
      throw new Error(`no scope-aware cost line rendered: ${result.stdout}`);
    }
    const listHelp = validateHelpEntries.find(
      (entry) => entry.path.join(" ") === "validate list",
    );
    if (listHelp === undefined) {
      throw new Error("missing help entry for `validate list`");
    }
    expect(listHelp.description).toContain(rendered);
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
      [
        "validate",
        "run",
        "test",
        "--queue-if-busy",
        "--",
        "src/example.test.ts",
      ],
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
      queueIfBusy: true,
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
      queueIfBusy: false,
    });
  });

  it("uses --queue-if-busy for FIFO admission", async () => {
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
      ["validate", "run", "test", "--queue-if-busy"],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(host.requests[0]?.init.body ?? "{}")).toMatchObject({
      commandName: "test",
      queueIfBusy: true,
    });
  });

  it("rejects the retired validation --wait flag before making a request", async () => {
    const host = hostWith(() => json({}));

    const result = await runCli(
      ["validate", "run", "test", "--wait"],
      env,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown flag "--wait"');
    expect(host.requests).toEqual([]);
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
    expect(result.stderr).toContain("--queue-if-busy");
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

  // The skip text is a keep-true invariant ("do not run it by other means"),
  // not a do-now step: it is tier 2, and it reaches --json consumers as one.
  it("renders policy skip as a reminder on the success envelope and exits zero", async () => {
    const message =
      'Skipped "format": workflow policy disables it. Do not run it by other means.';
    const host = hostWith(() =>
      json({
        kind: "not_started",
        result: { kind: "skipped_by_policy", message },
      }),
    );

    const result = await runCli(
      ["validate", "run", "format", "--json"],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      ok: true,
      code: "validation_policy_skipped",
      reminders: [message],
    });
    expect(envelope.instruction).toBeUndefined();
  });

  it("renders the policy skip once, as a reminder line, in text mode", async () => {
    const message =
      'Skipped "format": workflow policy disables it. Do not run it by other means.';
    const host = hostWith(() =>
      json({
        kind: "not_started",
        result: { kind: "skipped_by_policy", message },
      }),
    );

    const result = await runCli(["validate", "run", "format"], env, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`reminder: ${message}\n`);
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
      ["validate", "run", "test", "--queue-if-busy", "--json"],
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
      ["validate", "run", "test", "--queue-if-busy", "--json"],
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
        ["validate", "run", "test", "--queue-if-busy", "--json"],
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

  it("renders an active duplicate as an actionable operation refusal", async () => {
    const message =
      'Refused duplicate "test": validation run "vrun-existing" is already running. Wait for it with `cctl validate status vrun-existing`.';
    const host = hostWith(() =>
      json(
        {
          error: message,
          code: "validation_duplicate_active",
          issues: [],
        },
        409,
      ),
    );

    const result = await runCli(
      ["validate", "run", "test", "--queue-if-busy", "--json"],
      env,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: message,
      code: "validation_duplicate_active",
    });
  });
});

function passingHost(
  output: string,
  scopes: { requested: string; effective: string } = {
    requested: "changed",
    effective: "changed",
  },
  filesMatched?: number,
): TestHost {
  return hostWith((_request, index) => {
    if (index === 0) {
      return json(
        {
          kind: "accepted",
          runId: "vrun-pass",
          status: "running",
          position: null,
          lease: {
            runId: "vrun-pass",
            token: "lease-pass",
            expiresAt: "2026-08-05T12:00:00.000Z",
          },
          requestedScope: scopes.requested,
          effectiveScope: scopes.effective,
        },
        202,
      );
    }
    return json({
      runId: "vrun-pass",
      status: "passed",
      position: null,
      requestedScope: scopes.requested,
      effectiveScope: scopes.effective,
      result: {
        kind: "passed",
        runId: "vrun-pass",
        exitCode: 0,
        output,
        ...(filesMatched === undefined ? {} : { filesMatched }),
      },
    });
  });
}

function acceptedHold(): Response {
  return json(
    {
      kind: "accepted",
      runId: "vrun-hold",
      status: "running",
      position: null,
      lease: {
        runId: "vrun-hold",
        token: "lease-hold",
        expiresAt: "2026-08-05T12:00:00.000Z",
      },
      requestedScope: "changed",
      effectiveScope: "changed",
    },
    202,
  );
}

function passedHold(): Response {
  return json({
    runId: "vrun-hold",
    status: "passed",
    position: null,
    requestedScope: "changed",
    effectiveScope: "changed",
    result: {
      kind: "passed",
      runId: "vrun-hold",
      exitCode: 0,
      output: "",
    },
  });
}

/** Accepts the submission, then never reaches a terminal result. */
function neverTerminalHost(): TestHost {
  return hostWith((_request, index) => {
    if (index === 0) {
      return json(
        {
          kind: "accepted",
          runId: "vrun-slow",
          status: "queued",
          position: 0,
          lease: {
            runId: "vrun-slow",
            token: "lease-slow",
            expiresAt: "2026-08-05T12:00:00.000Z",
          },
          requestedScope: "changed",
          effectiveScope: "changed",
        },
        202,
      );
    }
    return json({
      runId: "vrun-slow",
      status: "running",
      position: null,
      result: null,
      requestedScope: "changed",
      effectiveScope: "changed",
    });
  });
}

// The pass verdict must be explicit so a green run stays distinguishable from
// a run that matched zero files.
describe("cctl validate run — the pass verdict", () => {
  it("states the verdict, the command, the resolved scope, and the run id", async () => {
    const result = await runCli(
      ["validate", "run", "test"],
      env,
      passingHost(""),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "validation passed: test (scope changed→changed, run vrun-pass)",
    );
  });

  it("names both scopes when the server widened the request", async () => {
    const result = await runCli(
      ["validate", "run", "format"],
      env,
      passingHost("", { requested: "changed", effective: "full" }),
    );

    expect(result.stdout).toContain(
      "validation passed: format (scope changed→full, run vrun-pass)",
    );
  });

  it("carries the same facts in the --json envelope", async () => {
    const result = await runCli(
      ["validate", "run", "test", "--json"],
      env,
      passingHost("1 test passed"),
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      code: "validation_passed",
      commandName: "test",
      runId: "vrun-pass",
      requestedScope: "changed",
      effectiveScope: "changed",
      output: "1 test passed",
    });
  });

  it("puts the verdict ahead of the relayed runner output", async () => {
    const result = await runCli(
      ["validate", "run", "test"],
      env,
      passingHost("1 test passed"),
    );

    expect(result.stdout.indexOf("validation passed: test")).toBeLessThan(
      result.stdout.indexOf("1 test passed"),
    );
  });

  it("relays only the tail of a long pass output and names the reveal command", async () => {
    const output = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const result = await runCli(
      ["validate", "run", "test"],
      env,
      passingHost(output),
    );

    expect(result.stdout).toContain("line 59");
    expect(result.stdout).not.toContain("line 0\n");
    expect(result.stdout).toContain("of 60 output lines");
    expect(result.stdout).toContain("cctl validate status vrun-pass --json");
    // The envelope keeps every line.
    const jsonResult = await runCli(
      ["validate", "run", "test", "--json"],
      env,
      passingHost(output),
    );
    expect(JSON.parse(jsonResult.stdout).output).toBe(output);
  });

  it("relays a failing run's output in full", async () => {
    const output = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const host = hostWith((_request, index) => {
      if (index === 0) {
        return json(
          {
            kind: "accepted",
            runId: "vrun-fail",
            status: "running",
            position: null,
            lease: {
              runId: "vrun-fail",
              token: "lease-fail",
              expiresAt: "2026-08-05T12:00:00.000Z",
            },
            requestedScope: "changed",
            effectiveScope: "changed",
          },
          202,
        );
      }
      return json({
        runId: "vrun-fail",
        status: "failed",
        position: null,
        requestedScope: "changed",
        effectiveScope: "changed",
        result: {
          kind: "failed",
          runId: "vrun-fail",
          exitCode: 1,
          output,
        },
      });
    });

    const result = await runCli(["validate", "run", "test"], env, host);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("line 0");
    expect(result.stderr).toContain("line 59");
  });
});

// A run narrowed to paths that match nothing still exits 0, so the count is
// the only thing that separates a real green from a green over nothing.
describe("cctl validate run — matched files", () => {
  it("names the resolved file count in the verdict line", async () => {
    const result = await runCli(
      ["validate", "run", "test", "--", "src/example.test.ts"],
      env,
      passingHost("", { requested: "changed", effective: "changed" }, 12),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "validation passed: test (scope changed→changed, 12 files, run vrun-pass)",
    );
  });

  it("calls a zero-match pass vacuous, exits 0, and keeps the count in the envelope", async () => {
    const text = await runCli(
      ["validate", "run", "test", "--", "src/typo.test.ts"],
      env,
      passingHost("", { requested: "changed", effective: "changed" }, 0),
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(
      "0 files matched — vacuous pass, verify the scope path",
    );

    const structured = await runCli(
      ["validate", "run", "test", "--json", "--", "src/typo.test.ts"],
      env,
      passingHost("", { requested: "changed", effective: "changed" }, 0),
    );

    expect(structured.exitCode).toBe(0);
    expect(JSON.parse(structured.stdout)).toMatchObject({
      ok: true,
      code: "validation_passed",
      filesMatched: 0,
    });
  });

  it("exits 1 on a zero-match pass under --require-match", async () => {
    const result = await runCli(
      [
        "validate",
        "run",
        "test",
        "--require-match",
        "--json",
        "--",
        "src/typo.test.ts",
      ],
      env,
      passingHost("", { requested: "changed", effective: "changed" }, 0),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "validation_no_files_matched",
      filesMatched: 0,
    });
    expect(result.stderr).toContain("verify the scope path");
  });

  it("passes under --require-match when the scope resolved to files", async () => {
    const result = await runCli(
      ["validate", "run", "test", "--require-match", "--", "src/a.test.ts"],
      env,
      passingHost("", { requested: "changed", effective: "changed" }, 1),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 file, run vrun-pass");
  });

  // A changed or full run is narrowed inside the wrapper, so the server reports
  // no count at all — the ratchet has nothing to refuse.
  it("leaves an uncounted run alone under --require-match", async () => {
    const result = await runCli(
      ["validate", "run", "test", "--require-match"],
      env,
      passingHost("1 test passed"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "validation passed: test (scope changed→changed, run vrun-pass)",
    );
  });
});

describe("cctl validate run — the client wait budget", () => {
  it("gives up on --timeout and names the status command that recovers the verdict", async () => {
    const host = neverTerminalHost();

    const result = await runCli(
      [
        "validate",
        "run",
        "test",
        "--queue-if-busy",
        "--timeout",
        "3s",
        "--json",
      ],
      env,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "wait_timeout",
      details: { runId: "vrun-slow" },
    });
    // One submission plus one poll per second of budget.
    expect(host.requests).toHaveLength(4);
    // The private lease is local state of a wait that has ended.
    expect(host.removedFiles).toEqual([host.privateWrites[0]?.path]);
  });

  it("names the continuation command on stderr in text mode", async () => {
    const result = await runCli(
      ["validate", "run", "test", "--queue-if-busy", "--timeout", "2s"],
      env,
      neverTerminalHost(),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cctl validate status vrun-slow");
  });

  it("keeps streaming queue positions while the budget runs down", async () => {
    const host = hostWith((_request, index) => {
      if (index === 0) {
        return json(
          {
            kind: "accepted",
            runId: "vrun-slow",
            status: "queued",
            position: 2,
            lease: {
              runId: "vrun-slow",
              token: "lease-slow",
              expiresAt: "2026-08-05T12:00:00.000Z",
            },
            requestedScope: "changed",
            effectiveScope: "changed",
          },
          202,
        );
      }
      return json({
        runId: "vrun-slow",
        status: "queued",
        position: index === 1 ? 1 : 0,
        result: null,
        requestedScope: "changed",
        effectiveScope: "changed",
      });
    });

    const result = await runCli(
      ["validate", "run", "test", "--queue-if-busy", "--timeout", "2s"],
      env,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(host.progress.join("")).toContain("queue position 3");
    expect(host.progress.join("")).toContain("queue position 2");
    expect(host.progress.join("")).toContain("queue position 1");
  });

  it("rejects an unreadable --timeout before submitting anything", async () => {
    const host = hostWith(() => json({}));

    const result = await runCli(
      ["validate", "run", "test", "--queue-if-busy", "--timeout", "soon"],
      env,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(host.requests).toEqual([]);
  });

  it("asks the server to hold the status request up to its long-poll ceiling", async () => {
    const host = hostWith((_request, index) =>
      index === 0 ? acceptedHold() : passedHold(),
    );

    const result = await runCli(
      ["validate", "run", "test", "--queue-if-busy", "--timeout", "10m"],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    const poll = host.requests[1];
    expect(new URL(poll?.url ?? "").searchParams.get("waitMs")).toBe("25000");
    // The transport deadline outlives the hold by the response's own slack, so
    // a server that answers exactly at its ceiling is never cut off.
    expect(poll?.init.timeoutMs).toBe(27_000);
  });

  it("caps the hold and the transport deadline by what is left of the budget", async () => {
    const host = neverTerminalHost();

    const result = await runCli(
      ["validate", "run", "test", "--queue-if-busy", "--timeout", "3s"],
      env,
      host,
    );

    expect(result.exitCode).toBe(1);
    const poll = host.requests[1];
    expect(new URL(poll?.url ?? "").searchParams.get("waitMs")).toBe("1000");
    expect(poll?.init.timeoutMs).toBe(3_000);
  });

  it("keeps a one-shot status read instant", async () => {
    const host = hostWith(() =>
      json({
        runId: "vrun-hold",
        status: "running",
        position: null,
        result: null,
        requestedScope: "changed",
        effectiveScope: "changed",
      }),
    );

    const result = await runCli(["validate", "status", "vrun-hold"], env, host);

    expect(result.exitCode).toBe(0);
    expect(host.requests[0]?.url).not.toContain("waitMs");
    expect(host.requests[0]?.init.timeoutMs).toBeUndefined();
  });

  // A server that predates the hold parameter ignores it and answers at once;
  // the wait must fall back to its own cadence rather than spin.
  it("degrades to the established cadence against a server that ignores the hold", async () => {
    const host = neverTerminalHost();

    const result = await runCli(
      [
        "validate",
        "run",
        "test",
        "--queue-if-busy",
        "--timeout",
        "3s",
        "--json",
      ],
      env,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "wait_timeout",
      details: { runId: "vrun-slow" },
    });
    expect(host.requests).toHaveLength(4);
  });

  it("retries a hold that reached its own deadline instead of calling the server unreachable", async () => {
    let now = 1_000;
    const host = hostWith((request, index) => {
      if (index === 0) return acceptedHold();
      if (index === 1) {
        now += request.init.timeoutMs ?? 0;
        throw new Error("request aborted at its deadline");
      }
      return passedHold();
    });
    host.now = () => now;

    const result = await runCli(
      ["validate", "run", "test", "--queue-if-busy", "--timeout", "60s"],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests).toHaveLength(3);
  });

  it("still exits 3 at once when the server is unreachable before the deadline", async () => {
    const host = hostWith((_request, index) => {
      if (index === 0) return acceptedHold();
      throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
    });

    const result = await runCli(
      ["validate", "run", "test", "--queue-if-busy", "--timeout", "60s"],
      env,
      host,
    );

    expect(result.exitCode).toBe(3);
    expect(host.requests).toHaveLength(2);
    expect(result.stderr).toContain("cctl doctor");
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
