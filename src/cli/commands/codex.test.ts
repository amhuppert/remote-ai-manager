import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import type { CliEnv, CliHost, FetchInit } from "../shared";
import { parseDuration } from "./codex";

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
};

interface RecordedRequest {
  url: string;
  init: FetchInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeHost(
  respond: (req: RecordedRequest) => Response,
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url, init) {
      const req = { url, init };
      requests.push(req);
      return respond(req);
    },
    async readTextFile(filePath) {
      // Any `--file` path resolves to a valid prompt payload.
      if (filePath.endsWith(".json")) {
        return JSON.stringify({ prompt: "analyze the repo" });
      }
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

const RUNS_PATH = "/api/projects/cc/sessions/my-session/codex-runs";

describe("parseDuration", () => {
  it("parses suffixed and bare durations to milliseconds", () => {
    expect(parseDuration("25m")).toBe(1_500_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1800")).toBe(1_800_000); // bare = seconds
  });

  it("rejects malformed durations", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("10x")).toBeNull();
    expect(parseDuration("-5m")).toBeNull();
  });
});

describe("cctl codex run (no --wait)", () => {
  it("creates a run and prints the runId with a poll/cancel hint", async () => {
    const host = makeHost((req) => {
      expect(req.init.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe(RUNS_PATH);
      return jsonResponse({ runId: "run-42" });
    });

    const result = await runCli(
      ["codex", "run", "--file", "prompt.json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    // The prompt file body is forwarded verbatim.
    expect(JSON.parse(host.requests[0]!.init.body ?? "{}")).toEqual({
      prompt: "analyze the repo",
    });
    expect(result.stdout).toContain("run-42");
    expect(result.stdout).toContain(
      "hint: poll with 'cctl codex status run-42'; cancel with 'cctl codex cancel run-42'",
    );
  });

  it("exits 2 without --file", async () => {
    const host = makeHost(() => jsonResponse({ runId: "x" }));
    const result = await runCli(["codex", "run"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when --timeout is given without --wait", async () => {
    const host = makeHost(() => jsonResponse({ runId: "x" }));
    const result = await runCli(
      ["codex", "run", "--file", "p.json", "--timeout", "10m"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--timeout");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on a malformed --timeout", async () => {
    const host = makeHost(() => jsonResponse({ runId: "x" }));
    const result = await runCli(
      ["codex", "run", "--file", "p.json", "--wait", "--timeout", "soon"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl codex run --wait", () => {
  it("long-polls to completion and prints the MCP result shape + docs hint", async () => {
    let gets = 0;
    const host = makeHost((req) => {
      if (req.init.method === "POST") return jsonResponse({ runId: "run-7" });
      gets++;
      if (gets < 2) return jsonResponse({ runId: "run-7", status: "running" });
      return jsonResponse({
        runId: "run-7",
        status: "succeeded",
        summary: "found two bugs",
        referenceDocuments: [
          { filePath: "memory-bank/codex/bugs.md", description: "the bugs" },
          { filePath: "memory-bank/codex/plan.md", description: "the plan" },
        ],
      });
    });

    const result = await runCli(
      ["codex", "run", "--file", "prompt.json", "--wait"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found two bugs");
    expect(result.stdout).toContain("memory-bank/codex/bugs.md");
    expect(result.stdout).toContain(
      "hint: codex registered 2 reference documents — read them before building on the summary",
    );
  });

  it("--json emits summary + referenceDocuments matching the tool shape", async () => {
    const host = makeHost((req) => {
      if (req.init.method === "POST") return jsonResponse({ runId: "run-7" });
      return jsonResponse({
        runId: "run-7",
        status: "succeeded",
        summary: "done",
        referenceDocuments: [{ filePath: "a.md", description: "d" }],
      });
    });
    const result = await runCli(
      ["codex", "run", "--file", "prompt.json", "--wait", "--json"],
      baseEnv,
      host,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.summary).toBe("done");
    expect(envelope.referenceDocuments).toEqual([
      { filePath: "a.md", description: "d" },
    ]);
    expect(envelope.hint).toContain("1 reference documents");
  });

  it("omits the docs hint when no reference documents were registered", async () => {
    const host = makeHost((req) => {
      if (req.init.method === "POST") return jsonResponse({ runId: "run-7" });
      return jsonResponse({
        runId: "run-7",
        status: "succeeded",
        summary: "nothing to file",
        referenceDocuments: [],
      });
    });
    const result = await runCli(
      ["codex", "run", "--file", "prompt.json", "--wait"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("hint:");
  });

  it("exits 1 when the run failed server-side", async () => {
    const host = makeHost((req) => {
      if (req.init.method === "POST") return jsonResponse({ runId: "run-7" });
      return jsonResponse({
        runId: "run-7",
        status: "failed",
        error: "Codex execution failed: boom",
      });
    });
    const result = await runCli(
      ["codex", "run", "--file", "prompt.json", "--wait"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  it("exits 1 with a status-recovery hint when the client budget elapses", async () => {
    const host = makeHost((req) => {
      if (req.init.method === "POST") return jsonResponse({ runId: "run-7" });
      return jsonResponse({ runId: "run-7", status: "running" });
    });
    const result = await runCli(
      ["codex", "run", "--file", "prompt.json", "--wait", "--timeout", "2s"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("continues server-side");
    expect(result.stderr).toContain("cctl codex status run-7");
  });
});

describe("cctl codex status", () => {
  it("recovers a succeeded run's full result shape (exit 0)", async () => {
    const host = makeHost((req) => {
      expect(req.init.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe(`${RUNS_PATH}/run-7`);
      return jsonResponse({
        runId: "run-7",
        status: "succeeded",
        summary: "recovered",
        referenceDocuments: [{ filePath: "a.md", description: "d" }],
      });
    });
    const result = await runCli(["codex", "status", "run-7"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("recovered");
    expect(result.stdout).toContain("1 reference documents");
  });

  it("reports a running run plainly (exit 0)", async () => {
    const host = makeHost(() =>
      jsonResponse({ runId: "run-7", status: "running" }),
    );
    const result = await runCli(["codex", "status", "run-7"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("running");
  });

  it("reports a failed run without failing the read (exit 0)", async () => {
    const host = makeHost(() =>
      jsonResponse({ runId: "run-7", status: "failed", error: "boom" }),
    );
    const result = await runCli(["codex", "status", "run-7"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("failed");
    expect(result.stdout).toContain("boom");
  });

  it("exits 2 without a runId", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["codex", "status"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on an unknown run (404)", async () => {
    const host = makeHost(() =>
      jsonResponse({ error: 'Codex run "nope" not found' }, 404),
    );
    const result = await runCli(["codex", "status", "nope"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not found");
  });
});

describe("cctl codex cancel", () => {
  it("cancels a run and exits 0 with no hint", async () => {
    const host = makeHost((req) => {
      expect(req.init.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe(`${RUNS_PATH}/run-7/cancel`);
      return jsonResponse({ ok: true, status: "running" });
    });
    const result = await runCli(["codex", "cancel", "run-7"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cancelled codex run run-7");
    expect(result.stdout).not.toContain("hint:");
  });

  it("exits 2 without a runId", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["codex", "cancel"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl codex (dispatch)", () => {
  it("exits 2 on an unknown subcommand", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["codex", "frobnicate"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 3 when the server rejects the token", async () => {
    const host = makeHost(() => jsonResponse({ error: "nope" }, 401));
    const result = await runCli(
      ["codex", "run", "--file", "prompt.json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("token");
  });
});
