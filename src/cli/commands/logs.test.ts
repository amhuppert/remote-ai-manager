import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import { helpEntryFor } from "../help-registry";
import { STDOUT_BUDGET_BYTES } from "../disclosure";
import type { CliEnv, CliHost } from "../shared";

/**
 * `cctl logs` analyzes files on this machine, so every test runs with an EMPTY
 * environment and a fetch that throws: no identity, no server, no network.
 */
const noEnv: CliEnv = {};

const LOG_PATH = "/logs/test.log";

interface TestHost extends CliHost {
  readonly written: Map<string, string>;
}

function makeHost(files: Record<string, string>): TestHost {
  const written = new Map<string, string>();
  return {
    written,
    async fetch() {
      throw new Error("cctl logs must not touch the network");
    },
    async readTextFile(filePath) {
      return files[filePath] ?? null;
    },
    async readFileBytes() {
      return null;
    },
    async writeTextFile(filePath, content) {
      written.set(filePath, content);
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

function logLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: "2026-05-21T12:00:00.000Z",
    level: "info",
    module: "tracing",
    message: "request.complete",
    traceId: "trace-1",
    durationMs: 600,
    method: "GET",
    path: "/api/test",
    status: 200,
    ...over,
  });
}

const singleRequestLog = logLine();

/** A trace whose JSON analysis is past the stdout budget by construction. */
function fatTraceLog(): string {
  const lines = [logLine({ traceId: "trace-fat", durationMs: 9000 })];
  for (let i = 0; i < 400; i++) {
    lines.push(
      logLine({
        traceId: "trace-fat",
        module: "state-store",
        message: `operation.${i}.${"detail".repeat(30)}`,
        timestamp: `2026-05-21T12:00:0${i % 10}.000Z`,
        durationMs: 20 + i,
      }),
    );
  }
  return lines.join("\n");
}

