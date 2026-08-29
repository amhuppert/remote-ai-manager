import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REFERENCE_REGISTRY } from "@/lib/prompt-editor/reference-registry";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createNotepadCommentsRepo } from "@/lib/state-store/notepad-comments-repo";
import { createNotepadsRepo } from "@/lib/state-store/notepads-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import { createNotepadContentStore } from "./content-store";
import { createNotepadService, type NotepadService } from "./service";
import {
  buildNotepadReadCommand,
  createNotepadInjectionReader,
  expandNotepadRefsForAgent,
  NOTEPAD_REF_XML_TAG,
  type NotepadInjectionReader,
  type NotepadInjectionSource,
} from "./injection";

function notepadRefXml(attrs: {
  id: string;
  name: string;
  scope?: string;
}): string {
  return [
    `<${NOTEPAD_REF_XML_TAG}`,
    `notepad-id="${attrs.id}"`,
    `name="${attrs.name}"`,
    `scope="${attrs.scope ?? "global"}"`,
    `read-command="${buildNotepadReadCommand(attrs.id)}"`,
    "/>",
  ].join(" ");
}

function source(
  overrides: Partial<NotepadInjectionSource> & { id: string },
): NotepadInjectionSource {
  return {
    name: `Notepad ${overrides.id}`,
    revision: 1,
    writeMode: "full-edit",
    content: "",
    ...overrides,
  };
}

/** Records reads so the pass's read behaviour is observable, not just its output. */
function fakeReader(notepads: readonly NotepadInjectionSource[]): {
  reader: NotepadInjectionReader;
  reads: string[];
} {
  const byId = new Map(notepads.map((n) => [n.id, n]));
  const reads: string[] = [];
  return {
    reads,
    reader: {
      async readForInjection(notepadId) {
        reads.push(notepadId);
        return byId.get(notepadId) ?? null;
      },
    },
  };
}

describe("NOTEPAD_REF_XML_TAG", () => {
  it("is the reference registry's tag for the notepad kind", () => {
    // The registry entry lands in a sibling context. Until it does, no entry
    // may claim our tag; once it does, the notepad kind must be the claimant.
    const entry = REFERENCE_REGISTRY.find(
      (candidate) => (candidate.xmlTag as string) === NOTEPAD_REF_XML_TAG,
    );
    const registryHasNotepadKind = REFERENCE_REGISTRY.some(
      (candidate) => (candidate.type as string) === "notepad",
    );
    expect(entry?.type).toBe(registryHasNotepadKind ? "notepad" : undefined);
  });
});

describe("buildNotepadReadCommand", () => {
  it("quotes the id so it survives verbatim shell use", () => {
    expect(buildNotepadReadCommand("np-1")).toBe("cctl notepad get 'np-1'");
    expect(buildNotepadReadCommand("np'1")).toBe(`cctl notepad get 'np'"'"'1'`);
  });
});

