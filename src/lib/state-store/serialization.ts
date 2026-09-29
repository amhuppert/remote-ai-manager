import { stableStringify } from "@/lib/shared/stable-stringify";

export function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return stableStringify(value);
}
