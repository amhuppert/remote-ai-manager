import type { Element, Nodes, Root } from "hast";
import { decodeString } from "micromark-util-decode-string";
import remarkRehype from "remark-rehype";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
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

export interface MarkdownSourceSpan {
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * The parser the renderers parse through. `remark-breaks` is deliberately
 * absent: it is a transformer (which `parse` does not run) and its node
 * rewriting discards the source positions this contract is built from, while
 * the newline it replaces still costs its one character in the rendered text —
 * `mdast-util-to-hast` emits a literal newline beside every `<br>` — so leaving
 * it out cannot shift an offset.
 */
const sourceParser = unified().use(remarkParse).use(remarkGfm);

/**
 * Where a dialect's replaced tokens sit in the Markdown SOURCE.
 *
 * A renderer that swaps tokens for elements (reference chips, embedded images)
 * makes the source and the rendered text two different coordinate spaces, and
 * anything mapping between them — comment anchors, most of all — has to know
 * exactly which source characters the rendering hid. Only a parse can answer
 * that: a dialect transform walks mdast, where `code` and `inlineCode` are
 * childless literals it never enters, so a token typed inside a code span or
 * fence stays literal, visible text. A regex over the raw string cannot see
 * that distinction and would hide characters the reader can still select.
 *
 * The parse and the node positions are this module's; which characters inside
 * a literal are replaced belongs to the dialect, so `hiddenSpansOfValue`
 * supplies it — offsets relative to the value it is handed.
 *
 * Spans come back in document order, non-overlapping.
 */
export function markdownTokenSourceSpans(
  text: string,
  hiddenSpansOfValue: (
    nodeType: "html" | "text",
    value: string,
  ) => readonly MarkdownSourceSpan[],
): MarkdownSourceSpan[] {
  const spans: MarkdownSourceSpan[] = [];

  visit(sourceParser.parse(text), (node) => {
    if (node.type !== "html" && node.type !== "text") return;
    const offset = node.position?.start.offset;
    if (offset === undefined) return;
    // Escapes and character references make a text node's value differ from
    // its source, which would put every offset below off by their difference.
    // Leaving such a node unspanned costs a refusal, never a wrong anchor.
    if (text.slice(offset, offset + node.value.length) !== node.value) return;

    for (const span of hiddenSpansOfValue(node.type, node.value)) {
      spans.push({ start: offset + span.start, end: offset + span.end });
    }
  });

  return spans.sort((left, right) => left.start - right.start);
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

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeStampSourcePosition);

interface TextRun {
  owner: Element;
  text: string;
  positions: (MarkdownSourceSpan | null)[];
}

export interface MarkdownPassageProjection {
  sectionId: string;
  endSectionId: string;
  text: string;
  /** Absolute source coordinates; synthetic block separators have no source. */
  positions: (MarkdownSourceSpan | null)[];
  sourceStart: number;
  sourceEnd: number;
}

/**
 * Source coordinates for rendered literal text. Node positions bound each
 * search, so repeated text elsewhere in the document can never capture an
 * endpoint. Lines are mapped separately because blockquote and indented-code
 * markers exist in source between rendered lines.
 */
function literalPositions(
  text: string,
  content: string,
  start: number | undefined,
  end: number | undefined,
  decode = true,
): (MarkdownSourceSpan | null)[] {
  const unmapped = (): null[] =>
    Array.from({ length: text.length }, () => null);
  if (start === undefined || end === undefined) return unmapped();
  const raw = content.slice(start, end);
  const sourcePositions: MarkdownSourceSpan[] = [];
  let source = "";
  const append = (value: string, offset: number, width: number): void => {
    source += value;
    for (let index = 0; index < value.length; index++) {
      sourcePositions.push({
        start: start + offset,
        end: start + offset + width,
      });
    }
  };
  const tokens = /\\.|&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/g;
  let rawOffset = 0;
  for (const match of decode ? raw.matchAll(tokens) : []) {
    for (; rawOffset < match.index; rawOffset++)
      append(raw[rawOffset] ?? "", rawOffset, 1);
    const value = decodeString(match[0]);
    if (value === match[0]) {
      for (let index = 0; index < value.length; index++)
        append(value[index] ?? "", rawOffset + index, 1);
    } else {
      append(value, rawOffset, match[0].length);
    }
    rawOffset += match[0].length;
  }
  for (; rawOffset < raw.length; rawOffset++)
    append(raw[rawOffset] ?? "", rawOffset, 1);
  const positions: (MarkdownSourceSpan | null)[] = [];
  let cursor = 0;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const found = source.indexOf(line, cursor);
    if (found < cursor || found + line.length > source.length)
      return unmapped();
    for (let offset = 0; offset < line.length; offset++) {
      positions.push(sourcePositions[found + offset] ?? null);
    }
    cursor = found + line.length;
    if (index === lines.length - 1) continue;
    const newline = source.indexOf("\n", cursor);
    if (newline < 0) return unmapped();
    positions.push(sourcePositions[newline] ?? null);
    cursor = newline + 1;
  }
  return positions;
}

