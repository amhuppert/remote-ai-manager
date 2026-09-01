export function normalizedBoundedPreview(
  value: string,
  characterLimit: number,
): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= characterLimit) {
    return normalized;
  }
  return `${characters.slice(0, characterLimit - 1).join("")}…`;
}
