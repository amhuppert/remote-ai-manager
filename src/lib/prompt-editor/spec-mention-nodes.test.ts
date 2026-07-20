// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { beforeEach, describe, expect, it } from "vitest";
import { deserializePromptDoc } from "./deserializer";
import { RefPasteHandler } from "./ref-paste-extension";
import { serializePromptDoc } from "./serializer";
import {
  DecisionMentionNode,
  RequirementMentionNode,
  SpecMentionNode,
  TaskMentionNode,
} from "./spec-mention-nodes";

const SPEC_REFERENCE_FIXTURES = [
  {
    nodeName: "specMention",
    xml: '<spec-ref project-name="command-center" slug="native-sdd" name="Native SDD" revision="3" read-command="cctl spec show &apos;native-sdd&apos; --project &apos;command-center&apos;" />',
    attrs: {
      projectName: "command-center",
      slug: "native-sdd",
      name: "Native SDD",
      revision: "3",
    },
  },
  {
    nodeName: "requirementMention",
    xml: '<requirement-ref project-name="command-center" slug="native-sdd" handle="R5" name="Unified references" revision="3" read-command="cctl spec get &apos;native-sdd/R5&apos; --project &apos;command-center&apos;" />',
    attrs: {
      projectName: "command-center",
      slug: "native-sdd",
      handle: "R5",
      name: "Unified references",
      revision: "3",
    },
  },
  {
    nodeName: "decisionMention",
    xml: '<decision-ref project-name="command-center" slug="native-sdd" handle="D2" name="Immutable approved revisions" revision="3" read-command="cctl spec get &apos;native-sdd/D2&apos; --project &apos;command-center&apos;" />',
    attrs: {
      projectName: "command-center",
      slug: "native-sdd",
      handle: "D2",
      name: "Immutable approved revisions",
      revision: "3",
    },
  },
  {
    nodeName: "taskMention",
    xml: '<task-ref project-name="command-center" slug="native-sdd" handle="T15" name="Unified picker" revision="3" read-command="cctl spec get &apos;native-sdd/T15&apos; --project &apos;command-center&apos;" />',
    attrs: {
      projectName: "command-center",
      slug: "native-sdd",
      handle: "T15",
      name: "Unified picker",
      revision: "3",
    },
  },
] as const;

const SPEC_REFERENCE_NODES = [
  SpecMentionNode,
  RequirementMentionNode,
  DecisionMentionNode,
  TaskMentionNode,
];

beforeEach(() => {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as unknown as DOMRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }
});

function createEditor(content: Parameters<typeof deserializePromptDoc>[0]) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [StarterKit, ...SPEC_REFERENCE_NODES, RefPasteHandler],
    content: deserializePromptDoc(content),
  });
}

function pasteEvent(text: string): ClipboardEvent {
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  return event;
}

function findNode(editor: Editor, nodeName: string): ProseMirrorNode | null {
  let found: ProseMirrorNode | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name === nodeName) found = node;
  });
  return found;
}

describe("spec reference nodes", () => {
  for (const fixture of SPEC_REFERENCE_FIXTURES) {
    it(`round-trips ${fixture.nodeName} through serialize and parse`, () => {
      const editor = createEditor({ prompt: fixture.xml, images: [] });

      expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe(
        fixture.nodeName,
      );
      expect(editor.state.doc.firstChild?.firstChild?.attrs).toMatchObject(
        fixture.attrs,
      );
      expect(
        serializePromptDoc({ doc: editor.state.doc, attachments: [] }).prompt,
      ).toBe(fixture.xml);

      editor.destroy();
    });

    it(`turns pasted ${fixture.nodeName} reference text into the matching chip`, () => {
      const editor = createEditor({ prompt: "", images: [] });
      editor.commands.focus("end");

      editor.view.pasteText(fixture.xml, pasteEvent(fixture.xml));

      expect(findNode(editor, fixture.nodeName)?.attrs).toMatchObject(
        fixture.attrs,
      );
      expect(
        serializePromptDoc({ doc: editor.state.doc, attachments: [] }).prompt,
      ).toBe(fixture.xml);

      editor.destroy();
    });
  }

  it("leaves a spec reference without an observed revision as plain text", () => {
    const malformed =
      '<spec-ref project-name="command-center" slug="native-sdd" name="Native SDD" read-command="cctl spec show native-sdd" />';
    const editor = createEditor({ prompt: "", images: [] });
    editor.commands.focus("end");

    editor.view.pasteText(malformed, pasteEvent(malformed));

    expect(findNode(editor, "specMention")).toBeNull();
    expect(editor.state.doc.textContent).toContain(malformed);
    editor.destroy();
  });
});
