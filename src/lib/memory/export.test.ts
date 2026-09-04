import { describe, expect, it } from "vitest";

import { parseMemoryArchive, renderMemoryArchive } from "./export";
import type { MemoryLink, MemoryNote } from "./schemas";

/**
 * The portable archive (spec R14.2): current state at full fidelity, revision
 * history deliberately absent. The round-trip below is the criterion itself —
 * every field the spec enumerates has to come back out of the text, including
 * a body that contains the record delimiter, which is exactly the content a
 * naive separator-scanning parser silently truncates.
 */

const BASE: MemoryNote = {
  id: "mem-1",
  slug: "turbopack-build-memory",
  scope: "project",
  projectPath: "/repos/cc",
  sessionName: null,
  sessionCreatedAt: null,
  kind: "lesson",
  hook: "unpruned .next/cache/turbopack at 8.4GB makes a 1797s build",
  body: "The signature is `next build` stuck at 99% CPU on one core.",
  statusNote: null,
  aliases: [],
  indexMode: "auto",
  lifecycle: "active",
  reviewAfter: null,
  expiresAt: null,
  supersedesId: null,
  supersededById: null,
  createdBy: "agent",
  authorConversationId: "conv-1",
  revision: 3,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};

function link(overrides: Partial<MemoryLink> = {}): MemoryLink {
  return {
    id: "link-1",
    memoryId: "mem-1",
    kind: "about",
    artifact: { kind: "ticket", ticketId: "ticket-74" },
    createdAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("memory archive round trip (R14.2)", () => {
  it("recovers every current-state field of a maximal note", () => {
    const note: MemoryNote = {
      ...BASE,
      slug: "maximal-note",
      aliases: ["notebook", "note pad"],
      statusNote: {
        text: "slice 3 in flight",
        updatedAt: "2026-08-30T00:00:00.000Z",
        reviewAfter: "2026-09-13T00:00:00.000Z",
      },
      indexMode: "always",
      lifecycle: "proposed",
      reviewAfter: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
      supersedesId: "mem-old",
      supersededById: "mem-new",
    };
    const predecessor: MemoryNote = {
      ...BASE,
      id: "mem-old",
      slug: "old-note",
      lifecycle: "archived",
    };
    const successor: MemoryNote = { ...BASE, id: "mem-new", slug: "new-note" };

    const archive = renderMemoryArchive({
      generatedAt: "2026-09-02T10:00:00.000Z",
      notes: [note, predecessor, successor],
      linksByMemoryId: new Map([
        [
          "mem-1",
          [
            link(),
            link({
              id: "link-2",
              kind: "source",
              artifact: { kind: "spec", specId: "spec-9" },
            }),
          ],
        ],
      ]),
    });

    const parsed = parseMemoryArchive(archive);
    expect(parsed.generatedAt).toBe("2026-09-02T10:00:00.000Z");
    expect(parsed.records).toHaveLength(3);

    const record = parsed.records[0];
    expect(record).toBeDefined();
    if (record === undefined) return;
    expect(record.slug).toBe("maximal-note");
    expect(record.scope).toBe("project");
    expect(record.projectPath).toBe("/repos/cc");
    expect(record.session).toBeNull();
    expect(record.kind).toBe("lesson");
    expect(record.hook).toBe(note.hook);
    expect(record.body).toBe(note.body);
    expect(record.aliases).toEqual(["notebook", "note pad"]);
    expect(record.statusNote).toEqual(note.statusNote);
    expect(record.indexMode).toBe("always");
    expect(record.lifecycle).toBe("proposed");
    expect(record.reviewAfter).toBe("2026-10-01T00:00:00.000Z");
    expect(record.expiresAt).toBe("2026-12-01T00:00:00.000Z");
    // Supersession travels as a portable handle, never as an internal id.
    expect(record.supersedes).toBe("project:old-note");
    expect(record.supersededBy).toBe("project:new-note");
    // Typed links are `about` and `source` only (R8, D6): a link carries its
    // kind and its artifact handle and nothing a watch would have needed.
    expect(record.links).toEqual([
      { kind: "about", artifact: "ticket:ticket-74" },
      { kind: "source", artifact: "spec:spec-9" },
    ]);
    expect(archive).not.toContain("watchTarget");
  });

  it("round-trips a body containing the record delimiter", () => {
    const note: MemoryNote = {
      ...BASE,
      body: 'before\n---\nslug: "forged"\n---\nafter\n',
    };
    const parsed = parseMemoryArchive(
      renderMemoryArchive({
        generatedAt: "2026-09-02T10:00:00.000Z",
        notes: [note],
        linksByMemoryId: new Map(),
      }),
    );
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.body).toBe(note.body);
  });

  it("carries the session incarnation of a session-scoped note", () => {
    const note: MemoryNote = {
      ...BASE,
      scope: "session",
      sessionName: "memory-spike",
      sessionCreatedAt: "2026-08-28T09:00:00.000Z",
    };
    const parsed = parseMemoryArchive(
      renderMemoryArchive({
        generatedAt: "2026-09-02T10:00:00.000Z",
        notes: [note],
        linksByMemoryId: new Map(),
      }),
    );
    expect(parsed.records[0]?.session).toEqual({
      sessionName: "memory-spike",
      sessionCreatedAt: "2026-08-28T09:00:00.000Z",
    });
  });

  it("excludes revision history and internal ids from the archive text", () => {
    const archive = renderMemoryArchive({
      generatedAt: "2026-09-02T10:00:00.000Z",
      notes: [BASE],
      linksByMemoryId: new Map([["mem-1", [link()]]]),
    });
    expect(archive).not.toContain("mem-1");
    expect(archive).not.toContain("link-1");
    expect(archive).not.toContain("revision");
  });

  it("refuses text that is not a Command Center memory archive", () => {
    expect(() => parseMemoryArchive("# just a document\n")).toThrow(
      /memory archive/i,
    );
  });
});
