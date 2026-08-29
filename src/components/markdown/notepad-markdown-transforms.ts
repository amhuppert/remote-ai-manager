import { type RefSegment } from "@/lib/conversations/ref-segments";
import {
  notepadValueParts,
  type NotepadValuePart,
} from "@/lib/notepads/content-parts";
import { notepadImageUrl } from "@/lib/notepads/image-client";

/**
 * Remark plugin that renders canonical notepad text: registered reference XML
 * becomes chip elements and `[Image: <id>]` tokens become image elements — as
 * in-place mdast replacements, so surrounding block structure (headings, list
 * items, blockquotes) survives intact. This is deliberately NOT the
 * pre-segmentation approach of `MessageTextWithRefs`, whose documented
 * limitation is that a ref splits block-level markdown at its boundary.
 *
 * The custom nodes lean on mdast-util-to-hast's unknown-node handling: a node
 * carrying `data.hName`/`data.hProperties` becomes that element, so no
 * raw-HTML parsing (which treats unknown self-closing tags as open tags) is
 * involved anywhere.
 */

/** hast property carrying the ref's registry xml tag on a chip element. */
export const NOTEPAD_REF_TAG_PROPERTY = "dataCcRefTag";
/** hast property carrying the ref's schema-validated attrs as JSON. */
export const NOTEPAD_REF_ATTRS_PROPERTY = "dataCcRefAttrs";
/** hast property carrying the image id of a notepad image element. */
export const NOTEPAD_IMAGE_ID_PROPERTY = "dataNotepadImageId";

export interface NotepadContentOptions {
  /** Owner of the embedded images; ids in tokens resolve against its routes. */
  notepadId: string;
}

/**
 * Structural mdast shapes: the tree arrives as `unknown` from unified, and the
 * exact mdast types live in a transitive package, so nodes are narrowed at
 * runtime instead of imported nominally.
 */
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

/**
 * Contexts whose children are flow (block) content. A ref tag alone between
 * blank lines parses as a flow `html` node there, and its phrasing
 * replacements need a paragraph wrapper to remain a valid block child.
 */
const FLOW_PARENT_TYPES = new Set([
  "root",
  "blockquote",
  "listItem",
  "footnoteDefinition",
]);

export function remarkNotepadContent(options: NotepadContentOptions) {
  return (tree: unknown): void => {
    if (isParentNode(tree)) {
      transformChildren(tree, options.notepadId);
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isParentNode(node: unknown): node is ParentNode {
  return isRecord(node) && Array.isArray(node["children"]);
}

/**
 * Fence and inline-code safety is structural: `code` and `inlineCode` are
 * childless literals, so the walk never reaches text inside them and a ref or
 * token typed there stays literal.
 */
function transformChildren(parent: ParentNode, notepadId: string): void {
  const parentType = parent["type"];
  const wrapReplacements =
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
      const parts = notepadValueParts("html", value);
      if (parts.some((part) => part.type !== "text")) {
        const inline = partsToNodes(parts, notepadId);
        if (wrapReplacements) {
          // The wrapper inherits the replaced node's source position so the
          // block still stamps the canonical line a comment anchors to.
          next.push({
            type: "paragraph",
            children: inline,
            position: child["position"],
          });
        } else {
          next.push(...inline);
        }
        continue;
      }
      next.push(child);
      continue;
    }

    if (type === "text" && typeof value === "string") {
      const parts = notepadValueParts("text", value);
      if (parts.some((part) => part.type !== "text")) {
        next.push(...partsToNodes(parts, notepadId));
        continue;
      }
    }

    if (isParentNode(child)) {
      transformChildren(child, notepadId);
    }
    next.push(child);
  }

  parent.children = next;
}

function chipNode(segment: Exclude<RefSegment, { type: "text" }>): CreatedNode {
  return {
    type: "notepadRefChip",
    children: [],
    data: {
      hName: "span",
      hProperties: {
        [NOTEPAD_REF_TAG_PROPERTY]: segment.type,
        [NOTEPAD_REF_ATTRS_PROPERTY]: JSON.stringify(segment.attrs),
      },
    },
  };
}

function partsToNodes(
  parts: NotepadValuePart[],
  notepadId: string,
): CreatedNode[] {
  const nodes: CreatedNode[] = [];
  for (const part of parts) {
    if (part.type === "ref") {
      nodes.push(chipNode(part.segment));
    } else if (part.type === "image") {
      nodes.push(imageNode(part.imageId, notepadId));
    } else if (part.text !== "") {
      nodes.push({ type: "text", value: part.text });
    }
  }
  return nodes;
}

function imageNode(imageId: string, notepadId: string): CreatedNode {
  return {
    type: "notepadImage",
    children: [],
    data: {
      hName: "img",
      hProperties: {
        src: notepadImageUrl(notepadId, imageId),
        alt: "Pasted image",
        [NOTEPAD_IMAGE_ID_PROPERTY]: imageId,
      },
    },
  };
}
