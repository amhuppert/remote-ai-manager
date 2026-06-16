import { clsx, type ClassValue } from "clsx";

export type { ClassValue };

/**
 * Class-composition helper for the Tailwind UI primitive layer.
 *
 * A thin `clsx` wrapper: joins truthy class values (strings, arrays, and the
 * conditional/falsey forms `clsx` accepts) into one space-separated string.
 * `tailwind-merge` is intentionally NOT layered on top — primitives compose
 * appearance utilities once and append `layoutClassName` (external geometry
 * only) last, so there is no conflicting-override case to resolve (decision 5 /
 * YAGNI). Add `tailwind-merge` only when a real override conflict appears.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
