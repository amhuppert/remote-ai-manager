import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { buildMessageRefXml } from "@/lib/conversations/message-ref";
import { deserializePromptDoc } from "@/lib/prompt-editor/deserializer";
import { MessageMentionNode } from "@/lib/prompt-editor/message-mention-node";
import { NotepadMentionNode } from "@/lib/prompt-editor/notepad-mention-node";
import { serializePromptDoc } from "@/lib/prompt-editor/serializer";
import {
  buildSpecReferenceXml,
  RequirementMentionNode,
} from "@/lib/prompt-editor/spec-mention-nodes";

import { buildClipFragment, type ClipProvenance } from "./capture-fragment";
import { notepadValueParts } from "./content-parts";
import {
  expandNotepadRefsForAgent,
  type NotepadInjectionReader,
} from "./injection";
import { buildNotepadRefXml } from "./references";

const MESSAGE_REF_XML = buildMessageRefXml({
  projectName: "command-center",
  sessionName: "notepad-slice-3",
  conversationId: "conv-88",
  conversationName: "Capture foundation",
  messageIndex: 4,
  role: "assistant",
  timestamp: "2026-08-31T09:15:00Z",
  model: "opus",
  compaction: null,
});

const NOTEPAD_REF_XML = buildNotepadRefXml({
  notepadId: "np-7f3a",
  name: "Release checklist",
  scope: "project",
  projectName: "command-center",
});

const REQUIREMENT_REF_XML = buildSpecReferenceXml("requirement", {
  projectName: "command-center",
  slug: "notepad",
  handle: "R22",
  name: "Clip from a conversation",
  revision: "8",
});

const DOCUMENT_PATH = "docs/tailwind-conventions.md";

// The notepad editor's reference nodes, so a fragment's attribution chip
// survives the ProseMirror document the round-trip rebuilds it into.
const schema = getSchema([
  StarterKit,
  MessageMentionNode,
  NotepadMentionNode,
  RequirementMentionNode,
]);

/** Canonical text → editor document → canonical text, the editor's own path. */
function roundTrip(content: string): string {
  const json = deserializePromptDoc({ prompt: content, images: [] });
  const doc = ProseMirrorNode.fromJSON(schema, json);
  return serializePromptDoc({ doc, attachments: [] }).prompt;
}

function refProvenance(xml: string): ClipProvenance {
  return { kind: "ref", xml };
}

describe("buildClipFragment", () => {
  it("quotes single-line text and attributes it on one em-dash line", () => {
    expect(
      buildClipFragment({
        text: "The destination is shown before content lands.",
        isCode: false,
        provenance: refProvenance(MESSAGE_REF_XML),
      }),
    ).toBe(
      `> The destination is shown before content lands.\n— ${MESSAGE_REF_XML}`,
    );
  });

  it("prefixes every line of a multi-line clip, blank lines included", () => {
    const fragment = buildClipFragment({
      text: "First paragraph.\n\nSecond paragraph.\n  indented tail",
      isCode: false,
      provenance: refProvenance(MESSAGE_REF_XML),
    });

    expect(fragment).toBe(
      [
        "> First paragraph.",
        ">",
        "> Second paragraph.",
        ">   indented tail",
        `— ${MESSAGE_REF_XML}`,
      ].join("\n"),
    );
  });

  it("fences a code clip instead of quoting it, so code survives verbatim", () => {
    const fragment = buildClipFragment({
      text: "if (ready) {\n  run();\n}",
      isCode: true,
      provenance: refProvenance(MESSAGE_REF_XML),
    });

    expect(fragment).toBe(
      `\`\`\`\nif (ready) {\n  run();\n}\n\`\`\`\n— ${MESSAGE_REF_XML}`,
    );
  });

  it("opens a fence longer than any backtick run the code contains", () => {
    // A clipped markdown answer carries its own fence; a fixed ``` fence would
    // close on that line, spilling the rest of the selection and the
    // attribution outside the block.
    const code = "Example:\n\n```js\nrun();\n```\n\nDone.";
    const fragment = buildClipFragment({
      text: code,
      isCode: true,
      provenance: refProvenance(MESSAGE_REF_XML),
    });

    expect(fragment).toBe(`\`\`\`\`\n${code}\n\`\`\`\`\n— ${MESSAGE_REF_XML}`);
    // The clipped code sits between the fences byte-for-byte, and the fence
    // never appears at the length CommonMark would close on.
    expect(fragment.split("\n").slice(1, -2).join("\n")).toBe(code);
  });

  it("outgrows a longer run too, so no selection can close its own fence", () => {
    const code = "````\nnested\n````";
    const fragment = buildClipFragment({
      text: code,
      isCode: true,
      provenance: refProvenance(MESSAGE_REF_XML),
    });

    expect(fragment.split("\n")[0]).toBe("`````");
    expect(fragment).toBe(
      `\`\`\`\`\`\n${code}\n\`\`\`\`\`\n— ${MESSAGE_REF_XML}`,
    );
  });

  it("keeps the plain triple fence when the code holds no fence-length run", () => {
    const fragment = buildClipFragment({
      text: "const marker = `x`;",
      isCode: true,
      provenance: refProvenance(MESSAGE_REF_XML),
    });

    expect(fragment).toBe(
      `\`\`\`\nconst marker = \`x\`;\n\`\`\`\n— ${MESSAGE_REF_XML}`,
    );
  });

  it("carries no leading or trailing separator — composition owns that", () => {
    for (const isCode of [false, true]) {
      const fragment = buildClipFragment({
        text: "clipped",
        isCode,
        provenance: refProvenance(MESSAGE_REF_XML),
      });
      expect(fragment.startsWith("\n")).toBe(false);
      expect(fragment.endsWith("\n")).toBe(false);
    }
  });
});

