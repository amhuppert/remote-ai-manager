import { describe, expect, it } from "vitest";
import { createTestHost, runForTest } from "cli-for-agents/testing";
import { createCommandCenterCli } from "../../framework/application";
import type { CliHost, FetchInit } from "../../transport";
const env = {
  CC_SERVER_URL: "http://cc.test",
  CC_API_TOKEN: "managing-token",
  CC_PROJECT: "cc",
  CC_SESSION: "session-one",
  CC_CONVERSATION_ID: "managing-conversation",
};
const devServer = {
  serverName: "web",
  command: "bun run dev",
  status: "running",
  port: 5010,
  remoteUrl: null,
  startedAt: "now",
  errorMessage: null,
  recentOutput: [],
  ownedByThisSession: true,
  worktreePath: "/worktree",
  ownerPid: 10,
  logFilePath: "/worktree/dev.log",
};
function fixture(respond: (url: string, init: FetchInit) => unknown) {
  const requests: Array<{ url: string; init: FetchInit }> = [];
  const host: CliHost = {
    async fetch(url, init) {
      requests.push({ url, init });
      if (init.headers["x-cc-cli-build"])
        return new Response(
          JSON.stringify({ error: "stamp mismatch", code: "build_skew" }),
          { status: 409 },
        );
      const value = url.includes("/dev-servers")
        ? { servers: [devServer] }
        : respond(url, init);
      return value instanceof Response
        ? value
        : new Response(JSON.stringify(value), {
            headers: { "content-type": "application/json" },
          });
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
  return {
    requests,
    run: (argv: string[]) =>
      runForTest(
        createCommandCenterCli(host, {
          artifacts: { directory: "/artifacts", forbiddenRoots: [] },
        }),
        ["fixture", ...argv],
        {
          host: createTestHost({ files: { "/artifacts/.keep": "" } }),
          env,
          format: "json",
        },
      ),
  };
}
describe("native fixture commands", () => {
  it.each(["scratch", "Fixture project /日本語"])(
    "creates and deletes named sessions in %s without losing recovery receipts",
    async (project) => {
      const sessionName = "Retro153 – CLI /checks";
      const reference = `${encodeURIComponent(project)}/${encodeURIComponent(sessionName)}`;
      const test = fixture((_url, init) =>
        init.method === "DELETE"
          ? { worktreeRemoved: true }
          : { sessionName, conversations: [{ id: "dev-conversation" }] },
      );
      const created = await test.run([
        "session",
        "create",
        project,
        "--name",
        sessionName,
        "--skip-warm",
      ]);
      expect(created.exitCode, created.stdout).toBe(0);
      expect(created.envelope).toMatchObject({
        effect: "applied",
        recovery: {
          references: [
            { kind: "fixture-session", id: reference },
            { kind: "conversation", id: "dev-conversation" },
          ],
        },
        payload: { data: { sessionName } },
      });
      const deleted = await test.run([
        "session",
        "delete",
        project,
        sessionName,
      ]);
      expect(deleted.exitCode, deleted.stdout).toBe(0);
      expect(deleted.envelope).toMatchObject({
        effect: "applied",
        recovery: { references: [{ kind: "fixture-session", id: reference }] },
        payload: { data: { project, sessionName, worktreeRemoved: true } },
      });
      expect(
        test.requests.filter(
          ({ init }) => init.method === "POST" || init.method === "DELETE",
        ),
      ).toHaveLength(2);
    },
  );

  it("retains a named project's recovery identity after creation loses acknowledgement", async () => {
    const project = "Fixture project /日本語";
    const test = fixture(() => {
      throw new Error("ECONNRESET");
    });
    const result = await test.run([
      "session",
      "create",
      project,
      "--name",
      "Retro153 – CLI checks",
      "--skip-warm",
    ]);
    expect(result.exitCode, result.stdout).toBe(3);
    expect(result.envelope).toMatchObject({
      effect: "unknown",
      recovery: {
        references: [{ kind: "project", id: encodeURIComponent(project) }],
      },
      error: { code: "CC_CONNECTION" },
    });
    expect(test.requests.at(-1)?.init.method).toBe("POST");
  });

  it("creates a session only on the discovered dev instance across build skew", async () => {
    const test = fixture(() => ({
      sessionName: "fx-test",
      conversations: [{ id: "dev-conversation" }],
    }));
    const result = await test.run([
      "session",
      "create",
      "scratch",
      "--name",
      "fx-test",
      "--skip-warm",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests).toHaveLength(2);
    expect(test.requests[1]?.url).toBe(
      "http://localhost:5010/api/projects/scratch/sessions",
    );
    expect(test.requests[1]?.init.headers.authorization).toBeUndefined();
    expect(JSON.parse(test.requests[1]?.init.body ?? "null")).toEqual({
      mode: "normal",
      sessionName: "fx-test",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: {
        data: {
          conversationId: "dev-conversation",
          target: "http://localhost:5010",
          transcriptPath:
            "/worktree/.config/transcripts/dev-conversation.jsonl",
        },
      },
    });
  });
  it("refuses the managing instance before any mutation", async () => {
    const test = fixture(() => ({}));
    expect(
      (
        await test.run([
          "session",
          "create",
          "scratch",
          "--target",
          "http://cc.test/",
        ])
      ).exitCode,
    ).toBe(2);
    expect(test.requests).toHaveLength(0);
  });
  it.each(["fx-test", "Retro153 – CLI /checks"])(
    "deletes %s and preserves the worktree removal receipt",
    async (sessionName) => {
      const test = fixture(() => ({ worktreeRemoved: true }));
      const result = await test.run([
        "session",
        "delete",
        "scratch",
        sessionName,
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(test.requests[1]?.url).toBe(
        `http://localhost:5010/api/projects/scratch/sessions?sessionName=${encodeURIComponent(sessionName)}`,
      );
      expect(test.requests[1]?.init.method).toBe("DELETE");
      expect(JSON.parse(result.stdout)).toMatchObject({
        payload: { data: { worktreeRemoved: true } },
      });
    },
  );
  it("selects the target conversation and completes its prompt from SSE", async () => {
    const text = "Preserve `ticks` and $HOME\n";
    const test = fixture((_url, init) =>
      init.method === "POST"
        ? new Response("event: done\ndata: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          })
        : [{ id: "dev-conversation", name: "Fixture", status: "new" }],
    );
    const result = await test.run([
      "prompt",
      "scratch",
      "fx-test",
      "--text",
      text,
      "--wait",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[2]?.url).toContain("/dev-conversation/prompt");
    expect(test.requests[2]?.url).not.toContain("managing-conversation");
    expect(JSON.parse(test.requests[2]?.init.body ?? "null")).toEqual({
      prompt: text,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: {
        data: { conversationId: "dev-conversation", turn: "completed" },
      },
    });
  });
  it("keeps accepted failed-turn forensic paths instead of claiming no write", async () => {
    const test = fixture(
      () =>
        new Response("event: error\ndata: rejected by backend\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const result = await test.run([
      "prompt",
      "scratch",
      "fx-test",
      "--conversation",
      "dev-conversation",
      "--text",
      "go",
      "--wait",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      error: {
        details: {
          transcriptPath:
            "/worktree/.config/transcripts/dev-conversation.jsonl",
        },
      },
    });
  });
  it("reports target conversation status and rejects malformed responses", async () => {
    const test = fixture(() => [
      { id: "dev-conversation", name: "Fixture", status: "idle" },
    ]);
    const result = await test.run(["status", "scratch", "fx-test"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: {
        data: { conversations: [{ id: "dev-conversation", status: "idle" }] },
      },
    });
    const malformed = fixture(() => ({ wrong: [] }));
    expect(
      (await malformed.run(["status", "scratch", "fx-test"])).exitCode,
    ).toBe(1);
  });
});
