import { expect, it } from "vitest";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createTicketsRepo } from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createTicketContentStore } from "./content-store";
import { captureTicketBundle } from "./bundle-capture";
import { bundleFixture } from "./bundle.fixtures";

it("captures whole transcripts and linked files, and reports missing snapshots without following prose paths", async () => {
  const db = _createTestDb({ inMemory: true });
  const repo = createTicketsRepo(db, createWriteQueue());
  const source = bundleFixture();
  try {
    await repo.createWithAttachments(source.ticket, [
      {
        id: "a",
        ticketId: source.ticket.id,
        description: "Research",
        createdAt: "2026-09-04",
        updatedAt: "2026-09-04",
        payload: {
          kind: "conversation",
          projectPath: "/old/repo",
          sessionName: null,
          conversationId: "conversation",
          snapshotKey: null,
          snapshotCapturedAt: null,
          snapshotStatus: "pending",
        },
      },
    ]);
    const transcript =
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "preserve this" },
            { type: "text", text: "/do/not/copy.txt" },
            { type: "image_ref", imagePath: "/old/image.png" },
          ],
        },
      }) + "\n";
    const files = new Map([
      ["/old/transcript.jsonl", Buffer.from(transcript)],
      ["/old/image.png", Buffer.from([0, 1, 255])],
      ["/old/design.md", Buffer.from("design")],
    ]);
    const bundle = await captureTicketBundle(
      {
        repo,
        contentStore: createTicketContentStore({
          contentRoot: ".cc/temp/unused-bundle-store",
          listTicketIdsForProject: repo.listTicketIds,
        }),
        async readFile(filePath) {
          const bytes = files.get(filePath);
          if (!bytes) throw new Error(`Unexpected file ${filePath}`);
          return bytes;
        },
        async getSession() {
          return null;
        },
        async getConversation() {
          return { transcriptPath: "/old/transcript.jsonl" };
        },
        async getContext() {
          return [
            {
              source: "/old/design.md",
              checkoutRoot: "/old/repo/.worktrees/discussion",
              fileName: "design.md",
              description: "Registered design",
              filePath: "/old/design.md",
            },
          ];
        },
      },
      "/old/repo",
      1,
    );
    expect(bundle.documents.map((d) => d.source)).toContain(
      "conversation:conversation",
    );
    expect(bundle.documents.map((d) => d.source)).toContain("/old/image.png");
    expect(bundle.documents.map((d) => d.source)).toContain("/old/design.md");
    expect(bundle.roots).toContain("/old/repo/.worktrees/discussion");
    expect(bundle.documents.map((d) => d.source)).not.toContain(
      "/do/not/copy.txt",
    );
    expect(bundle.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "attachment:a" }),
      ]),
    );
    expect(
      Buffer.from(
        bundle.documents.find((d) => d.source === "conversation:conversation")
          ?.content ?? "",
        "base64",
      ).toString(),
    ).toBe(transcript);
  } finally {
    db.close();
  }
});