describe("buildClipFragment provenance mapping", () => {
  const cases: Array<{
    kind: string;
    provenance: ClipProvenance;
    line: string;
  }> = [
    {
      kind: "message-ref",
      provenance: refProvenance(MESSAGE_REF_XML),
      line: `— ${MESSAGE_REF_XML}`,
    },
    {
      kind: "notepad-ref",
      provenance: refProvenance(NOTEPAD_REF_XML),
      line: `— ${NOTEPAD_REF_XML}`,
    },
    {
      kind: "spec-element-ref",
      provenance: refProvenance(REQUIREMENT_REF_XML),
      line: `— ${REQUIREMENT_REF_XML}`,
    },
    {
      kind: "document-path",
      provenance: { kind: "path", path: DOCUMENT_PATH },
      line: `— ${DOCUMENT_PATH}`,
    },
  ];

  it.each(cases)(
    "renders $kind attribution exactly once",
    ({ provenance, line }) => {
      const fragment = buildClipFragment({
        text: "clipped text",
        isCode: false,
        provenance,
      });

      const lines = fragment.split("\n");
      expect(lines).toEqual(["> clipped text", line]);
      expect(fragment.split("— ")).toHaveLength(2);
    },
  );
});

describe("clip fragment round-trip through the notepad dialect", () => {
  const contents = [
    {
      label: "plain text",
      text: "A single clipped sentence.",
      isCode: false,
    },
    {
      label: "multi-line text",
      text: "First line.\n\nSecond line.",
      isCode: false,
    },
    { label: "code", text: "const x = 1;\nreturn x;", isCode: true },
    {
      label: "code that contains its own fence",
      text: "Example:\n\n```js\nrun();\n```",
      isCode: true,
    },
  ];

  it.each(contents)(
    "survives serialize/deserialize with $label intact",
    ({ text, isCode }) => {
      const fragment = buildClipFragment({
        text,
        isCode,
        provenance: refProvenance(MESSAGE_REF_XML),
      });
      const content = `Existing notepad content.\n\n${fragment}`;

      expect(roundTrip(content)).toBe(content);
    },
  );

  it("segments the attribution as a reference part, not plain text", () => {
    const fragment = buildClipFragment({
      text: "clipped text",
      isCode: false,
      provenance: refProvenance(MESSAGE_REF_XML),
    });
    const attribution = fragment.split("\n").at(-1) ?? "";

    expect(notepadValueParts("html", attribution)).toEqual([
      { type: "text", text: "— ", start: 0, end: 2 },
      expect.objectContaining({
        type: "ref",
        segment: expect.objectContaining({
          type: "message-ref",
          raw: MESSAGE_REF_XML,
        }),
      }),
    ]);
  });

  it("keeps a path attribution as plain text — no registry kind to resolve", () => {
    const fragment = buildClipFragment({
      text: "clipped text",
      isCode: false,
      provenance: { kind: "path", path: DOCUMENT_PATH },
    });
    const attribution = fragment.split("\n").at(-1) ?? "";

    expect(notepadValueParts("html", attribution)).toEqual([
      { type: "text", text: attribution, start: 0, end: attribution.length },
    ]);
  });
});

describe("clip provenance through agent injection (R22.2)", () => {
  function readerFor(content: string): NotepadInjectionReader {
    return {
      async readForInjection(notepadId) {
        return {
          id: notepadId,
          name: "Inbox",
          revision: 3,
          openComments: { count: 0, latestCreatedAt: null },
          writeMode: "full-edit",
          content,
        };
      },
    };
  }

  it("delivers the clip's message-ref XML verbatim with its read command", async () => {
    const fragment = buildClipFragment({
      text: "The retry keeps the recording.",
      isCode: false,
      provenance: refProvenance(MESSAGE_REF_XML),
    });
    const notepadRef = buildNotepadRefXml({
      notepadId: "np-inbox",
      name: "Inbox",
      scope: "project",
      projectName: "command-center",
    });

    const { text, delivered } = await expandNotepadRefsForAgent(
      `Read ${notepadRef} before replying.`,
      readerFor(`Earlier note.\n\n${fragment}`),
    );

    expect(text).toContain(MESSAGE_REF_XML);
    expect(text).toContain(
      'read-command="cctl conversation read conv-88 --message 4"',
    );
    expect(text).toContain("> The retry keeps the recording.");
    expect(delivered).toHaveLength(1);
  });
});
