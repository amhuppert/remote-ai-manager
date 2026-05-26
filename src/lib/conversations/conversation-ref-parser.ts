/**
 * Detect and parse inline `<conversation-ref ... />` tags emitted by the
 * prompt-editor serializer.
 *
 * Refs inside triple-backtick or triple-tilde fenced code blocks are skipped
 * — those represent literal code shown to the reader, not link targets.
 */

export interface FoundConversationRef {
  start: number;
  end: number;
  raw: string;
  attrs: Record<string, string>;
}

const TAG_REGEX = /<conversation-ref(?:\s+[a-z-]+="[^"]*")+\s*\/>/g;
const ATTR_REGEX = /([a-z][a-z-]*)="([^"]*)"/g;

export function findConversationRefs(text: string): FoundConversationRef[] {
  const fencedRanges = findFencedCodeRanges(text);
  const result: FoundConversationRef[] = [];
  const re = new RegExp(TAG_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (isInsideAnyRange(start, fencedRanges)) continue;
    result.push({
      start,
      end,
      raw: match[0],
      attrs: parseConversationRefAttrs(match[0]),
    });
  }
  return result;
}

export function parseConversationRefAttrs(raw: string): Record<string, string> {
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

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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
