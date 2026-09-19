export interface SkillReference {
  name: string;
  path: string;
}

export interface LocatedSkillReference extends SkillReference {
  start: number;
  end: number;
}

export function renderSkillReference(name: string, path: string): string {
  const encodedPath = encodeURIComponent(path)
    .replace(/%2F/g, "/")
    .replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  return `[$${name.replace(/^\$/, "")}](<${encodedPath}>)`;
}

/** Read explicit selections without interpreting skill-like examples in code. */
export function findSkillReferences(text: string): LocatedSkillReference[] {
  const references: LocatedSkillReference[] = [];
  const tokens =
    /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$|`+|\[\$([^\]\s]+)\]\(<([^\s<>]+)>\)/gm;
  let fence: string | undefined;
  let inlineCodeEnd = -1;

  for (const token of text.matchAll(tokens)) {
    const start = token.index;
    if (start < inlineCodeEnd) continue;
    const fenceMarker = token[1];
    if (fenceMarker) {
      if (fence) {
        if (
          fenceMarker[0] === fence[0] &&
          fenceMarker.length >= fence.length &&
          !token[2]?.trim()
        ) {
          fence = undefined;
        }
      } else if (fenceMarker[0] !== "`" || !token[2]?.includes("`")) {
        fence = fenceMarker;
      }
      continue;
    }
    if (fence || isEscaped(text, start)) continue;
    if (token[0].startsWith("`")) {
      const closingTicks = /`+/g;
      closingTicks.lastIndex = start + token[0].length;
      let closing: RegExpExecArray | null;
      while ((closing = closingTicks.exec(text))) {
        if (closing[0].length === token[0].length) {
          inlineCodeEnd = closing.index + closing[0].length;
          break;
        }
      }
      continue;
    }
    const name = token[3];
    const encodedPath = token[4];
    if (!name || !encodedPath || text[start - 1] === "!") continue;
    try {
      references.push({
        name,
        path: decodeURIComponent(encodedPath),
        start,
        end: start + token[0].length,
      });
    } catch {
      // Malformed URI syntax stays plain text rather than changing identity.
    }
  }
  return references;
}

export function parseSkillReferences(text: string): SkillReference[] {
  return findSkillReferences(text).map(({ name, path }) => ({ name, path }));
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  while (text[index - backslashes - 1] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
}
