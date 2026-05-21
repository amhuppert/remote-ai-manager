import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { ImageAttachment } from "@/hooks/use-image-attachments";
import { serializePromptDoc } from "./serializer";

// ---------------------------------------------------------------------------
// Hand-built ProseMirror schema mirroring the Tiptap editor's runtime schema.
// Lets us construct prompt documents in tests without an Editor instance.
// ---------------------------------------------------------------------------

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
    hardBreak: { group: "inline", inline: true, atom: true, selectable: false },
    imageMarker: {
      group: "inline",
      inline: true,
      atom: true,
      selectable: true,
      attrs: {
        index: { default: 0 },
        attachmentId: { default: "" },
        mediaType: { default: "image/png" },
        thumbnailUrl: { default: "" },
        fileName: { default: null },
      },
    },
    slashCommandMarker: {
      group: "inline",
      inline: true,
      atom: true,
      selectable: true,
      attrs: {
        name: { default: "" },
        trigger: { default: "/" },
        kind: { default: "command" },
        source: { default: "" },
        description: { default: null },
        argumentHint: { default: null },
      },
    },
    fileMention: {
      group: "inline",
      inline: true,
      atom: true,
      selectable: true,
      attrs: {
        path: { default: "" },
        basename: { default: "" },
        ext: { default: "" },
      },
    },
    codeBlock: {
      group: "block",
      content: "text*",
      marks: "",
      code: true,
      defining: true,
      attrs: { language: { default: null } },
    },
  },
  marks: {
    code: {},
  },
});

function p(...children: ProseMirrorNode[]): ProseMirrorNode {
  return schema.nodes["paragraph"]!.create(null, children);
}

function t(text: string): ProseMirrorNode {
  return schema.text(text);
}

function br(): ProseMirrorNode {
  return schema.nodes["hardBreak"]!.create();
}

function marker(attrs: {
  index: number;
  attachmentId: string;
  mediaType?: string;
  thumbnailUrl?: string;
  fileName?: string | null;
}): ProseMirrorNode {
  return schema.nodes["imageMarker"]!.create({
    index: attrs.index,
    attachmentId: attrs.attachmentId,
    mediaType: attrs.mediaType ?? "image/png",
    thumbnailUrl: attrs.thumbnailUrl ?? "",
    fileName: attrs.fileName ?? null,
  });
}

function slashChip(attrs: {
  name: string;
  trigger?: "/" | "$";
  kind?: "command" | "skill";
  source?: string;
}): ProseMirrorNode {
  return schema.nodes["slashCommandMarker"]!.create({
    name: attrs.name,
    trigger: attrs.trigger ?? "/",
    kind: attrs.kind ?? "command",
    source: attrs.source ?? "",
    description: null,
    argumentHint: null,
  });
}

function fileChip(path: string): ProseMirrorNode {
  const slash = path.lastIndexOf("/");
  const basename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = basename.lastIndexOf(".");
  const ext = dot > 0 ? basename.slice(dot + 1) : "";
  return schema.nodes["fileMention"]!.create({ path, basename, ext });
}

function code(text: string): ProseMirrorNode {
  return schema.text(text, [schema.marks["code"]!.create()]);
}

function codeBlock(
  text: string,
  language: string | null = null,
): ProseMirrorNode {
  return schema.nodes["codeBlock"]!.create(
    { language },
    text.length > 0 ? [schema.text(text)] : [],
  );
}

function doc(...paragraphs: ProseMirrorNode[]): ProseMirrorNode {
  return schema.nodes["doc"]!.create(null, paragraphs);
}

