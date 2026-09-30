import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { createConversationProvenanceReader } from "@/lib/conversations/provenance";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationsRepo } from "@/lib/state-store/conversations-repo";
import { createProjectConversationsRepo } from "@/lib/state-store/project-conversations-repo";
import { createSessionsRepo } from "@/lib/state-store/sessions-repo";
import { createNotepadDeliveryWatermarksRepo } from "@/lib/state-store/notepad-delivery-watermarks-repo";
import { createNotepadsRepo } from "@/lib/state-store/notepads-repo";
import { createSubscriptionSourceQueriesRepo } from "@/lib/state-store/subscription-source-queries-repo";
import { createTicketStatusChangesRepo } from "@/lib/state-store/ticket-status-changes-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  createSubscriptionInvolvementReader,
  followAcceptedNotepadContext,
} from "./involvement";
import { createSubscriptionRuntime } from "./service-factory";

const projectPath = "/repos/involvement";
const conversationId = "recipient";
let fixture: PersistenceFixture;

function discover() {
  const queue = createWriteQueue();
  return createSubscriptionInvolvementReader({
    readConversation: createConversationProvenanceReader({
      conversations: createConversationsRepo(fixture.db),
      projectConversations: createProjectConversationsRepo(fixture.db),
      sessions: createSessionsRepo(fixture.db),
    }),
    watermarks: createNotepadDeliveryWatermarksRepo(fixture.db, queue),
    notepads: createNotepadsRepo(fixture.db, queue),
    queries: createSubscriptionSourceQueriesRepo(fixture.db),
    ticketChanges: createTicketStatusChangesRepo(fixture.db),
  });
}

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(projectPath);
});
afterEach(() => fixture.close());

describe("recorded subscription involvement", () => {
  for (const scope of ["session", "project"] as const) {
    it(`uses the accepted notepad revision for ${scope} conversations, even after later edits`, async () => {
      const conversation = conversationStateSchema.parse({
        id: conversationId,
        scope,
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-09-30T10:00:00.000Z",
        lastActivityAt: "2026-09-30T10:00:00.000Z",
      });
      if (scope === "session") {
        fixture.seedSession(projectPath, "session");
        await fixture.seedConversation(projectPath, "session", conversation);
      } else await fixture.seedProjectConversation(projectPath, conversation);
      const queue = createWriteQueue();
      const pads = createNotepadsRepo(fixture.db, queue);
      await pads.create({
        id: "pad",
        revisionId: "r1",
        scope: "project",
        projectPath,
        name: "Notes",
        content: "Original",
        writeMode: "full-edit",
        authorKind: "user",
        authorConversationId: null,
        createdAt: "2026-09-30T10:00:00.000Z",
      });
      await createNotepadDeliveryWatermarksRepo(fixture.db, queue).record({
        conversationId,
        notepadId: "pad",
        revision: 1,
        openComments: { count: 0, latestCreatedAt: null },
        updatedAt: "2026-09-30T10:01:00.000Z",
      });
      await pads.writeContent({
        notepadId: "pad",
        revisionId: "r2",
        operation: "update",
        content: "Revised before sync",
        authorKind: "user",
        authorConversationId: null,
        baseRevision: null,
        enforceBaseRevision: false,
        permittedWriteModes: null,
        restoredFromRevision: null,
        writtenAt: "2026-09-30T10:02:00.000Z",
        coalesceWindowMs: null,
      });
      expect(await discover()({ projectPath, conversationId })).toMatchObject([
        { source: { kind: "notepad", id: "pad" }, initialCursor: "1" },
      ]);
      const runtime = createSubscriptionRuntime(fixture.db, createWriteQueue());
      const inbox = await runtime.service.readInbox(
        { projectPath, conversationId },
        {},
      );
      expect(inbox.items).toMatchObject([
        { fact: { revision: "2", category: "revision" } },
      ]);
      const subscription = (
        await runtime.service.list({ projectPath, conversationId })
      )[0];
      if (!subscription)
        throw new Error("Expected an automatic notepad follow");
      await runtime.service.unfollow(
        { projectPath, conversationId },
        subscription.id,
      );
      expect(
        (
          await createSubscriptionRuntime(
            fixture.db,
            createWriteQueue(),
          ).service.list({ projectPath, conversationId })
        )[0]?.status,
      ).toBe("unfollowed");
      if (scope === "session") {
        fixture.seedSession(projectPath, "session", { archived: true });
        expect(await discover()({ projectPath, conversationId })).toEqual([]);
        expect(
          (
            await runtime.service.prepareBriefing({
              recipient: { projectPath, conversationId },
              attemptId: "archived-attempt",
            })
          ).block,
        ).toBeNull();
      }
      expect(
        await discover()({ projectPath: "/repos/other", conversationId }),
      ).toEqual([]);
    });
  }

  it("keeps accepted context involvement when the notepad is deleted before the next read", async () => {
    await fixture.seedProjectConversation(
      projectPath,
      conversationStateSchema.parse({
        id: conversationId,
        scope: "project",
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-09-30T10:00:00.000Z",
        lastActivityAt: "2026-09-30T10:00:00.000Z",
      }),
    );
    const queue = createWriteQueue();
    const pads = createNotepadsRepo(fixture.db, queue);
    await pads.create({
      id: "pad",
      revisionId: "r1",
      scope: "project",
      projectPath,
      name: "Notes",
      content: "Delivered",
      writeMode: "full-edit",
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-09-30T10:00:00.000Z",
    });
    const runtime = createSubscriptionRuntime(fixture.db, queue);
    await followAcceptedNotepadContext(
      { projectPath, conversationId },
      [{ notepadId: "pad", revision: 1 }],
      runtime.service,
    );
    await pads.delete("pad");
    const restarted = createSubscriptionRuntime(fixture.db, createWriteQueue());
    const inbox = await restarted.service.readInbox(
      { projectPath, conversationId },
      {},
    );
    expect(inbox.items).toMatchObject([
      {
        source: { kind: "notepad", id: "pad" },
        fact: { eventKind: "source_missing", outcome: "missing" },
      },
    ]);
    expect(
      (await restarted.service.list({ projectPath, conversationId }))[0]
        ?.missingAt,
    ).not.toBeNull();
  });
});
