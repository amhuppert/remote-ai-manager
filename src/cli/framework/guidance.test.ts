import { describe, expect, it } from "vitest";
import type { MemoryNote } from "@/lib/memory/schemas";
import { createCcRuntimeFixture, jsonReply } from "../testing/framework";

const note: MemoryNote = {
  id: "internal-memory-id",
  slug: "payload-location",
  scope: "project",
  projectPath: "/repo/project-one",
  sessionName: null,
  sessionCreatedAt: null,
  kind: "lesson",
  hook: "Author payload files under .cc/temp/",
  body: "Completed the implementation",
  statusNote: null,
  aliases: [],
  indexMode: "auto",
  lifecycle: "active",
  reviewAfter: null,
  expiresAt: null,
  supersedesId: null,
  supersededById: null,
  createdBy: "agent",
  authorConversationId: "conversation-one",
  revision: 1,
  createdAt: "2026-09-17T12:00:00Z",
  updatedAt: "2026-09-17T12:00:00Z",
};

function createWithBodyFile(bodyFile: string) {
  const fixture = createCcRuntimeFixture({
    files: { [bodyFile]: note.body },
    respond: ({ url }) =>
      url.includes("/api/memory/notes")
        ? jsonReply(
            { note, advisories: { overlapCandidates: [], hookWarnings: [] } },
            201,
          )
        : jsonReply({ error: "unrouted" }, 404),
  });
  return fixture.run([
    "memory",
    "create",
    "--hook",
    note.hook,
    "--body-file",
    bodyFile,
  ]);
}

describe("client guidance for file-backed payloads", () => {
  it("reminds the caller that a payload file outside .cc/ can be swept into a lane commit", async () => {
    const result = await createWithBodyFile("summary.md");

    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.envelope?.reminders).toEqual([
      expect.stringContaining('"summary.md" is outside .cc/'),
    ]);
  });

  it("stays silent for a payload file already under .cc/temp/", async () => {
    const result = await createWithBodyFile(".cc/temp/summary.md");

    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.envelope?.reminders).toEqual([]);
  });
});
