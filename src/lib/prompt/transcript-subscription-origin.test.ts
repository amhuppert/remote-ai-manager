import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createMessagesRouteHandlers } from "@/lib/conversations/messages-route-handlers";
import {
  conversationStateSchema,
  transcriptMessageSchema,
} from "@/lib/conversations/schemas";
import {
  appendTranscriptEntryOnce,
  getTranscriptPath,
  readConversationMessagesWithSeq,
  _resetTranscriptReadCacheForTesting,
} from "./transcript";
let directory: string | undefined;
let fixture: PersistenceFixture | undefined;
afterEach(async () => {
  fixture?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  _resetTranscriptReadCacheForTesting();
});
const at = "2026-09-30T12:00:00.000Z";
const payload =
  '<subscription_update>\n{"summary":"Quoted finite wait outcome"}\n</subscription_update>';
const origin = {
  source: "subscription_update",
  subscriptionUpdate: { batchId: "batch" },
} as const;
async function seed() {
  directory = await mkdtemp(path.join(tmpdir(), "cc-wake-origin-"));
  const transcriptPath = await getTranscriptPath("conversation", directory);
  await appendTranscriptEntryOnce(
    "conversation",
    {
      id: "batch",
      timestamp: at,
      type: "user",
      role: "user",
      content: [{ type: "text", text: payload }],
      origin,
    },
    directory,
  );
  return transcriptPath;
}
it("preserves an accepted wake receipt through durable JSONL normalization and the messages API", async () => {
  const transcriptPath = await seed();
  const durableBytes = await readFile(transcriptPath, "utf-8");
  fixture = createPersistenceFixture();
  fixture.seedProject("/project");
  fixture.seedSession("/project", "session");
  await fixture.seedConversation(
    "/project",
    "session",
    conversationStateSchema.parse({
      id: "conversation",
      createdAt: at,
      lastActivityAt: at,
      name: "Wake receipt",
      status: "awaiting",
      promptCount: 1,
      transcriptPath,
    }),
  );
  const handlers = createMessagesRouteHandlers({
    resolveProjectPath: async () => "/project",
    getSession: fixture.store.getSession,
    getConversation: fixture.deps.getConversation,
    readConversationMessagesWithSeq,
  });
  const response = await handlers.GET(
    new Request(
      "http://localhost/api/projects/project/sessions/session/conversations/conversation/messages",
    ),
    {
      params: Promise.resolve({
        name: "project",
        session: "session",
        conversationId: "conversation",
      }),
    },
  );
  expect(response.status).toBe(200);
  const messages = z
    .array(transcriptMessageSchema.extend({ seq: z.number().int() }))
    .parse(await response.json());
  expect(messages[0]).toMatchObject({
    id: "batch",
    origin,
    content: [{ type: "text", text: payload }],
    sourceParts: [{ seq: 0, origin, contentRange: { start: 0, end: 1 } }],
  });
  _resetTranscriptReadCacheForTesting();
  expect(
    (await readConversationMessagesWithSeq(transcriptPath))[0]?.origin,
  ).toEqual(origin);
  expect(await readFile(transcriptPath, "utf-8")).toBe(durableBytes);
  expect(durableBytes).not.toContain("contentRange");
});
it("keeps mixed-origin parts separate rather than assigning the wake origin to ordinary input", async () => {
  const transcriptPath = await seed();
  if (!directory) throw Error("Expected directory");
  await appendTranscriptEntryOnce(
    "conversation",
    {
      id: "ordinary",
      timestamp: at,
      type: "user",
      role: "user",
      content: [{ type: "text", text: "Ordinary user input" }],
    },
    directory,
  );
  const messages = await readConversationMessagesWithSeq(transcriptPath);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.origin).toBeUndefined();
  expect(messages[0]?.content).toEqual([
    { type: "text", text: payload },
    { type: "text", text: "Ordinary user input" },
  ]);
  expect(messages[0]?.sourceParts).toEqual([
    { seq: 0, origin, contentRange: { start: 0, end: 1 } },
    { seq: 1, contentRange: { start: 1, end: 2 } },
  ]);
});
