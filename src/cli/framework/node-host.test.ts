import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runCli } from "cli-for-agents/runtime";
import { createTestHost } from "cli-for-agents/testing";
import { createCommandCenterCli } from "./application";
import { createNodeCliHost } from "./node-host";

it("cancels owned validation over the real transport after its invocation is interrupted", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "cc-cancel-test-"));
  const controller = new AbortController();
  const requests: Array<{
    path: string;
    lease: string | string[] | undefined;
  }> = [];
  const server = createServer((request, response) => {
    requests.push({
      path: request.url ?? "",
      lease: request.headers["x-cc-validation-lease-token"],
    });
    if (request.url?.endsWith("/cancel")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cancelled: true }));
    } else if (request.method === "POST") {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          kind: "accepted",
          runId: "owned-run",
          status: "running",
          position: null,
          requestedScope: "changed",
          effectiveScope: "changed",
          lease: {
            runId: "owned-run",
            token: "private-lease",
            expiresAt: "2026-09-18T00:00:00Z",
          },
        }),
      );
    } else controller.abort();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw Error("Missing address");
  try {
    const env = {
      CC_SERVER_URL: `http://127.0.0.1:${address.port}`,
      CC_API_TOKEN: "test-token",
      CC_PROJECT: "project",
      CC_SESSION: "session",
      CC_CONVERSATION_ID: "conversation",
      CC_CONFIG_DIR: configDir,
    };
    const cli = createCommandCenterCli(
      async (env, signal) => createNodeCliHost(env, signal),
      { artifacts: { directory: "/artifacts", forbiddenRoots: [] } },
    );
    const result = await runCli(cli, {
      argv: ["validate", "run", "test", "--json"],
      env,
      signal: controller.signal,
      host: createTestHost({ files: { "/artifacts/.keep": "" } }),
    });
    expect(requests.at(-1)).toEqual({
      path: "/api/projects/project/sessions/session/conversations/conversation/validation/owned-run/cancel",
      lease: "private-lease",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: { references: [{ kind: "validation-run", id: "owned-run" }] },
      error: { code: "CC_OPERATION_FAILED" },
    });
    expect(result.stdout).not.toContain("private-lease");
    expect(await readdir(configDir)).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(configDir, { recursive: true, force: true });
  }
});

it("keeps ordinary requests aborted and bounds an explicitly authorized cleanup request", async () => {
  const controller = new AbortController();
  controller.abort();
  const paths: string[] = [];
  const server = createServer((request) => {
    paths.push(request.url ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw Error("Missing address");
  const host = createNodeCliHost({}, controller.signal);
  try {
    const url = `http://127.0.0.1:${address.port}`;
    await expect(
      host.fetch(`${url}/ordinary`, { method: "GET", headers: {} }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      host.fetch(`${url}/cleanup`, {
        method: "POST",
        headers: {},
        cleanupTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(paths).toEqual(["/cleanup"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