describe("cctl logs report", () => {
  it("analyzes a local log with no identity and no network", async () => {
    const host = makeHost({ [LOG_PATH]: singleRequestLog });

    const result = await runCli(
      ["logs", "report", "--in", LOG_PATH],
      noEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("## Summary");
  });

  it("carries the analysis as a named field of the --json envelope", async () => {
    const host = makeHost({ [LOG_PATH]: singleRequestLog });

    const result = await runCli(
      ["logs", "report", "--in", LOG_PATH, "--json"],
      noEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.report.command).toBe("report");
    expect(envelope.report.summary.recordsAnalyzed).toBe(1);
  });

  it("keeps the engine's input banner on stderr so --json stdout stays parseable", async () => {
    const host = makeHost({ [LOG_PATH]: singleRequestLog });

    const result = await runCli(
      ["logs", "report", "--in", LOG_PATH, "--json"],
      noEnv,
      host,
    );

    expect(result.stderr).toContain(LOG_PATH);
    expect(result.stdout).not.toContain("[logs:analyze]");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("forwards a record filter to the engine under its own flag name", async () => {
    const host = makeHost({ [LOG_PATH]: singleRequestLog });

    const result = await runCli(
      [
        "logs",
        "report",
        "--in",
        LOG_PATH,
        "--conversation-id",
        "not-this-conversation",
      ],
      noEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no usable records");
  });

  it("rejects an undeclared flag through the registry-derived allowlist", async () => {
    const host = makeHost({ [LOG_PATH]: singleRequestLog });

    const result = await runCli(
      ["logs", "report", "--in", LOG_PATH, "--frobnicate", "x"],
      noEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown flag "--frobnicate"');
  });

  it("refuses a global identity flag that shadows a record filter", async () => {
    const host = makeHost({ [LOG_PATH]: singleRequestLog });

    const result = await runCli(
      ["logs", "report", "--in", LOG_PATH, "--session", "my-session"],
      noEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--session-name");
  });

  it("maps a malformed option to the local usage exit code", async () => {
    const host = makeHost({ [LOG_PATH]: singleRequestLog });

    const result = await runCli(
      ["logs", "report", "--in", LOG_PATH, "--since", "not-a-date"],
      noEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid --since");
  });

  it("writes the analysis to --out and prints the manifest instead of the content", async () => {
    const host = makeHost({ [LOG_PATH]: singleRequestLog });

    const result = await runCli(
      ["logs", "report", "--in", LOG_PATH, "--out", ".cc/temp/report.md"],
      noEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.written.get(".cc/temp/report.md")).toContain("## Summary");
    expect(result.stdout).not.toContain("## Summary");
    expect(result.stdout).toContain("artifact: .cc/temp/report.md");
    expect(result.stdout).toContain("format: markdown");
    expect(result.stdout).toMatch(/sha256: sha256:[a-f0-9]{64}/);
  });

  it("--out under --json writes the same serialization the envelope selected", async () => {
    const host = makeHost({ [LOG_PATH]: singleRequestLog });

    const result = await runCli(
      [
        "logs",
        "report",
        "--in",
        LOG_PATH,
        "--out",
        ".cc/temp/report.json",
        "--json",
      ],
      noEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.artifact).toMatchObject({
      path: ".cc/temp/report.json",
      reason: "requested",
      format: "json",
    });
    expect(envelope.artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(envelope.report).toBeUndefined();
    const written = host.written.get(".cc/temp/report.json");
    expect(JSON.parse(written ?? "").command).toBe("report");
  });
});

describe("cctl logs trace", () => {
  it("reports one trace's timeline", async () => {
    const host = makeHost({ [LOG_PATH]: singleRequestLog });

    const result = await runCli(
      ["logs", "trace", "trace-1", "--in", LOG_PATH, "--json"],
      noEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.report.command).toBe("trace");
    expect(envelope.report.traceId).toBe("trace-1");
  });

  it("fails as an operation failure — not a connection failure — for an absent trace", async () => {
    const host = makeHost({ [LOG_PATH]: singleRequestLog });

    const result = await runCli(
      ["logs", "trace", "missing-trace", "--in", LOG_PATH],
      noEnv,
      host,
    );

    // Exit 3 is reserved for connection/auth failures and points at `cctl
    // doctor`; a trace the log does not contain is an ordinary operation failure.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("trace not found: missing-trace");
  });

  it("requires the traceId argument", async () => {
    const host = makeHost({ [LOG_PATH]: singleRequestLog });

    const result = await runCli(
      ["logs", "trace", "--in", LOG_PATH],
      noEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("traceId");
  });

  it("spills past the stdout budget to an artifact instead of a truncated envelope", async () => {
    const host = makeHost({ [LOG_PATH]: fatTraceLog() });

    const result = await runCli(
      ["logs", "trace", "trace-fat", "--in", LOG_PATH, "--json"],
      noEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(
      STDOUT_BUDGET_BYTES,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.artifact.reason).toBe("stdout_budget_exceeded");
    expect(envelope.artifact.format).toBe("json");
    expect(envelope.report).toBeUndefined();
    const written = host.written.get(envelope.artifact.path);
    expect(written).toBeDefined();
    expect(JSON.parse(written ?? "").traceId).toBe("trace-fat");
  });
});

describe("cctl logs compare", () => {
  it("compares a before/after pair", async () => {
    const host = makeHost({
      "/logs/before.log": singleRequestLog,
      "/logs/after.log": logLine({ durationMs: 120 }),
    });

    const result = await runCli(
      [
        "logs",
        "compare",
        "--before",
        "/logs/before.log",
        "--after",
        "/logs/after.log",
        "--json",
      ],
      noEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).report.command).toBe("compare");
  });

  it("refuses without both sides", async () => {
    const host = makeHost({ "/logs/before.log": singleRequestLog });

    const result = await runCli(
      ["logs", "compare", "--before", "/logs/before.log"],
      noEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--before and --after are required");
  });
});

describe("cctl logs (dispatch and help graph)", () => {
  it("lists its verbs when none is given", async () => {
    const result = await runCli(["logs"], noEnv, makeHost({}));

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("report, trace, or compare");
  });

  it("links doctor and logs in both directions", () => {
    const logs = helpEntryFor(["logs"]);
    const doctor = helpEntryFor(["doctor"]);

    expect(logs?.related.map((ref) => ref.command)).toContain("doctor");
    expect(doctor?.related.map((ref) => ref.command)).toContain("logs");
  });
});
