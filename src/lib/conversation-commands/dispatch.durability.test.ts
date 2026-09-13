import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { createMessagesRouteHandlers } from "@/lib/conversations/messages-route-handlers";
import {
  appendTranscriptEntry,
  getTranscriptPath,
  readConversationMessagesWithSeq,
} from "@/lib/prompt/transcript";
import { dispatchConversationCommand } from "./dispatch";

let fixture: PersistenceFixture;
let directory: string;
const projectPath = "/command-delivery";
const sessionName = "fresh";
const conversationId = "fresh-command";
const reviewUrl =
  "/specs/command-delivery/spec?el=delivery&execution=delivery&mergeSession=fresh";

beforeEach(async () => {
  directory = await mkdtemp(join(process.cwd(), ".cc-test-command-"));
  fixture = createPersistenceFixture();
  fixture.seedProject(projectPath);
  fixture.seedSession(projectPath, sessionName);
  await fixture.seedConversation(
    projectPath,
    sessionName,
    conversationStateSchema.parse({
      id: conversationId,
      transcriptPath: null,
      status: "new",
      promptCount: 0,
      createdAt: "2026-09-12T12:00:00Z",
      lastActivityAt: "2026-09-12T12:00:00Z",
    }),
  );
});
afterEach(async () => {
  fixture.close();
  await rm(directory, { recursive: true, force: true });
});

it("keeps the delivery review notice readable after a command-only conversation refetch", async () => {
  await dispatchConversationCommand(
    {
      projectPath,
      projectName: "command-delivery",
      sessionName,
      conversationId,
      parsed: { command: "merge", hint: "" },
      rawText: "/merge",
    },
    {
      getTranscriptPath: (id) => getTranscriptPath(id, directory),
      mutateConversation: fixture.deps.mutateConversation,
      appendEntry: (id, entry) => appendTranscriptEntry(id, entry, directory),
      async run() {
        await appendTranscriptEntry(
          conversationId,
          {
            timestamp: "2026-09-12T12:00:01Z",
            type: "notice",
            role: "notice",
            content: [
              {
                type: "text",
                text: `Approve delivery before merging. [Review delivery](${reviewUrl}).`,
              },
            ],
          },
          directory,
        );
        return { status: "rejected", reason: "workflow-active" };
      },
    },
  );
  const restarted = fixture.recreateStore();
  const handlers = createMessagesRouteHandlers({
    resolveProjectPath: async () => projectPath,
    getSession: restarted.getSession,
    getConversation: restarted.getConversation,
    readConversationMessagesWithSeq,
  });
  const response = await handlers.GET(
    new Request("http://localhost/messages"),
    {
      params: Promise.resolve({
        name: "command-delivery",
        session: sessionName,
        conversationId,
      }),
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "notice",
        content: [
          {
            type: "text",
            text: `Approve delivery before merging. [Review delivery](${reviewUrl}).`,
          },
        ],
      }),
    ]),
  );
});
