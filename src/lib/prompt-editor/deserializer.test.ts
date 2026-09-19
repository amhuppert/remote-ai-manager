import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { deserializePromptDoc } from "./deserializer";
import { serializePromptDoc } from "./serializer";
import { SlashCommandMarker } from "./slash-command-marker-node";

const schema = getSchema([StarterKit, SlashCommandMarker]);

function roundTrip(prompt: string): string {
  const json = deserializePromptDoc({ prompt, images: [] });
  const doc = ProseMirrorNode.fromJSON(schema, json);
  return serializePromptDoc({ doc, attachments: [] }).prompt;
}

describe("deserializePromptDoc code formatting", () => {
  it("restores an explicit skill as a chip and retains its identity on resubmit", () => {
    const prompt = "Use [$wave](</skills/Alex%20%28personal%29/SKILL.md>) now";
    expect(deserializePromptDoc({ prompt, images: [] })).toMatchObject({
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Use " },
            {
              type: "slashCommandMarker",
              attrs: {
                name: "$wave",
                trigger: "$",
                kind: "skill",
                skillPath: "/skills/Alex (personal)/SKILL.md",
              },
            },
            { type: "text", text: " now" },
          ],
        },
      ],
    });
    expect(roundTrip(prompt)).toBe(prompt);
  });

  it("keeps skill examples in code literal while restoring a later selection", () => {
    const reference = "[$wave](</skills/wave/SKILL.md>)";
    const prompt = `\`${reference}\`\n~~~markdown\n${reference}\n~~~\n${reference}`;
    const json = deserializePromptDoc({ prompt, images: [] });
    const chips = json.content?.flatMap((block) =>
      (block.content ?? []).filter(
        (node) => node.type === "slashCommandMarker",
      ),
    );
    expect(chips).toHaveLength(1);
    expect(roundTrip(prompt)).toBe(prompt);
  });

  it("round-trips inline code and fenced code blocks with their language", () => {
    const prompt =
      "Run `bun test` first.\n```c++\nint main() {\n  return 0;\n}\n```\nThen report back.";

    expect(deserializePromptDoc({ prompt, images: [] })).toMatchObject({
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Run " },
            {
              type: "text",
              text: "bun test",
              marks: [{ type: "code" }],
            },
            { type: "text", text: " first." },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "c++" },
          content: [{ type: "text", text: "int main() {\n  return 0;\n}" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Then report back." }],
        },
      ],
    });

    expect(roundTrip(prompt)).toBe(prompt);
  });

  it("keeps reference and image syntax literal inside code contexts", () => {
    const ticketRef =
      '<ticket-ref project-name="command-center" ticket-number="12" ' +
      'identifier="command-center#12" title="Fix parser" ' +
      'read-command="cctl ticket get &apos;command-center#12&apos;" />';
    const json = deserializePromptDoc({
      prompt:
        `\`[Image #1] ${ticketRef}\`` +
        `\n\`\`\`xml\n[Image #1]\n${ticketRef}\n\`\`\``,
      images: [
        {
          attachmentId: "image-1",
          mediaType: "image/png",
          base64Data: "aW1hZ2U=",
          inlineMarkerIndex: 1,
        },
      ],
    });

    expect(json).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: `[Image #1] ${ticketRef}`,
              marks: [{ type: "code" }],
            },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "xml" },
          content: [{ type: "text", text: `[Image #1]\n${ticketRef}` }],
        },
      ],
    });
  });

  it("does not treat backticks inside a reference attribute as inline code", () => {
    const ticketRef =
      '<ticket-ref project-name="command-center" ticket-number="12" ' +
      'identifier="command-center#12" title="Fix `code` rendering" ' +
      'read-command="cctl ticket get &apos;command-center#12&apos;" />';

    expect(
      deserializePromptDoc({ prompt: ticketRef, images: [] }),
    ).toMatchObject({
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "ticketMention",
              attrs: { title: "Fix `code` rendering" },
            },
          ],
        },
      ],
    });
  });

  it("leaves an unmatched opening fence as literal text", () => {
    const prompt = "```ts\nconst answer = 42;";

    expect(roundTrip(prompt)).toBe(prompt);
  });

  it("normalizes CRLF in fenced code without losing indentation", () => {
    expect(roundTrip("```ts\r\nif (ready) {\r\n  run();\r\n}\r\n```")).toBe(
      "```ts\nif (ready) {\n  run();\n}\n```",
    );
  });
});

describe("deserializePromptDoc notepad image tokens", () => {
  it("keeps notepad image tokens literal without the notepad option", () => {
    expect(
      deserializePromptDoc({ prompt: "see [Image: img-1] here", images: [] }),
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "see [Image: img-1] here" }],
        },
      ],
    });
  });

  it("rebuilds a notepadImage node from a token when the notepad option is set", () => {
    expect(
      deserializePromptDoc(
        { prompt: "see [Image: img-1] here", images: [] },
        { notepadImages: true },
      ),
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "see " },
            { type: "notepadImage", attrs: { imageId: "img-1", fileName: "" } },
            { type: "text", text: " here" },
          ],
        },
      ],
    });
  });

  it("keeps tokens literal inside code contexts even with the notepad option", () => {
    expect(
      deserializePromptDoc(
        {
          prompt: "`[Image: img-1]`\n```\n[Image: img-2]\n```",
          images: [],
        },
        { notepadImages: true },
      ),
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "[Image: img-1]",
              marks: [{ type: "code" }],
            },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: null },
          content: [{ type: "text", text: "[Image: img-2]" }],
        },
      ],
    });
  });

  it("leaves prompt-style positional markers untouched by the notepad option", () => {
    expect(
      deserializePromptDoc(
        { prompt: "old [Image #2] marker", images: [] },
        { notepadImages: true },
      ),
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "old [Image #2] marker" }],
        },
      ],
    });
  });
});
