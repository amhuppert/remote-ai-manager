/**
 * The notepad image token — the id-addressed form `[Image: <image-id>]` that
 * canonical notepad text stores for an embedded image. The id names a
 * `notepad_images` row, so the token survives every edit unchanged and is the
 * stable placeholder agents see. Deliberately distinct from the prompt
 * editor's positional `[Image #N]` marker, which renumbers as images move.
 */

export interface FoundNotepadImageToken {
  imageId: string;
  start: number;
  end: number;
  raw: string;
}

const NOTEPAD_IMAGE_TOKEN_RE = /\[Image: ([^\s\]]+)\]/g;

export function buildNotepadImageToken(imageId: string): string {
  return `[Image: ${imageId}]`;
}

/** Find every well-formed token with its offsets, in document order. */
export function findNotepadImageTokens(text: string): FoundNotepadImageToken[] {
  const found: FoundNotepadImageToken[] = [];
  for (const match of text.matchAll(NOTEPAD_IMAGE_TOKEN_RE)) {
    found.push({
      imageId: match[1] ?? "",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
    });
  }
  return found;
}
