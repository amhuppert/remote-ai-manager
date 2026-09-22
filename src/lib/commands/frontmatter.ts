export interface FrontmatterResult {
  fields: Record<string, string>;
  body: string;
}

/**
 * Parse YAML frontmatter from markdown content.
 * Extracts key: value pairs between --- delimiters at the start.
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  if (!content.startsWith("---")) {
    return { fields: {}, body: content };
  }

  // Find the closing --- delimiter (must be on its own line)
  const closingIdx = content.indexOf("\n---", 3);
  if (closingIdx === -1) {
    return { fields: {}, body: content };
  }

  const frontmatterBlock = content.slice(4, closingIdx); // skip "---\n"
  const body = content.slice(closingIdx + 4).trimStart(); // skip "\n---"

  const fields: Record<string, string> = {};
  let blockKey: string | undefined;
  let blockSeparator = " ";
  for (const line of frontmatterBlock.split("\n")) {
    if (blockKey && /^\s/.test(line)) {
      fields[blockKey] = [fields[blockKey], line.trim()]
        .filter(Boolean)
        .join(blockSeparator);
      continue;
    }
    blockKey = undefined;
    if (/^\s*#/.test(line)) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (/^[>|][-+]?$/.test(value)) {
      blockKey = key;
      blockSeparator = value.startsWith("|") ? "\n" : " ";
      fields[key] = "";
      continue;
    }

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      fields[key] = value;
    }
  }

  return { fields, body };
}
// ============================================================
// Frontmatter Parser
// ============================================================
