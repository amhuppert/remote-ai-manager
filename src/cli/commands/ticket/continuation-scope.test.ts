import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { conversationReadCommands } from "@/lib/tickets/attachment-commands";
import { resolvedAttachmentSchema } from "@/lib/tickets/schemas";
import { encodeTicketKeysetCursor } from "@/lib/tickets/ticket-keyset-cursor";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";
import { ticketGetProjectionSchema } from "./disclosure";
import {
  sampleDetail,
  sampleRelationship,
  sampleStatusUpdate,
} from "./native-fixtures";

const execFileAsync = promisify(execFile);
const explicitServer = "http://selected.test";
const attachment = {
  id: "attachment-1",
  ticketId: sampleDetail.id,
  description: "Evidence",
  payload: { kind: "note", markdown: "Evidence bytes" },
  createdAt: sampleDetail.createdAt,
  updatedAt: sampleDetail.updatedAt,
};
const detail = {
  ...sampleDetail,
  attachments: [attachment],
  relationships: Array.from({ length: 21 }, (_, index) => ({
    ...sampleRelationship,
    id: `relation-${index}`,
  })),
  statusUpdates: { total: 12, recent: [sampleStatusUpdate] },
};
const cursor = encodeTicketKeysetCursor({
  timestamp: sampleRelationship.updatedAt,
  id: sampleRelationship.id,
});

/** Execute the returned shell syntax; the stub captures argv without invoking PATH cctl. */
async function commandArgs(command: string): Promise<string[]> {
  const result = await execFileAsync("/bin/sh", [
    "-c",
    `cctl() { printf '%s\\0' "$@"; }\n${command}`,
  ]);
  return result.stdout.split("\0").slice(0, -1);
}
function dataOf(stdout: string) {
  return z
    .object({
      payload: z.object({
        kind: z.literal("inline"),
        data: z.record(z.string(), z.unknown()),
      }),
    })
    .parse(JSON.parse(stdout)).payload.data;
}

function fixture() {
  return createCcRuntimeFixture({
    respond: ({ url }) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/attachments/attachment-1"))
        return jsonReply({
          kind: "note",
          attachment,
          markdown: "Evidence bytes",
        });
      if (path.endsWith("/relationships"))
        return jsonReply({
          items: [sampleRelationship],
          total: 2,
          nextCursor: cursor,
        });
      if (path.includes("/relationships/"))
        return jsonReply(sampleRelationship);
      if (path.endsWith("/status-updates"))
        return jsonReply({
          items: [sampleStatusUpdate],
          total: 2,
          nextCursor: cursor,
        });
      if (path.includes("/status-updates/"))
        return jsonReply(sampleStatusUpdate);
      return jsonReply(detail);
    },
  });
}

async function executeFollowup(
  test: ReturnType<typeof fixture>,
  command: string,
) {
  const count = test.requests.length;
  const result = await test.run(await commandArgs(command));
  expect(result.exitCode, result.stdout).toBe(0);
  expect(test.requests.length).toBeGreaterThan(count);
  for (const request of test.requests.slice(count))
    expect(new URL(request.url).origin, command).toBe(explicitServer);
}

