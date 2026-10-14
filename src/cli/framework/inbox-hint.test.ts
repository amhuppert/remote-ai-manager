import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../testing/framework";

const ordinaryEnv = {
  CC_CONVERSATION_SCOPE: "project",
  CC_SESSION: "",
};
const summary = { pendingCount: 3, hintsEnabled: true };

function fixture(
  options: {
    summary?: unknown;
    summaryStatus?: number;
    env?: Record<string, string | undefined>;
    failSummary?: boolean;
  } = {},
) {
  return createCcRuntimeFixture({
    env: { ...ordinaryEnv, ...options.env },
    respond: ({ url }) => {
      if (url.endsWith("/inbox/summary")) {
        if (options.failSummary) throw new Error("Server unavailable");
        return jsonReply(options.summary ?? summary, options.summaryStatus);
      }
      return jsonReply({ notepads: [] });
    },
  });
}

describe("advisory inbox hint", () => {
  it.each(["text", "json"] as const)(
    "offers a bounded non-consuming summary hint in %s output",
    async (format) => {
      const test = fixture();
      const result = await test.run(["notepad", "list"], format);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(test.requests).toHaveLength(2);
      expect(test.requests[1]).toMatchObject({
        url: "http://cc.test/api/projects/project-one/conversations/conversation-one/inbox/summary",
        init: {
          method: "GET",
          timeoutMs: 300,
          headers: { "x-cc-conversation-id": "conversation-one" },
        },
      });
      const hint = format === "json" ? result.envelope?.hint : result.stdout;
      expect(hint).toContain("3 pending updates");
      expect(hint).toContain("cctl inbox list");
      expect(hint).toContain("--project=project-one");
      expect(hint).toContain("--conversation=conversation-one");
      expect(hint).not.toContain("test-token");
    },
  );

  it("retains the session identity in the summary and suggested inspection", async () => {
    const test = fixture({
      env: { CC_CONVERSATION_SCOPE: "session", CC_SESSION: "session-one" },
    });
    const result = await test.run(["notepad", "list"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[1]?.url).toBe(
      "http://cc.test/api/projects/project-one/sessions/session-one/conversations/conversation-one/inbox/summary",
    );
    expect(result.envelope?.hint).toContain("--session=session-one");
  });

  it("uses summary facts carried on the completed response without another request", async () => {
    const test = createCcRuntimeFixture({
      env: ordinaryEnv,
      respond: () => jsonReply({ notepads: [], inboxHintState: summary }),
    });
    const result = await test.run(["notepad", "list"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.envelope?.hint).toContain("3 pending updates");
    expect(test.requests).toHaveLength(1);
  });

  it.each([
    {
      name: "disabled preference",
      summary: { ...summary, hintsEnabled: false },
    },
    { name: "empty inbox", summary: { ...summary, pendingCount: 0 } },
    { name: "malformed summary", summary: { pendingCount: "3" } },
    { name: "server refusal", summaryStatus: 409 },
    { name: "connection failure", failSummary: true },
  ])("silently omits a hint for $name", async (options) => {
    const test = fixture(options);
    const result = await test.run(["notepad", "list"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.envelope?.hint).toBeUndefined();
    expect(result.envelope?.reminders).toEqual([]);
    expect(result.stderr).toBe("");
  });

  it.each([
    { name: "collaboration runtime", env: { CC_CONVERSATION: "caller-one" } },
    { name: "ambiguous scope", env: { CC_CONVERSATION_SCOPE: "" } },
    {
      name: "missing attribution",
      env: { CC_CONVERSATION_ID: "" },
      argv: ["--conversation", "conversation-one"],
    },
    { name: "different project", argv: ["--project", "other-project"] },
    {
      name: "different conversation",
      argv: ["--conversation", "other-conversation"],
    },
    { name: "different session", argv: ["--session", "other-session"] },
    { name: "different server", argv: ["--server", "http://other.test"] },
    { name: "different credential", argv: ["--token", "other-token"] },
  ])("does not inspect an inbox for $name", async (options) => {
    const test = fixture({ env: options.env });
    const result = await test.run(["notepad", "list", ...(options.argv ?? [])]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests).toHaveLength(1);
    expect(result.envelope?.hint).toBeUndefined();
  });

  it("leaves a command-specific hint in place without another request", async () => {
    const test = createCcRuntimeFixture({
      env: ordinaryEnv,
      respond: () =>
        jsonReply({
          notepads: [
            {
              id: "notepad-one",
              scope: "project",
              projectPath: "/repos/project-one",
              projectName: "project-one",
              name: "Notes",
              revision: 1,
              writeMode: "full-edit",
              pinned: false,
              archived: false,
              createdAt: "2026-09-30T01:00:00Z",
              updatedAt: "2026-09-30T01:00:00Z",
            },
          ],
        }),
    });
    const result = await test.run(["notepad", "list"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.envelope?.hint).toContain("notepad get");
    expect(test.requests).toHaveLength(1);
  });

  it("does not add a summary request to explicit inbox inspection", async () => {
    const test = createCcRuntimeFixture({
      env: ordinaryEnv,
      respond: () =>
        jsonReply({ deliveries: [], total: 0, limit: 20, offset: 0 }),
    });
    const result = await test.run(["inbox", "list"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests).toHaveLength(1);
  });

  it("keeps offline help and refused commands free of inbox reads", async () => {
    const test = fixture();
    const help = await test.run(["notepad", "list", "--help"]);
    expect(help.exitCode).toBe(0);
    const refused = await test.run(["notepad", "list", "--limit", "0"]);
    expect(refused.exitCode).toBe(2);
    expect(test.requests).toHaveLength(0);
  });
});
