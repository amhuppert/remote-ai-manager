import { describe, expect, it } from "vitest";
import { bytes } from "cli-for-agents";
import { createCcRuntimeFixture } from "../../testing/framework";

function line(durationMs = 600, traceId = "trace-one") {
  return JSON.stringify({
    timestamp: "2026-09-17T10:00:00Z",
    level: "info",
    module: "tracing",
    message: "request.complete",
    traceId,
    durationMs,
    method: "GET",
    path: "/api/test",
    status: 200,
  });
}
function fixture() {
  return createCcRuntimeFixture({
    respond: () => {
      throw new Error("log analysis is offline");
    },
    files: { "/logs/before": line(), "/logs/after": line(50) },
  });
}
describe("library offline log analysis", () => {
  it.each(["invalid\ntimestamp", "invalid".repeat(100)])(
    "keeps invalid timestamp prose outside the bounded diagnostic",
    async (value) => {
      const result = await fixture().run([
        "logs",
        "report",
        "--in",
        "/logs/before",
        "--since",
        value,
      ]);
      expect(result.exitCode, result.stdout).toBe(2);
      expect(result.envelope).toMatchObject({
        error: {
          code: "CC_USAGE",
          details: { input: value },
          issues: [{ path: ["flags", "since"] }],
        },
      });
    },
  );

  it("analyzes local records without resolving identity or networking", async () => {
    const test = fixture();
    const result = await test.run(["logs", "report", "--in", "/logs/before"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: {
        data: {
          report: {
            command: "report",
            summary: { recordsAnalyzed: 1, requestCount: 1 },
          },
          inputs: ["/logs/before"],
        },
      },
    });
    expect(test.requests).toHaveLength(0);
  });
  it("refuses identity flags that would silently impersonate record filters", async () => {
    const result = await fixture().run([
      "logs",
      "report",
      "--in",
      "/logs/before",
      "--session",
      "wrong-filter",
    ]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.message).toContain("--session-name");
  });
  it("returns a failed read for missing traces and validates timestamp inputs", async () => {
    const test = fixture();
    const missing = await test.run([
      "logs",
      "trace",
      "absent",
      "--in",
      "/logs/before",
    ]);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout).error.details.reason).toContain("absent");
    const invalid = await test.run([
      "logs",
      "report",
      "--in",
      "/logs/before",
      "--since",
      "nonsense",
    ]);
    expect(invalid.exitCode).toBe(2);
  });
  it("compares logs with the canonical engine and exports exact speedscope data", async () => {
    const test = fixture();
    const comparison = await test.run([
      "logs",
      "compare",
      "--before",
      "/logs/before",
      "--after",
      "/logs/after",
    ]);
    expect(comparison.exitCode, comparison.stdout).toBe(0);
    expect(JSON.parse(comparison.stdout)).toMatchObject({
      payload: { data: { report: { command: "compare" } } },
    });
    const exportResult = await test.run([
      "logs",
      "trace",
      "trace-one",
      "--in",
      "/logs/before",
      "--speedscope",
      "--out",
      "/artifacts/trace.json",
    ]);
    expect(exportResult.exitCode, exportResult.stdout).toBe(0);
    const data = await test.kernelHost.files.read(
      "/artifacts/trace.json",
      bytes(100_000),
      new AbortController().signal,
    );
    expect(JSON.parse(new TextDecoder().decode(data))).toMatchObject({
      displayTimeUnit: "ms",
      traceEvents: expect.arrayContaining([
        expect.objectContaining({ ph: "X", dur: 600_000 }),
      ]),
    });
  });
});
