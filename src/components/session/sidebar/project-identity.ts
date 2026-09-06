export function projectIdentity(name: string): {
  initials: string;
  colorIndex: number;
} {
  const words =
    name.replace(/([a-z])([A-Z])/g, "$1 $2").match(/[\p{L}\p{N}]+/gu) ?? [];
  const initials =
    words.length > 1
      ? `${Array.from(words[0]!)[0]}${Array.from(words[1]!)[0]}`
      : Array.from(words[0] ?? "?")
          .slice(0, 2)
          .join("");
  let hash = 0;
  for (const char of name.trim().toLowerCase()) {
    hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  }
  return { initials: initials.toUpperCase(), colorIndex: hash % 4 };
}
