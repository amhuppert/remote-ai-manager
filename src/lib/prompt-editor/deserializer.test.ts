import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { deserializePromptDoc } from "./deserializer";
import { serializePromptDoc } from "./serializer";

const schema = getSchema([StarterKit]);

function roundTrip(prompt: string): string {
  const json = deserializePromptDoc({ prompt, images: [] });
  const doc = ProseMirrorNode.fromJSON(schema, json);
  return serializePromptDoc({ doc, attachments: [] }).prompt;
}

describe("deserializePromptDoc code formatting", () => {
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
