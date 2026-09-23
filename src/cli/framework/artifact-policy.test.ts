import path from "node:path";
import { expect, it } from "vitest";
import { createTestHost, runForTest } from "cli-for-agents/testing";
import { createCcRuntimeFixture } from "../testing/framework";
import { createCommandCenterCli } from "./application";
import { localArtifactPolicy } from "./artifact-policy";

it.each(["json", "text"] as const)(
  "explains a misplaced relative --out under CC's artifact policy in %s",
  async (format) => {
    const policy = await localArtifactPolicy();
    const transport = createCcRuntimeFixture({
      respond() {
        throw new Error("Local log analysis must not use HTTP");
      },
    });
    const host = createTestHost({
      files: {
        [path.join(policy.directory, ".keep")]: "",
        "/input.jsonl": JSON.stringify({
          timestamp: "2026-09-23T05:00:00Z",
          level: "info",
          module: "tracing",
          message: "request.complete",
          durationMs: 20,
          method: "GET",
          path: "/api/test",
          status: 200,
        }),
      },
    });
    const cli = createCommandCenterCli(transport.host, { artifacts: policy });
    const result = await runForTest(
      cli,
      [
        "logs",
        "report",
        "--in",
        "/input.jsonl",
        "--full",
        "--out",
        ".cc/temp/report.json",
      ],
      { host, format },
    );

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("parent directory does not exist");
    expect(output).toContain(
      path.join(policy.directory, ".cc/temp/report.json"),
    );
    expect(output).toContain("bare filename");

    const corrected = await runForTest(
      cli,
      [
        "logs",
        "report",
        "--in",
        "/input.jsonl",
        "--full",
        "--out",
        "report.json",
      ],
      { host, format: "json" },
    );
    expect(corrected.exitCode, corrected.stdout).toBe(0);
    expect(corrected.envelope).toMatchObject({
      ok: true,
      effect: "read",
      payload: {
        kind: "artifact",
        artifact: {
          path: path.join(policy.directory, "report.json"),
          contains: "data",
        },
      },
    });
  },
);