function makeAttachment(
  id: string,
  mediaType: ImageAttachment["mediaType"] = "image/png",
  base64Data: string = "QUJD",
): ImageAttachment {
  return {
    id,
    fileName: `${id}.png`,
    mediaType,
    base64Data,
    previewUrl: `blob:${id}`,
    sizeBytes: 100,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("serializePromptDoc", () => {
  it("returns empty prompt and no images for an empty doc", () => {
    const result = serializePromptDoc({
      doc: doc(p()),
      attachments: [],
    });

    expect(result.prompt).toBe("");
    expect(result.images).toEqual([]);
  });

  it("serializes plain text", () => {
    const result = serializePromptDoc({
      doc: doc(p(t("hello world"))),
      attachments: [],
    });

    expect(result.prompt).toBe("hello world");
    expect(result.images).toEqual([]);
  });

  it("serializes a single inline marker as [Image #N]", () => {
    const attachments = [makeAttachment("img-1")];
    const result = serializePromptDoc({
      doc: doc(p(marker({ index: 3, attachmentId: "img-1" }))),
      attachments,
    });

    expect(result.prompt).toBe("[Image #3]");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toEqual({
      attachmentId: "img-1",
      mediaType: "image/png",
      base64Data: "QUJD",
      inlineMarkerIndex: 3,
    });
  });

  it("embeds marker text inline between surrounding text", () => {
    const result = serializePromptDoc({
      doc: doc(
        p(
          t("look at "),
          marker({ index: 5, attachmentId: "img-1" }),
          t(" please"),
        ),
      ),
      attachments: [makeAttachment("img-1")],
    });

    expect(result.prompt).toBe("look at [Image #5] please");
    expect(result.images[0]?.inlineMarkerIndex).toBe(5);
  });

  it("joins paragraphs with a single newline", () => {
    const result = serializePromptDoc({
      doc: doc(p(t("first")), p(t("second")), p(t("third"))),
      attachments: [],
    });

    expect(result.prompt).toBe("first\nsecond\nthird");
  });

  it("emits no leading or trailing newlines around blank paragraphs", () => {
    const result = serializePromptDoc({
      doc: doc(p(), p(t("body")), p()),
      attachments: [],
    });

    expect(result.prompt).toBe("\nbody\n");
  });

  it("converts hardBreak nodes to newlines within a paragraph", () => {
    const result = serializePromptDoc({
      doc: doc(p(t("line one"), br(), t("line two"))),
      attachments: [],
    });

    expect(result.prompt).toBe("line one\nline two");
  });

  it("preserves attachment order on the wire", () => {
    const attachments = [
      makeAttachment("img-1"),
      makeAttachment("img-2", "image/jpeg"),
      makeAttachment("img-3", "image/webp"),
    ];

    const result = serializePromptDoc({
      doc: doc(
        p(t("inline only "), marker({ index: 2, attachmentId: "img-2" })),
      ),
      attachments,
    });

    expect(result.images.map((i) => i.attachmentId)).toEqual([
      "img-1",
      "img-2",
      "img-3",
    ]);
    expect(result.images[0]?.inlineMarkerIndex).toBeUndefined();
    expect(result.images[1]?.inlineMarkerIndex).toBe(2);
    expect(result.images[2]?.inlineMarkerIndex).toBeUndefined();
  });

  it("forwards attachment mediaType and base64 verbatim", () => {
    const result = serializePromptDoc({
      doc: doc(p()),
      attachments: [makeAttachment("img-1", "image/webp", "WEBPDATA")],
    });

    expect(result.images[0]).toEqual({
      attachmentId: "img-1",
      mediaType: "image/webp",
      base64Data: "WEBPDATA",
    });
  });

  it("supports multiple inline markers across paragraphs", () => {
    const result = serializePromptDoc({
      doc: doc(
        p(t("first "), marker({ index: 1, attachmentId: "img-a" })),
        p(marker({ index: 2, attachmentId: "img-b" }), t(" second")),
      ),
      attachments: [makeAttachment("img-a"), makeAttachment("img-b")],
    });

    expect(result.prompt).toBe("first [Image #1]\n[Image #2] second");
    expect(result.images[0]?.inlineMarkerIndex).toBe(1);
    expect(result.images[1]?.inlineMarkerIndex).toBe(2);
  });

  it("ignores marker nodes whose attachmentId has no matching attachment", () => {
    const result = serializePromptDoc({
      doc: doc(p(t("orphan: "), marker({ index: 9, attachmentId: "missing" }))),
      attachments: [],
    });

    expect(result.prompt).toBe("orphan: [Image #9]");
    expect(result.images).toEqual([]);
  });

  it("serializes a slash command chip as its name verbatim", () => {
    const result = serializePromptDoc({
      doc: doc(p(slashChip({ name: "/spec-init" }))),
      attachments: [],
    });

    expect(result.prompt).toBe("/spec-init");
  });

  it("serializes a codex skill chip with the $ trigger preserved", () => {
    const result = serializePromptDoc({
      doc: doc(p(slashChip({ name: "$wave", trigger: "$", kind: "skill" }))),
      attachments: [],
    });

    expect(result.prompt).toBe("$wave");
  });

  it("embeds a slash chip between surrounding text", () => {
    const result = serializePromptDoc({
      doc: doc(
        p(t("please run "), slashChip({ name: "/spec-init" }), t(" now")),
      ),
      attachments: [],
    });

    expect(result.prompt).toBe("please run /spec-init now");
  });

  it("serializes a file mention chip as @path", () => {
    const result = serializePromptDoc({
      doc: doc(p(fileChip("src/lib/foo.ts"))),
      attachments: [],
    });

    expect(result.prompt).toBe("@src/lib/foo.ts");
  });

  it("embeds a file mention between surrounding text", () => {
    const result = serializePromptDoc({
      doc: doc(p(t("look at "), fileChip("src/app/page.tsx"), t(" please"))),
      attachments: [],
    });

    expect(result.prompt).toBe("look at @src/app/page.tsx please");
  });

  it("wraps inline code-marked text in backticks", () => {
    const result = serializePromptDoc({
      doc: doc(p(t("call "), code("foo()"), t(" first"))),
      attachments: [],
    });

    expect(result.prompt).toBe("call `foo()` first");
  });

  it("preserves multiple inline code spans in one paragraph", () => {
    const result = serializePromptDoc({
      doc: doc(p(code("a"), t(" then "), code("b"))),
      attachments: [],
    });

    expect(result.prompt).toBe("`a` then `b`");
  });

  it("serializes a codeBlock without language as a fenced block", () => {
    const result = serializePromptDoc({
      doc: doc(codeBlock("const x = 1;\nconst y = 2;")),
      attachments: [],
    });

    expect(result.prompt).toBe("```\nconst x = 1;\nconst y = 2;\n```");
  });

  it("serializes a codeBlock with a language attribute", () => {
    const result = serializePromptDoc({
      doc: doc(codeBlock("export const x = 1;", "ts")),
      attachments: [],
    });

    expect(result.prompt).toBe("```ts\nexport const x = 1;\n```");
  });

  it("places a codeBlock between paragraphs joined with single newlines", () => {
    const result = serializePromptDoc({
      doc: doc(p(t("before")), codeBlock("body", "ts"), p(t("after"))),
      attachments: [],
    });

    expect(result.prompt).toBe("before\n```ts\nbody\n```\nafter");
  });

  it("handles an empty codeBlock as an empty fenced block", () => {
    const result = serializePromptDoc({
      doc: doc(codeBlock("")),
      attachments: [],
    });

    expect(result.prompt).toBe("```\n\n```");
  });

  it("supports mixed chips, code, and plain text in one document", () => {
    const result = serializePromptDoc({
      doc: doc(
        p(
          slashChip({ name: "/spec-init" }),
          t(" with "),
          fileChip("README.md"),
          t(" using "),
          code("bun run dev"),
        ),
        codeBlock("export {};", "ts"),
      ),
      attachments: [],
    });

    expect(result.prompt).toBe(
      "/spec-init with @README.md using `bun run dev`\n```ts\nexport {};\n```",
    );
  });
});
