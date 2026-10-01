import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createNotepadsRepo } from "@/lib/state-store/notepads-repo";
import { createNotepadCommentsRepo } from "@/lib/state-store/notepad-comments-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createNotepadDeliveryWatermarksRepo } from "@/lib/state-store/notepad-delivery-watermarks-repo";
import { createSubscriptionService } from "./service";
import {
  createNotepadSourceReader,
  notepadInvolvementCursor,
  isNotepadFactCovered,
} from "./notepad-source";

const projectPath = "/repos/notepad-inbox";
const recipient = { projectPath, conversationId: "recipient" };
const source = { kind: "notepad", id: "pad" } as const;
let fixture: PersistenceFixture;
const emptyMarker = { count: 0, latestCreatedAt: null };
function stores() {
  const queue = createWriteQueue();
  return {
    notepads: createNotepadsRepo(fixture.db, queue),
    comments: createNotepadCommentsRepo(fixture.db, queue),
  };
}
async function addComment(id: string, createdAt = "2026-10-01T10:01:00Z") {
  return stores().comments.create({
    id,
    notepadId: "pad",
    body: `Review ${id}`,
    authorKind: "user",
    authorConversationId: null,
    createdAt,
    anchor: {
      sectionId: "preamble",
      headingLabel: "",
      line: 1,
      charStart: 0,
      charEnd: 4,
      quote: "Body",
      prefix: "",
      suffix: "",
      notepadRevision: 1,
    },
  });
}
beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject(projectPath);
  await stores().notepads.create({
    id: "pad",
    revisionId: "r1",
    scope: "project",
    projectPath,
    name: "Review notes",
    content: "Body",
    writeMode: "full-edit",
    authorKind: "user",
    authorConversationId: null,
    createdAt: "2026-10-01T10:00:00Z",
  });
});
afterEach(() => fixture.close());

