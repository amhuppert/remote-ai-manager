import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBuildStamp } from "@/lib/build-info";
import { createAgentGatewayHandlers } from "@/lib/agent-gateway/route-handlers";
import { runCli, type CliEnv, type CliHost } from "./core";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real handshake
 * route handler in-process — no HTTP server, no mocks between them.
 */

const TOKEN = "contract-token";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cctl-contract-"));
  await writeFile(path.join(dir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeHost(
  handlers: ReturnType<typeof createAgentGatewayHandlers>,
): CliHost {
  return {
    fetch: (url, init) => handlers.handshakeGET(new Request(url, init)),
    async readTextFile(filePath) {
      try {
        return await readFile(filePath, "utf-8");
      } catch {
        return null;
      }
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: os.platform(),
    homedir: os.homedir(),
  };
}

function makeEnv(overrides: CliEnv = {}): CliEnv {
  return {
    CC_SERVER_URL: "http://127.0.0.1:4999",
    CC_API_TOKEN: TOKEN,
    CC_PROJECT: "cc",
    CC_SESSION: "contract-session",
    CC_CONVERSATION_ID: "conv-42",
    ...overrides,
  };
}

describe("cctl doctor against the real handshake handler", () => {
  it("handshakes green: exit 0, matching stamps, echoed identity", async () => {
    const handlers = createAgentGatewayHandlers({ configDir: dir });
    const result = await runCli(
      ["doctor", "--json"],
      makeEnv(),
      makeHost(handlers),
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.serverBuild).toBe(getBuildStamp());
    expect(envelope.cliBuild).toBe(getBuildStamp());
    expect(envelope.tokenValid).toBe(true);
    expect(envelope.identity).toEqual({
      project: "cc",
      session: "contract-session",
      conversation: "conv-42",
    });
    expect(result.stderr).toBe("");
  });

  it("exits 3 when the handler rejects a wrong token", async () => {
    const handlers = createAgentGatewayHandlers({ configDir: dir });
    const result = await runCli(
      ["doctor"],
      makeEnv({ CC_API_TOKEN: "wrong-token" }),
      makeHost(handlers),
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("token");
  });

  it("resolves the token from the config-dir file through the real fs", async () => {
    const handlers = createAgentGatewayHandlers({ configDir: dir });
    const env = makeEnv({ CC_CONFIG_DIR: dir });
    delete env["CC_API_TOKEN"];

    const result = await runCli(["doctor"], env, makeHost(handlers));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("valid (source: file)");
  });

  it("warns but succeeds when the server reports a different build stamp", async () => {
    const handlers = createAgentGatewayHandlers({
      configDir: dir,
      getServerBuildStamp: () => "stale00-2026-01-01T00:00:00.000Z",
    });
    const result = await runCli(["doctor"], makeEnv(), makeHost(handlers));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("stale00-2026-01-01T00:00:00.000Z");
  });
});
