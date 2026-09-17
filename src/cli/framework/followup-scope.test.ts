import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../testing/framework";
import { sampleDetail as ticket } from "../commands/ticket/native-fixtures";

const notepad = {
  id: "7bf494c1-1c94-48c7-8205-ed83e070859b",
  scope: "project",
  projectPath: "/repo",
  name: "Notes",
  content: "Body",
  revision: 1,
  writeMode: "full-edit",
  pinned: false,
  archived: false,
  createdAt: "2026-09-17",
  updatedAt: "2026-09-17",
};
const server = {
  serverName: "web",
  command: "bun run dev",
  status: "running",
  port: 5010,
  remoteUrl: null,
  startedAt: "2026-09-17T10:00:00Z",
  errorMessage: null,
  recentOutput: [],
  ownedByThisSession: true,
  worktreePath: "/worktree",
  ownerPid: 10,
  logFilePath: "/worktree/dev.log",
};
const explicit = [
  "--server",
  "http://explicit.test",
  "--project",
  "explicit-project",
  "--session",
  "explicit-session",
  "--conversation",
  "explicit-conversation",
  "--token",
  "private-explicit-token",
];

describe("data-family follow-up target routing", () => {
  it.each([
    {
      argv: ["notepad", "create", "--name", "Notes"],
      response: { notepad },
      status: 200,
    },
    {
      argv: ["memory", "get", "missing"],
      response: { code: "not_found", error: "Missing note" },
      status: 404,
    },
    {
      argv: ["ticket", "create", "--title", "Ticket", "--type", "bug"],
      response: { ticket, warnings: [] },
      status: 200,
    },
    { argv: ["dev", "ensure", "web"], response: null, status: 200 },
  ])(
    "retains explicit routing in $argv follow-ups without exposing credentials",
    async ({ argv, response, status }) => {
      const fixture = createCcRuntimeFixture({
        respond: ({ init }) =>
          jsonReply(
            response ??
              (init.method === "POST"
                ? { status: "accepted", server }
                : { servers: [server] }),
            status,
          ),
      });
      const result = await fixture.run([...argv, ...explicit]);
      const envelope = JSON.parse(result.stdout);
      const followup =
        argv[0] === "ticket"
          ? envelope.payload?.data.ticket.getCommand
          : envelope.hint;
      expect(followup, result.stdout).toContain(
        "--server=http://explicit.test",
      );
      expect(followup).toContain("--project=explicit-project");
      expect(followup).toContain("--session=explicit-session");
      expect(followup).toContain("--conversation=explicit-conversation");
      expect(followup).not.toContain("private-explicit-token");
    },
  );
});