describe("ticket nested disclosure keeps the selected server", () => {
  it("executes attachment, relationship, and status retrieval plus omitted-outline pages on that server", async () => {
    const test = fixture();
    const result = await test.run([
      "ticket",
      "get",
      "cc#12",
      "--server",
      explicitServer,
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const data = dataOf(result.stdout);
    const view = ticketGetProjectionSchema.parse({
      ticket: data.ticket,
      attachmentIndex: data.attachmentIndex,
    });
    const relation = view.ticket.relationships.items[0];
    const update = view.ticket.statusUpdates.items[0];
    if (
      !relation ||
      !update ||
      !view.ticket.relationships.truncated ||
      !view.ticket.statusUpdates.truncated
    )
      throw Error("Fixture must expose nested continuations");
    const commands = [
      ...view.attachmentIndex.flatMap((item) => item.commands),
      relation.getCommand,
      update.getCommand,
      view.ticket.relationships.next.command,
      view.ticket.statusUpdates.next.command,
    ];
    for (const command of commands) await executeFollowup(test, command);
  });

  it.each(["relation", "status-update"])(
    "keeps %s item retrieval and next-cursor pages on the selected server",
    async (family) => {
      const test = fixture();
      const result = await test.run([
        "ticket",
        family,
        "list",
        "cc#12",
        "--limit",
        "1",
        "--server",
        explicitServer,
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      const data = dataOf(result.stdout);
      const rows = z
        .array(z.object({ getCommand: z.string() }))
        .parse(data[family === "relation" ? "relationships" : "updates"]);
      const next = z.string().parse(data.revealCommand);
      const first = rows[0];
      if (!first) throw Error("Missing nested outline");
      await executeFollowup(test, first.getCommand);
      await executeFollowup(test, next);
      expect(
        new URL(test.requests.at(-1)?.url ?? "").searchParams.get("cursor"),
      ).toBe(cursor);
    },
  );
});

describe("resolved attachment continuation scope", () => {
  it.each(["conversation", "session"] as const)(
    "keeps %s source coordinates while selecting the requested server",
    async (kind) => {
      const conversationId = "source-conversation";
      const sourceScope = {
        projectName: "source-project",
        sessionName: "source-session",
      };
      const readCommands = conversationReadCommands(
        conversationId,
        sourceScope,
      );
      const payload =
        kind === "conversation"
          ? {
              kind,
              projectPath: "/repos/source-project",
              sessionName: sourceScope.sessionName,
              conversationId,
              snapshotKey: "snapshot-1",
              snapshotCapturedAt: sampleDetail.updatedAt,
            }
          : {
              kind,
              projectPath: "/repos/source-project",
              sessionName: sourceScope.sessionName,
            };
      const resolved =
        kind === "conversation"
          ? {
              kind,
              attachment: { ...attachment, payload },
              conversationId,
              sessionName: sourceScope.sessionName,
              source: "live_compaction",
              sourceAvailable: true,
              markdown: "Captured context",
              capturedAt: sampleDetail.updatedAt,
              readCommands,
            }
          : {
              kind,
              attachment: { ...attachment, payload },
              ...sourceScope,
              finished: false,
              conversationIds: [conversationId],
              readCommands,
            };
      const test = createCcRuntimeFixture({
        respond: ({ url }) => {
          if (url.endsWith("/attachments/attachment-1"))
            return jsonReply(resolved);
          if (url.includes("/context-artifacts")) return jsonReply([]);
          if (url.includes("/conversations/"))
            return jsonReply({
              conversationId,
              totalMessages: 0,
              maxSeq: 0,
              units: [],
              truncated: false,
              boundaries: {
                entries: [],
                totalInRange: 0,
                nextBefore: null,
                indexCommand: null,
              },
              truncation: {
                omittedAfter: null,
                partialEntry: null,
                excerptedEntries: [],
                excerptedEntriesOmitted: 0,
                excerptedEntriesNext: null,
              },
              omissions: {
                thinkingOmitted: 0,
                toolResultBytesElided: 0,
                unitsOutsideWindow: 0,
              },
            });
          return jsonReply(sampleDetail);
        },
      });
      const result = await test.run([
        "ticket",
        "attachment",
        "get",
        "cc#12",
        "attachment-1",
        "--server",
        explicitServer,
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      const resultAttachment = resolvedAttachmentSchema.parse(
        dataOf(result.stdout).attachment,
      );
      if (!("readCommands" in resultAttachment))
        throw Error("Missing attachment read commands");
      const outline = resultAttachment.readCommands[1];
      if (!outline) throw Error("Missing conversation outline command");
      await executeFollowup(test, outline);
      expect(new URL(test.requests.at(-1)?.url ?? "").pathname).toContain(
        "/projects/source-project/sessions/source-session/conversations/source-conversation/",
      );
    },
  );
});
