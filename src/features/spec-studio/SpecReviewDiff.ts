export type InlineReviewDiffKind = "unchanged" | "added" | "removed";

export interface InlineReviewDiffSegment {
  kind: InlineReviewDiffKind;
  text: string;
}

export function formatInlineReviewDiff(
  before: string | null,
  after: string | null,
): InlineReviewDiffSegment[] {
  if (before === after) {
    return before === null ? [] : [{ kind: "unchanged", text: before }];
  }
  if (before === null) {
    return after === null ? [] : [{ kind: "added", text: after }];
  }
  if (after === null) {
    return [{ kind: "removed", text: before }];
  }

  const beforeTokens = tokenize(before);
  const afterTokens = tokenize(after);
  let prefixLength = 0;
  while (
    prefixLength < beforeTokens.length &&
    prefixLength < afterTokens.length &&
    beforeTokens[prefixLength] === afterTokens[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < beforeTokens.length - prefixLength &&
    suffixLength < afterTokens.length - prefixLength &&
    beforeTokens[beforeTokens.length - suffixLength - 1] ===
      afterTokens[afterTokens.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const segments: InlineReviewDiffSegment[] = [];
  appendSegment(
    segments,
    "unchanged",
    beforeTokens.slice(0, prefixLength).join(""),
  );
  appendSegment(
    segments,
    "removed",
    beforeTokens
      .slice(prefixLength, beforeTokens.length - suffixLength)
      .join(""),
  );
  appendSegment(
    segments,
    "added",
    afterTokens.slice(prefixLength, afterTokens.length - suffixLength).join(""),
  );
  appendSegment(
    segments,
    "unchanged",
    beforeTokens.slice(beforeTokens.length - suffixLength).join(""),
  );
  return segments;
}

function tokenize(value: string): string[] {
  return value.match(/\S+\s*|\s+/g) ?? [];
}

function appendSegment(
  segments: InlineReviewDiffSegment[],
  kind: InlineReviewDiffKind,
  text: string,
): void {
  if (text.length === 0) return;
  segments.push({ kind, text });
}
