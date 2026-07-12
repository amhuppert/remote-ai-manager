import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import { createSessionNotificationHandlers } from "@/lib/push-notification/session-notification-route-handlers";
import type { AgentNotificationOutcome } from "@/lib/push-notification/dispatcher";
import { runCli } from "../core";
import type { CliEnv, CliHost } from "../shared";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real session
 * notification route handler in-process. Only the leaf dispatch is a
 * controllable double; the token gate, project/session resolution, and Zod
 * validation are the production code paths.
 */

const TOKEN = "contract-token";
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cctl-notify-"));
  await writeFile(path.join(dir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeHost(
  handlers: ReturnType<typeof createSessionNotificationHandlers>,
): CliHost {
  return {
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      // /api/projects/<name>/sessions/<session>/notifications
      const name = decodeURIComponent(segments[2] ?? "");
      const session = decodeURIComponent(segments[4] ?? "");
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      return handlers.POST(request, {
        params: Promise.resolve({ name, session }),
      });
    },
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
    CC_SESSION: "sess",
    ...overrides,
  };
}

function makeHandlers(
  dispatch: (...args: unknown[]) => Promise<AgentNotificationOutcome>,
): ReturnType<typeof createSessionNotificationHandlers> {
  return createSessionNotificationHandlers({
    auth: createAgentAuth({ configDir: dir }),
    async resolveProjectPath() {
      return "/repos/cc";
    },
    async getSession() {
      return { sessionName: "sess" };
    },
    dispatchAgentNotification: dispatch,
  });
}

describe("cctl notify against the real notification handler", () => {
  it("dispatches a push and exits 0 with the right identity + title", async () => {
    const dispatch = vi.fn(
      async (): Promise<AgentNotificationOutcome> => ({ delivered: true }),
    );
    const result = await runCli(
      ["notify", "Build done", "--title", "Heads up"],
      makeEnv(),
      makeHost(makeHandlers(dispatch)),
    );

    expect(result.exitCode).toBe(0);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: "cc",
        sessionName: "sess",
        title: "Heads up",
        message: "Build done",
      }),
    );
  });

  it("exits 1 when the handler reports push is unconfigured (409)", async () => {
    const result = await runCli(
      ["notify", "hi"],
      makeEnv(),
      makeHost(
        makeHandlers(async () => ({
          delivered: false,
          reason: "Push notifications are not configured",
        })),
      ),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Push notifications are not configured");
  });

  it("exits 3 when the real token gate rejects a wrong token", async () => {
    const result = await runCli(
      ["notify", "hi"],
      makeEnv({ CC_API_TOKEN: "wrong" }),
      makeHost(makeHandlers(async () => ({ delivered: true }))),
    );

    expect(result.exitCode).toBe(3);
  });
});
