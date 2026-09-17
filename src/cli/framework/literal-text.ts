/** Quote domain prose so terminal controls and protocol examples remain evidence. */
export function quoteLiteralText(value: string): string {
  // The library reserves these line prefixes; safe prose remains byte-identical.
  const protocolLine =
    /(?:^|\n)\s*(?:hint|reminder|instruction|error|issue|why|doctor(?: argv)?|continuation(?: argv)?|secondary|effect|recovery|details|artifact):/i;
  if (
    !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value.replaceAll("\n", "")) &&
    !protocolLine.test(value)
  )
    return value;
  return value
    .replace(/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, (character) =>
      character === "\n"
        ? character
        : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .split("\n")
    .map((line) => `| ${line}`)
    .join("\n");
}
