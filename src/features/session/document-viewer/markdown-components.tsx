import type { Components } from "react-markdown";
import type { Element, Nodes, Root } from "hast";
import { visit } from "unist-util-visit";
import { cn } from "@/lib/ui/cn";
import MarkdownLink from "@/components/MarkdownLink";

/**
 * Shared markdown-viewer render extensions: the decorative chevron list marker,
 * a rehype step that stamps every rendered block with its source line and
 * nearest-heading section, and the resolver that reads those stamps back from a
 * DOM selection. These are injected into the shared `MarkdownViewer` (which
 * stays generic) by the document-viewer surfaces and the annotated renderer, so
 * commenting can map a selection to a precise single-block source reference.
 *
 * The chevron is rendered as a React element (not a CSS pseudo) per the design;
 * it is `aria-hidden` and non-selectable so it never lands inside a commented
 * quote.
 */

/** Block-level tags that carry a source-position stamp for selection anchoring. */
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

/** Data attributes stamped on each block and read back by the resolver. */
export const CC_LINE_ATTR = "data-cc-line";
export const CC_SECTION_ATTR = "data-cc-section";
export const CC_HEADING_ATTR = "data-cc-heading";
export const CC_BULLET_ATTR = "data-cc-bullet";

/** Source-block reference resolved from a selection for comment anchoring. */
export interface BlockMeta {
  /** Nearest-heading slug of the block (empty before the first heading). */
  sectionId: string;
  /** Human-facing nearest-heading label (empty before the first heading). */
  headingLabel: string;
  /** 1-based source line of the block. */
  line: number;
}

/**
 * Deterministic, url-safe heading slug used as a stable section id. Pure and
 * isomorphic so the rehype stamp and any later consumer agree on the same id.
 */
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

/**
 * Rehype plugin: stamp every rendered block with its 1-based source line and
 * the nearest preceding heading's section id + label, and flag unordered list
 * items so the chevron renderer can decorate only those. Section ids are
 * de-duplicated by slug so repeated headings stay distinct.
 */
export function rehypeStampSourcePosition() {
  return (tree: Root): void => {
    let currentSection = "";
    let currentHeading = "";
    const slugCounts = new Map<string, number>();

    visit(tree, (node, _index, parent) => {
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

      if (
        element.tagName === "li" &&
        parent?.type === "element" &&
        parent.tagName === "ul"
      ) {
        element.properties[CC_BULLET_ATTR] = "true";
      }
    });
  };
}

const ChevronListItem: NonNullable<Components["li"]> =
  function ChevronListItem({ node, children, className, ...props }) {
    const isBullet = node?.properties?.[CC_BULLET_ATTR] === "true";
    if (!isBullet) {
      return (
        <li className={className} {...props}>
          {children}
        </li>
      );
    }
    return (
      <li className={cn("flex gap-[9px] leading-[1.7]", className)} {...props}>
        {/* `not-annotatable` keeps the chevron out of recogito's text-offset model
          (and `select-none` out of user selections) so it never lands in a quote. */}
        <span
          aria-hidden="true"
          className="not-annotatable shrink-0 font-bold text-cyan select-none"
        >
          {"›"}
        </span>
        <span className="min-w-0 flex-1">{children}</span>
      </li>
    );
  };

/**
 * Render extensions injected into the shared `MarkdownViewer` for the document
 * viewer: only the chevron list item is overridden here (the viewer keeps its
 * own link + Mermaid-aware code renderers as defaults). Pair with
 * `rehypeStampSourcePosition` so selections resolve to a source block.
 */
export const markdownViewerComponents: Components = {
  a: MarkdownLink,
  li: ChevronListItem,
};

function nearestStampedBlock(
  node: Node | null | undefined,
): HTMLElement | null {
  if (node == null) return null;
  let el: HTMLElement | null =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;
  while (el && !el.hasAttribute(CC_LINE_ATTR)) {
    el = el.parentElement;
  }
  return el;
}

function blockMetaFromElement(el: HTMLElement): BlockMeta | null {
  const lineRaw = el.getAttribute(CC_LINE_ATTR);
  const line = lineRaw === null ? Number.NaN : Number.parseInt(lineRaw, 10);
  if (!Number.isInteger(line)) return null;
  return {
    sectionId: el.getAttribute(CC_SECTION_ATTR) ?? "",
    headingLabel: el.getAttribute(CC_HEADING_ATTR) ?? "",
    line,
  };
}

/**
 * Resolve the section/heading/line of the stamped block containing `node`, or
 * null when `node` is detached from any stamped block.
 */
export function resolveBlockMeta(
  node: Node | null | undefined,
): BlockMeta | null {
  const el = nearestStampedBlock(node);
  return el ? blockMetaFromElement(el) : null;
}

/**
 * Resolve the single stamped block a selection lies within, or null when the
 * selection's start and end fall in different blocks (cross-block selections are
 * rejected — single-block anchor scope) or no stamped block contains it.
 */
export function resolveSelectionBlock(range: Range): HTMLElement | null {
  const startBlock = nearestStampedBlock(range.startContainer);
  if (!startBlock) return null;
  const endBlock = nearestStampedBlock(range.endContainer);
  return endBlock === startBlock ? startBlock : null;
}

/**
 * Resolve a selection's single source block meta (section/heading/line), or null
 * for a cross-block or unanchored selection.
 */
export function resolveSelectionMeta(range: Range): BlockMeta | null {
  const block = resolveSelectionBlock(range);
  return block ? blockMetaFromElement(block) : null;
}
