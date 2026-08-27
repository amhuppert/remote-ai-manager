/**
 * Registry-free tag scanning for the inline self-closing reference tags the
 * prompt-editor serializer emits.
 *
 * Split from `ref-parser` so server-only callers (prompt injection) can scan
 * for one known tag without importing `REFERENCE_REGISTRY`, which pulls React
 * chip components and Tiptap node classes into the module graph — a server
 * route that reaches them fails page-data collection at build time.
 *
 * Refs inside triple-backtick or triple-tilde fenced code blocks are skipped
 * — those represent literal code shown to the reader, not link targets.
 */

import { decodeXmlEntities } from "@/lib/shared/xml";

export interface FoundRef {
  start: number;
  end: number;
  raw: string;
  attrs: Record<string, string>;
}

const ATTR_REGEX = /([a-z][a-z-]*)="([^"]*)"/g;

export function findRefTags(text: string, tagName: string): FoundRef[] {
  const tagRegex = new RegExp(`<${tagName}(?:\\s+[a-z-]+="[^"]*")+\\s*/>`, "g");
  const fencedRanges = findFencedCodeRanges(text);
  const result: FoundRef[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (isInsideAnyRange(start, fencedRanges)) continue;
    result.push({
      start,
      end,
      raw: match[0],
      attrs: parseRefAttrs(match[0]),
    });
  }
  return result;
}

export function parseRefAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = new RegExp(ATTR_REGEX.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1] ?? "";
    const value = m[2] ?? "";
    out[name] = decodeXmlEntities(value);
  }
  return out;
}

interface Range {
  start: number;
  end: number;
}

function findFencedCodeRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const lines = text.split("\n");
  let openFence: "```" | "~~~" | null = null;
  let openStart = 0;
  let charPos = 0;
  for (const line of lines) {
    const lineLen = line.length + 1; // include trailing \n in offset
    const trimmed = line.trimStart();
    if (openFence === null) {
      if (trimmed.startsWith("```")) {
        openFence = "```";
        openStart = charPos;
      } else if (trimmed.startsWith("~~~")) {
        openFence = "~~~";
        openStart = charPos;
      }
    } else if (trimmed.startsWith(openFence)) {
      ranges.push({ start: openStart, end: charPos + lineLen });
      openFence = null;
    }
    charPos += lineLen;
  }
  if (openFence !== null) {
    ranges.push({ start: openStart, end: text.length });
  }
  return ranges;
}

function isInsideAnyRange(pos: number, ranges: Range[]): boolean {
  for (const r of ranges) {
    if (pos >= r.start && pos < r.end) return true;
  }
  return false;
}
