import type { Element, Nodes, Root } from "hast";
import { visit } from "unist-util-visit";

const STAMPED_BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "ul",
  "ol",
  "li",
  "pre",
  "table",
  "hr",
  "img",
]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export const CC_LINE_ATTR = "data-cc-line";
export const CC_SECTION_ATTR = "data-cc-section";
export const CC_HEADING_ATTR = "data-cc-heading";

export interface BlockMeta {
  sectionId: string;
  headingLabel: string;
  line: number;
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function collectText(node: Nodes): string {
  switch (node.type) {
    case "text":
      return node.value;
    case "element":
    case "root":
      return node.children.map(collectText).join("");
    default:
      return "";
  }
}

/** Stamps rendered blocks with their source line and nearest heading. */
export function rehypeStampSourcePosition() {
  return (tree: Root): void => {
    let currentSection = "";
    let currentHeading = "";
    const slugCounts = new Map<string, number>();

    visit(tree, (node) => {
      if (node.type !== "element") return;
      const element: Element = node;

      if (HEADING_TAGS.has(element.tagName)) {
        const label = collectText(element).trim();
        const baseSlug = slugifyHeading(label) || "section";
        const seen = slugCounts.get(baseSlug) ?? 0;
        slugCounts.set(baseSlug, seen + 1);
        currentSection = seen === 0 ? baseSlug : `${baseSlug}-${seen}`;
        currentHeading = label;
      }

      if (!STAMPED_BLOCK_TAGS.has(element.tagName)) return;

      const line = element.position?.start.line;
      if (typeof line === "number") {
        element.properties[CC_LINE_ATTR] = String(line);
      }
      element.properties[CC_SECTION_ATTR] = currentSection;
      element.properties[CC_HEADING_ATTR] = currentHeading;
    });
  };
}

function nearestStampedBlock(
  node: Node | null | undefined,
): HTMLElement | null {
  if (node == null) return null;

  let element: HTMLElement | null =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;

  while (element && !element.hasAttribute(CC_LINE_ATTR)) {
    element = element.parentElement;
  }
  return element;
}

function blockMetaFromElement(element: HTMLElement): BlockMeta | null {
  const lineValue = element.getAttribute(CC_LINE_ATTR);
  const line = lineValue === null ? Number.NaN : Number.parseInt(lineValue, 10);
  if (!Number.isInteger(line)) return null;

  return {
    sectionId: element.getAttribute(CC_SECTION_ATTR) ?? "",
    headingLabel: element.getAttribute(CC_HEADING_ATTR) ?? "",
    line,
  };
}

export function resolveBlockMeta(
  node: Node | null | undefined,
): BlockMeta | null {
  const element = nearestStampedBlock(node);
  return element ? blockMetaFromElement(element) : null;
}

export function resolveSelectionBlock(range: Range): HTMLElement | null {
  const startBlock = nearestStampedBlock(range.startContainer);
  if (!startBlock) return null;

  const endBlock = nearestStampedBlock(range.endContainer);
  return endBlock === startBlock ? startBlock : null;
}

export function resolveSelectionMeta(range: Range): BlockMeta | null {
  const block = resolveSelectionBlock(range);
  return block ? blockMetaFromElement(block) : null;
}