describe("expandNotepadRefsForAgent", () => {
  it("replaces the reference in place with a block naming id, name, revision, write mode, and read command", async () => {
    const { reader } = fakeReader([
      source({
        id: "np-1",
        name: "Design Notes",
        revision: 7,
        writeMode: "append-only",
        content: "# Design Notes\n\n- first point\n- second point",
      }),
    ]);

    const { text: expanded } = await expandNotepadRefsForAgent(
      `Before ${notepadRefXml({ id: "np-1", name: "Design Notes" })} after.`,
      reader,
    );

    expect(expanded.startsWith("Before ")).toBe(true);
    expect(expanded.endsWith(" after.")).toBe(true);
    expect(expanded).toContain("id: np-1");
    expect(expanded).toContain("name: Design Notes");
    expect(expanded).toContain("revision: 7");
    expect(expanded).toContain("write-mode: append-only");
    expect(expanded).toContain(`read: ${buildNotepadReadCommand("np-1")}`);
    expect(expanded).toContain(
      "# Design Notes\n\n- first point\n- second point",
    );
    expect(expanded).not.toContain(`<${NOTEPAD_REF_XML_TAG}`);
  });

  it("leaves text without notepad references untouched", async () => {
    const { reader, reads } = fakeReader([]);
    const text = 'Plain prose with a <ticket-ref ticket-id="t-1" /> only.';

    expect((await expandNotepadRefsForAgent(text, reader)).text).toBe(text);
    expect(reads).toEqual([]);
  });

  it("preserves embedded reference XML and its read commands verbatim", async () => {
    const embedded =
      '<ticket-ref identifier="command-center#12" title="Notepads" read-command="cctl ticket get \'command-center#12\'" />';
    const { reader } = fakeReader([
      source({
        id: "np-1",
        content: `Context: ${embedded}\n\nMore prose.`,
      }),
    ]);

    const { text: expanded } = await expandNotepadRefsForAgent(
      notepadRefXml({ id: "np-1", name: "Notepad np-1" }),
      reader,
    );

    expect(expanded).toContain(embedded);
    expect(expanded).toContain("cctl ticket get 'command-center#12'");
  });

  it("preserves image id tokens rather than dropping them", async () => {
    const { reader } = fakeReader([
      source({
        id: "np-1",
        content: "Screenshot: [Image: img-a]\n\nAnd another: [Image: img-b]\n",
      }),
    ]);

    const { text: expanded } = await expandNotepadRefsForAgent(
      notepadRefXml({ id: "np-1", name: "Notepad np-1" }),
      reader,
    );

    expect(expanded).toContain("[Image: img-a]");
    expect(expanded).toContain("[Image: img-b]");
  });

  it("delivers a nested notepad reference as a reference, never expanded", async () => {
    const nested = notepadRefXml({ id: "np-2", name: "Nested" });
    const { reader, reads } = fakeReader([
      source({ id: "np-1", content: `Outer content.\n\nSee ${nested}` }),
      source({ id: "np-2", content: "SECRET NESTED BODY" }),
    ]);

    const { text: expanded } = await expandNotepadRefsForAgent(
      notepadRefXml({ id: "np-1", name: "Notepad np-1" }),
      reader,
    );

    expect(expanded).toContain(nested);
    expect(expanded).not.toContain("SECRET NESTED BODY");
    expect(expanded).toContain(buildNotepadReadCommand("np-2"));
    // The pass never re-scans injected output, so the nested id is never read.
    expect(reads).toEqual(["np-1"]);
  });

  it("survives a reference cycle because injected output is never re-scanned", async () => {
    const { reader, reads } = fakeReader([
      source({
        id: "np-1",
        content: `Loops back: ${notepadRefXml({ id: "np-1", name: "Self" })}`,
      }),
    ]);

    const { text: expanded } = await expandNotepadRefsForAgent(
      notepadRefXml({ id: "np-1", name: "Self" }),
      reader,
    );

    expect(reads).toEqual(["np-1"]);
    expect(expanded).toContain(`<${NOTEPAD_REF_XML_TAG}`);
  });

  it("injects a short not-found block naming the id for a deleted notepad", async () => {
    const { reader } = fakeReader([]);

    const { text: expanded } = await expandNotepadRefsForAgent(
      `Check ${notepadRefXml({ id: "np-gone", name: "Stale Name" })} please.`,
      reader,
    );

    expect(expanded).toContain("id: np-gone");
    expect(expanded).toContain("not found");
    expect(expanded).not.toContain(`<${NOTEPAD_REF_XML_TAG}`);
    expect(expanded.startsWith("Check ")).toBe(true);
    expect(expanded.endsWith(" please.")).toBe(true);
  });

  it("leaves references inside fenced code blocks alone", async () => {
    const fenced = notepadRefXml({ id: "np-1", name: "Notepad np-1" });
    const text = `Example:\n\n\`\`\`xml\n${fenced}\n\`\`\`\n`;
    const { reader, reads } = fakeReader([
      source({ id: "np-1", content: "BODY" }),
    ]);

    const { text: expanded } = await expandNotepadRefsForAgent(text, reader);

    expect(expanded).toBe(text);
    expect(reads).toEqual([]);
  });

  it("expands every reference in the text and reads each notepad once", async () => {
    const { reader, reads } = fakeReader([
      source({ id: "np-1", content: "ONE BODY" }),
      source({ id: "np-2", content: "TWO BODY" }),
    ]);

    const { text: expanded } = await expandNotepadRefsForAgent(
      [
        notepadRefXml({ id: "np-1", name: "One" }),
        notepadRefXml({ id: "np-2", name: "Two" }),
        notepadRefXml({ id: "np-1", name: "One" }),
      ].join("\n\n"),
      reader,
    );

    expect(expanded.match(/ONE BODY/g)).toHaveLength(2);
    expect(expanded).toContain("TWO BODY");
    expect(reads).toEqual(["np-1", "np-2"]);
  });

  it("leaves a malformed reference carrying no id embedded in the text", async () => {
    const { reader, reads } = fakeReader([
      source({ id: "np-1", content: "BODY" }),
    ]);
    const text = `<${NOTEPAD_REF_XML_TAG} name="No Id" scope="global" />`;

    expect((await expandNotepadRefsForAgent(text, reader)).text).toBe(text);
    expect(reads).toEqual([]);
  });

  it("keeps the header block parseable when a name spans lines", async () => {
    const { reader } = fakeReader([
      source({ id: "np-1", name: "Broken\nName", content: "BODY" }),
    ]);

    const { text: expanded } = await expandNotepadRefsForAgent(
      notepadRefXml({ id: "np-1", name: "Broken Name" }),
      reader,
    );

    expect(expanded).toContain("name: Broken Name");
  });

  it("reports each delivered notepad with the revision the text carried", async () => {
    const { reader } = fakeReader([
      source({ id: "np-1", revision: 3, content: "ONE BODY" }),
      source({ id: "np-2", revision: 9, content: "TWO BODY" }),
    ]);

    const { delivered } = await expandNotepadRefsForAgent(
      [
        notepadRefXml({ id: "np-1", name: "One" }),
        notepadRefXml({ id: "np-2", name: "Two" }),
        notepadRefXml({ id: "np-1", name: "One" }),
      ].join("\n\n"),
      reader,
    );

    expect(delivered.map(({ id, revision }) => ({ id, revision }))).toEqual([
      { id: "np-1", revision: 3 },
      { id: "np-2", revision: 9 },
    ]);
  });

  it("reports nothing delivered when the text carries no reference", async () => {
    const { reader } = fakeReader([source({ id: "np-1", content: "BODY" })]);

    expect(
      (await expandNotepadRefsForAgent("Plain prose.", reader)).delivered,
    ).toEqual([]);
  });

  it("omits a dangling reference from the delivered report", async () => {
    const { reader } = fakeReader([
      source({ id: "np-1", revision: 2, content: "BODY" }),
    ]);

    const { delivered } = await expandNotepadRefsForAgent(
      [
        notepadRefXml({ id: "np-1", name: "One" }),
        notepadRefXml({ id: "np-gone", name: "Stale" }),
      ].join("\n\n"),
      reader,
    );

    expect(delivered.map((notepad) => notepad.id)).toEqual(["np-1"]);
  });
});

