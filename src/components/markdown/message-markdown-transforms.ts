import {
  segmentTextByRefs,
  type RefSegment,
} from "@/lib/conversations/ref-segments";
import { findRegisteredRefs } from "@/lib/conversations/ref-parser";
import { getReferenceByType } from "@/lib/prompt-editor/reference-registry";

/** A validated transcript reference carried from Markdown to its React chip. */
export const MESSAGE_REF_TAG_PROPERTY = "dataCcMessageRefTag";
export const MESSAGE_REF_ATTRS_PROPERTY = "dataCcMessageRefAttrs";

interface ParentNode extends Record<string, unknown> {
  children: unknown[];
}

interface CreatedNode {
  type: string;
  value?: string;
  children?: CreatedNode[];
  data?: {
    hName: string;
    hProperties: Record<string, string>;
  };
}

const FLOW_PARENT_TYPES = new Set([
  "root",
  "blockquote",
  "listItem",
  "footnoteDefinition",
]);

// A one-character replacement keeps source positions stable and stops a tag at
// column zero from starting a CommonMark HTML block that swallows later lists.
const BLOCK_REF_MARKER = "\uE000";

export function protectBlockOpeningMessageRefs(source: string): string {
  let prepared = source;
  for (const ref of findRegisteredRefs(source)) {
    const lineStart = source.lastIndexOf("\n", ref.start - 1) + 1;
    const prefix = source.slice(lineStart, ref.start);
    if (!/^ {0,3}$/.test(prefix)) continue;
    if (isInsideHtmlComment(source, ref.start)) continue;
    if (isInsideCodeSpan(source, ref.start)) continue;
    if (
      !getReferenceByType(ref.type).attrsSchema.safeParse(ref.attrs).success
    ) {
      continue;
    }
    prepared =
      prepared.slice(0, ref.start) +
      BLOCK_REF_MARKER +
      prepared.slice(ref.start + 1);
  }
  return prepared;
}

function isInsideHtmlComment(source: string, offset: number): boolean {
  return source.lastIndexOf("<!--", offset) > source.lastIndexOf("-->", offset);
}

function isInsideCodeSpan(source: string, offset: number): boolean {
  const runs = /`+/g;
  let opening: RegExpExecArray | null;
  while ((opening = runs.exec(source)) && opening.index < offset) {
    const closingRuns = /`+/g;
    closingRuns.lastIndex = opening.index + opening[0].length;
    let closing: RegExpExecArray | null;
    while ((closing = closingRuns.exec(source))) {
      if (closing[0].length !== opening[0].length) continue;
      if (offset < closing.index + closing[0].length) return true;
      runs.lastIndex = closing.index + closing[0].length;
      break;
    }
  }
  return false;
}

/**
 * Replace valid reference XML inside the Markdown tree. Rendering the chips
 * here preserves the paragraph, list, and emphasis around each reference.
 * Code is childless in mdast, so examples in code remain literal.
 */
export function remarkMessageRefs() {
  return (tree: unknown): void => {
    if (isParentNode(tree)) transformChildren(tree);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isParentNode(value: unknown): value is ParentNode {
  return isRecord(value) && Array.isArray(value["children"]);
}

function transformChildren(parent: ParentNode): void {
  const parentType = parent["type"];
  if (
    parentType === "link" ||
    parentType === "linkReference" ||
    parentType === "image" ||
    parentType === "imageReference"
  ) {
    return;
  }
  const isFlowParent =
    typeof parentType === "string" && FLOW_PARENT_TYPES.has(parentType);
  const next: unknown[] = [];

  for (const child of parent.children) {
    if (!isRecord(child)) {
      next.push(child);
      continue;
    }

    const type = child["type"];
    const value = child["value"];
    if (type === "html" && typeof value === "string") {
      const segments = segmentTextByRefs(value);
      if (
        segments.length === 1 &&
        segments[0]?.type !== "text" &&
        segments[0]?.raw === value
      ) {
        const nodes = segmentsToNodes(segments);
        next.push(
          ...(isFlowParent
            ? [
                {
                  type: "paragraph",
                  children: nodes,
                  position: child["position"],
                },
              ]
            : nodes),
        );
        continue;
      }
    }

    if (
      type === "text" &&
      typeof value === "string" &&
      value.includes(BLOCK_REF_MARKER)
    ) {
      const segments = markedSegments(value);
      if (segments.some((segment) => segment.type !== "text")) {
        const nodes = segmentsToNodes(segments);
        next.push(
          ...(isFlowParent
            ? [
                {
                  type: "paragraph",
                  children: nodes,
                  position: child["position"],
                },
              ]
            : nodes),
        );
        continue;
      }
    }

    if (isParentNode(child)) transformChildren(child);
    next.push(child);
  }

  parent.children = next;
}

function markedSegments(value: string): RefSegment[] {
  const restored = value.replaceAll(BLOCK_REF_MARKER, "<");
  const segments = segmentTextByRefs(restored);
  const marked: RefSegment[] = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.type === "text") {
      marked.push(segment);
      cursor += segment.text.length;
      continue;
    }
    if (value[cursor] === BLOCK_REF_MARKER) {
      marked.push(segment);
    } else {
      marked.push({ type: "text", text: segment.raw });
    }
    cursor += segment.raw.length;
  }
  return marked;
}

function segmentsToNodes(segments: RefSegment[]): CreatedNode[] {
  const nodes: CreatedNode[] = [];
  for (const segment of segments) {
    if (segment.type === "text") {
      if (segment.text) nodes.push({ type: "text", value: segment.text });
      continue;
    }
    nodes.push({
      type: "messageRefChip",
      children: [],
      data: {
        hName: "span",
        hProperties: {
          [MESSAGE_REF_TAG_PROPERTY]: segment.type,
          [MESSAGE_REF_ATTRS_PROPERTY]: JSON.stringify(segment.attrs),
        },
      },
    });
  }
  return nodes;
}