describe("notepad inbox source", () => {
  it("records canonical comment additions once through a restarted reader", async () => {
    const baseline = await createNotepadSourceReader(stores())(
      recipient,
      source,
      null,
    );
    await addComment("comment-new");
    const first = await createNotepadSourceReader(stores())(
      recipient,
      source,
      baseline.cursor,
    );
    expect(first.facts).toMatchObject([
      {
        occurrenceId: "notepad-comment:comment-new",
        eventKind: "notepad-comment-added",
        category: "activity",
        retrievalHandle: "cctl notepad comment list --open -- 'pad'",
      },
    ]);
    expect(first.facts[0]?.sourceText).toContain("Review comment-new");
    expect(
      (
        await createNotepadSourceReader(stores())(
          recipient,
          source,
          first.cursor,
        )
      ).facts,
    ).toEqual([]);
  });
  it("keeps exact accepted IDs across equal timestamps and balanced deletion", async () => {
    await addComment("old");
    const context = {
      notepadId: "pad",
      revision: 1,
      openComments: { count: 1, latestCreatedAt: "2026-10-01T10:01:00Z" },
      commentIds: ["old"],
    };
    await stores().comments.delete("old");
    await addComment("new");
    const changed = await createNotepadSourceReader(stores())(
      recipient,
      source,
      notepadInvolvementCursor(context),
    );
    expect(changed.facts.map((fact) => fact.occurrenceId)).toEqual([
      "notepad-comment:new",
    ]);
    const fact = changed.facts[0];
    if (!fact) throw new Error("Expected a durable comment addition");
    expect(isNotepadFactCovered(fact, context)).toBe(false);
    expect(
      isNotepadFactCovered(fact, { ...context, commentIds: ["old", "new"] }),
    ).toBe(true);
  });
  it("does not manufacture feedback from resolution, deletion, replies or reopening", async () => {
    await addComment("comment");
    const read = createNotepadSourceReader(stores());
    const baseline = await read(recipient, source, null);
    await stores().comments.updateStatus({
      commentId: "comment",
      status: "resolved",
      updatedAt: "2026-10-01T10:02:00Z",
    });
    const resolved = await read(recipient, source, baseline.cursor);
    expect(resolved.facts).toEqual([]);
    await stores().comments.addReply({
      id: "reply",
      commentId: "comment",
      body: "Reply",
      authorKind: "agent",
      authorConversationId: "recipient",
      createdAt: "2026-10-01T10:03:00Z",
    });
    await stores().comments.updateStatus({
      commentId: "comment",
      status: "open",
      updatedAt: "2026-10-01T10:04:00Z",
    });
    const reopened = await read(recipient, source, resolved.cursor);
    expect(reopened.facts).toEqual([]);
    await stores().comments.delete("comment");
    expect((await read(recipient, source, reopened.cursor)).facts).toEqual([]);
  });
  it("baselines legacy markers without treating resolved older comments as new", async () => {
    await addComment("older", "2026-10-01T09:00:00Z");
    await stores().comments.updateStatus({
      commentId: "older",
      status: "resolved",
      updatedAt: "2026-10-01T09:01:00Z",
    });
    await addComment("newer");
    const changed = await createNotepadSourceReader(stores())(
      recipient,
      source,
      notepadInvolvementCursor({
        notepadId: "pad",
        revision: 1,
        openComments: emptyMarker,
      }),
    );
    expect(changed.facts.map((fact) => fact.occurrenceId)).toEqual([
      "notepad-comment:newer",
    ]);
  });
  it("delivers bounded metadata for a delimiter-heavy title while retaining complete evidence", async () => {
    const name = "<".repeat(3000);
    await stores().notepads.updateOrganization({
      notepadId: "pad",
      name,
      updatedAt: "2026-10-01T10:01:00Z",
    });
    const service = createSubscriptionService({
      repo: createConversationSubscriptionsRepo(fixture.db, createWriteQueue()),
      readSource: createNotepadSourceReader(stores()),
      isRecipientEligible: async () => true,
    });
    await service.autoFollow({
      recipient,
      source,
      reason: "Accepted source context",
    });
    await addComment("bounded-comment");
    const briefing = await service.prepareBriefing({
      recipient,
      attemptId: "bounded",
    });
    expect(briefing.block).toContain("notepad-comment-added");
    const stored = (await service.readInbox(recipient, {})).items[0];
    expect(stored?.fact.sourceText).toContain(name);
    expect(stored?.fact.sourceText).toContain("Review bounded-comment");
    await briefing.finish({ disposition: "not_sent" });
  });
  it("supersedes earlier ingested changes covered by a later accepted reference without forging delivery acceptance", async () => {
    const queue = createWriteQueue();
    const watermarks = createNotepadDeliveryWatermarksRepo(fixture.db, queue);
    const service = createSubscriptionService({
      repo: createConversationSubscriptionsRepo(fixture.db, queue),
      readSource: createNotepadSourceReader({ ...stores(), watermarks }),
      isRecipientEligible: async () => true,
    });
    await service.autoFollow({
      recipient,
      source,
      reason: "Accepted reference",
      initialCursor: notepadInvolvementCursor({
        notepadId: "pad",
        revision: 1,
        openComments: emptyMarker,
        commentIds: [],
      }),
    });
    const write = (revision: number) =>
      stores().notepads.writeContent({
        notepadId: "pad",
        revisionId: `r${revision}`,
        operation: "update",
        content: `Version ${revision}`,
        authorKind: "user",
        authorConversationId: null,
        baseRevision: null,
        enforceBaseRevision: false,
        permittedWriteModes: null,
        restoredFromRevision: null,
        writtenAt: `2026-10-01T10:00:0${revision}Z`,
        coalesceWindowMs: 10000,
      });
    await write(2);
    await addComment("shown");
    expect((await service.readInbox(recipient, {})).items).toHaveLength(2);
    await write(3);
    await watermarks.record({
      conversationId: recipient.conversationId,
      notepadId: "pad",
      revision: 3,
      openComments: { count: 1, latestCreatedAt: "2026-10-01T10:01:00Z" },
      commentIds: ["shown"],
      updatedAt: "2026-10-01T10:02:00Z",
    });
    await addComment("after-reference", "2026-10-01T10:03:00Z");
    expect(
      (await service.readInbox(recipient, {})).items.map(
        (delivery) => delivery.fact.occurrenceId,
      ),
    ).toEqual(["notepad-comment:after-reference"]);
    const old = (
      await service.readInbox(recipient, { includeSettled: true })
    ).items.filter(
      (delivery) =>
        delivery.fact.occurrenceId !== "notepad-comment:after-reference",
    );
    expect(old).toHaveLength(2);
    expect(
      old.every(
        (delivery) =>
          delivery.state === "superseded" && delivery.acceptedAt === null,
      ),
    ).toBe(true);
  });
});