describe("createNotepadInjectionReader (against the real service)", () => {
  let fixture: PersistenceFixture;
  let service: NotepadService;
  let contentBase: string;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    contentBase = mkdtempSync(path.join(tmpdir(), "cc-notepad-injection-"));
    const writeQueue = createWriteQueue();
    const repo = createNotepadsRepo(fixture.db, writeQueue);
    const contentStore = createNotepadContentStore({
      contentRoot: path.join(contentBase, "notepad-content"),
      listNotepadIdsForProject: (projectPath) =>
        repo.listNotepadIds(projectPath),
    });
    let clock = 0;
    let idSeq = 0;
    service = createNotepadService({
      repo,
      comments: createNotepadCommentsRepo(fixture.db, writeQueue),
      publish: () => ({ delivered: true }),
      deleteNotepadContent: (notepadId) =>
        contentStore.deleteNotepad(notepadId),
      now: () => {
        clock += 1000;
        return new Date(Date.UTC(2026, 7, 27, 9, 0, 0) + clock).toISOString();
      },
      generateId: () => {
        idSeq += 1;
        return `generated-${idSeq}`;
      },
    });
  });

  afterEach(() => {
    fixture.close();
    rmSync(contentBase, { recursive: true, force: true });
  });

  async function createNotepad(content: string): Promise<string> {
    const created = await service.create({
      scope: "global",
      projectPath: null,
      name: "Injected Notepad",
      content,
      writeMode: "append-only",
    });
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    return created.value.id;
  }

  it("expands a live notepad's stored content through the service", async () => {
    const id = await createNotepad("# Stored\n\n[Image: img-a]");
    const reader = createNotepadInjectionReader(service);

    const { text: expanded } = await expandNotepadRefsForAgent(
      notepadRefXml({ id, name: "Stale Display Name" }),
      reader,
    );

    expect(expanded).toContain(`id: ${id}`);
    expect(expanded).toContain("name: Injected Notepad");
    expect(expanded).toContain("revision: 1");
    expect(expanded).toContain("write-mode: append-only");
    expect(expanded).toContain("# Stored\n\n[Image: img-a]");
  });

  it("delivers the current name and revision after a rename and a write", async () => {
    const id = await createNotepad("original");
    const renamed = await service.update(
      id,
      { name: "Renamed Notepad" },
      { kind: "user" },
    );
    if (!renamed.ok) throw new Error(`update failed: ${renamed.error.code}`);
    const written = await service.writeContent(id, {
      operation: "append",
      content: "\nappended",
      author: { kind: "agent", conversationId: "conv-1" },
      baseRevision: 1,
    });
    if (!written.ok) throw new Error(`write failed: ${written.error.code}`);

    const { text: expanded } = await expandNotepadRefsForAgent(
      notepadRefXml({ id, name: "Stale Display Name" }),
      createNotepadInjectionReader(service),
    );

    expect(expanded).toContain("name: Renamed Notepad");
    expect(expanded).toContain(`revision: ${written.value.revision}`);
    expect(expanded).toContain(written.value.content);
    expect(expanded).not.toContain("Stale Display Name");
  });

  it("resolves a deleted notepad to the not-found block", async () => {
    const id = await createNotepad("gone soon");
    const deleted = await service.delete(id);
    if (!deleted.ok) throw new Error(`delete failed: ${deleted.error.code}`);

    const { text: expanded } = await expandNotepadRefsForAgent(
      `Check ${notepadRefXml({ id, name: "Gone" })}.`,
      createNotepadInjectionReader(service),
    );

    expect(expanded).toContain(`id: ${id}`);
    expect(expanded).toContain("not found");
    expect(expanded).not.toContain("gone soon");
  });
});
