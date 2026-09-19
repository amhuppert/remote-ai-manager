export function buildCodexConfigArgs(
  config: Record<string, unknown> = {},
): string[] {
  // Codex splits CLI key paths on literal dots; it does not parse quoted TOML
  // path segments. Put plugin/server names in values instead. Its config layer
  // merge preserves inherited table siblings under these process overrides.
  const args: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    args.push("-c", `${key}=${tomlValue(value, key)}`);
  }
  return args;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlValue(value: unknown, path: string): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) =>
      tomlValue(item, `${path}[${index}]`),
    );
    return `[${items.join(", ")}]`;
  }
  if (isTable(value)) {
    const fields = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(
        ([key, child]) =>
          `${tomlKey(key)} = ${tomlValue(child, `${path}.${key}`)}`,
      );
    return `{${fields.join(", ")}}`;
  }
  throw new Error(`Unsupported Codex config override value at ${path}`);
}
