/**
 * How a route guard and a loop's exit condition read on the run page and in
 * the template editor's structure: a schema's own title or description, else
 * the schema itself. Browser-safe.
 */
import type { RouteGuard } from "./schemas";

export function guardLabel(guard: RouteGuard): string {
  if ("else" in guard) return "else";
  return schemaLabel(guard.schema);
}

export function schemaLabel(schema: Record<string, unknown>): string {
  for (const field of ["title", "description"]) {
    const value = schema[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  const text = JSON.stringify(schema);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}