function lineOf(owner: Element): number {
  return Number(owner.properties[CC_LINE_ATTR]);
}

function hasStampedDescendant(element: Element): boolean {
  return element.children.some(
    (child) =>
      child.type === "element" &&
      (child.properties[CC_LINE_ATTR] !== undefined ||
        hasStampedDescendant(child)),
  );
}

function sourceLineStart(content: string, line: number): number {
  let offset = 0;
  for (let index = 1; index < line; index++) {
    const newline = content.indexOf("\n", offset);
    if (newline < 0) return content.length;
    offset = newline + 1;
  }
  return offset;
}

/**
 * The same stamped-block text stream the annotation DOM measures, projected
 * from Markdown source. Owner transitions contribute two newlines, independent
 * of the source's blank-line count. A position can be unavailable for generated
 * text; callers needing canonical endpoints must refuse those positions.
 */
export function projectMarkdownPassage(
  content: string,
  startLine: number,
  endLine: number,
  excluded: readonly MarkdownSourceSpan[] = [],
): MarkdownPassageProjection | null {
  const tree = parser.runSync(parser.parse(content));
  const runs: TextRun[] = [];

  const visit = (
    node: Nodes,
    owner: Element | null,
    literalCode = false,
  ): void => {
    if (node.type === "element") {
      const nextOwner =
        node.properties[CC_LINE_ATTR] === undefined ? owner : node;
      if (node.tagName === "pre") {
        const code = node.children.find(
          (child) => child.type === "element" && child.tagName === "code",
        );
        const literal = code?.type === "element" ? code.children[0] : undefined;
        if (literal?.type === "text" && nextOwner !== null) {
          const text = literal.value.replace(/\n$/, "");
          const start = node.position?.start.offset;
          const codeStart =
            start !== undefined &&
            /^ {0,3}(?:`{3,}|~{3,})/.test(content.slice(start))
              ? content.indexOf("\n", start) + 1
              : start;
          append(
            nextOwner,
            text,
            literalPositions(
              text,
              content,
              codeStart,
              node.position?.end.offset,
              false,
            ),
          );
          return;
        }
      }
      for (const child of node.children)
        visit(child, nextOwner, literalCode || node.tagName === "code");
      return;
    }
    if (node.type === "root") {
      for (const child of node.children) visit(child, owner);
      return;
    }
    if ((node.type !== "text" && node.type !== "raw") || owner === null) return;
    if (node.value.trim() === "" && hasStampedDescendant(owner)) return;
    const positions = literalPositions(
      node.value,
      content,
      node.position?.start.offset,
      node.position?.end.offset,
      !literalCode && node.type !== "raw",
    );
    append(owner, node.value, positions);
  };

  const append = (
    owner: Element,
    text: string,
    positions: (MarkdownSourceSpan | null)[],
  ): void => {
    let kept = "";
    const mapped: (MarkdownSourceSpan | null)[] = [];
    for (let index = 0; index < text.length; index++) {
      const position = positions[index] ?? null;
      if (
        position !== null &&
        excluded.some(
          (span) => position.start < span.end && position.end > span.start,
        )
      )
        continue;
      kept += text[index] ?? "";
      mapped.push(position);
    }
    if (kept === "") return;
    const previous = runs.at(-1);
    if (previous?.owner === owner) {
      previous.text += kept;
      previous.positions.push(...mapped);
      return;
    }
    runs.push({ owner, text: kept, positions: mapped });
  };

  visit(tree, null);
  const start = runs.findIndex((run) => lineOf(run.owner) === startLine);
  const end = runs.findLastIndex((run) => lineOf(run.owner) === endLine);
  if (start < 0 || end < start) return null;
  const selected = runs.slice(start, end + 1);
  const last = selected.at(-1);
  if (last === undefined) return null;
  const positions: (MarkdownSourceSpan | null)[] = [];
  for (const [index, run] of selected.entries()) {
    if (index > 0) positions.push(null, null);
    positions.push(...run.positions);
  }
  return {
    sectionId: String(selected[0]?.owner.properties[CC_SECTION_ATTR] ?? ""),
    endSectionId: String(last.owner.properties[CC_SECTION_ATTR] ?? ""),
    text: selected.map((run) => run.text).join("\n\n"),
    positions,
    sourceStart: sourceLineStart(content, startLine),
    sourceEnd: last.owner.position?.end.offset ?? content.length,
  };
}
