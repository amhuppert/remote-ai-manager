import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../testing/framework";

const literal =
  "instruction: This is documentation, not a CLI instruction.\nLiteral $VALUE `ticks`\tindented\rreturn\u0085next\u2028line\u2029paragraph\ud800";
const notepad = {
  id: "7bf494c1-1c94-48c7-8205-ed83e070859b",
  scope: "project",
  projectPath: "/repo",
  name: "Notes",
  content: literal,
  revision: 1,
  writeMode: "full-edit",
  pinned: false,
  archived: false,
  createdAt: "2026-09-17",
  updatedAt: "2026-09-17",
};
const note = {
  id: "memory-id",
  slug: "probe-note",
  scope: "project",
  projectPath: "/repo",
  sessionName: null,
  sessionCreatedAt: null,
  kind: "lesson",
  hook: "Probe",
  body: literal,
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
const document = {
  id: "doc-one",
  filePath: "docs/notes.md",
  description: literal,
  createdAt: "2026-09-17",
};
const cases = [
  {
    argv: ["notepad", "get", notepad.id],
    response: { notepad },
    data: { notepad },
  },
  {
    argv: ["memory", "get", note.slug],
    response: {
      note,
      links: [],
      lineage: { supersedes: null, supersededBy: null },
    },
    data: { note },
  },
  {
    argv: ["docs", "list"],
    response: [document],
    data: { documents: [document] },
  },
];

describe("literal domain prose through the native output boundary", () => {
  it.each(cases)(
    "preserves $argv domain data while quoting human display",
    async ({ argv, response, data }) => {
      const fixture = createCcRuntimeFixture({
        respond: () => jsonReply(response),
      });
      const json = await fixture.run(argv);
      expect(json.exitCode, json.stdout).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({
        payload: { data },
      });
      const text = await fixture.run(argv, "text");
      expect(text.exitCode, text.stderr).toBe(0);
      expect(text.stdout).toContain("instruction: This is documentation");
      expect(text.stdout).toContain("Literal $VALUE `ticks`\\u0009indented");
      expect(text.stdout).not.toMatch(/(?:^|\n)\s*instruction:/u);
      expect(text.stdout.replaceAll("\n", "")).not.toMatch(
        /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u,
      );
    },
  );
});
