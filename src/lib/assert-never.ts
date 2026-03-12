/**
 * Exhaustive type check helper.
 *
 * Call in the `default` branch of a switch (or after an if/else chain) that
 * handles every member of a union/enum.  TypeScript narrows the value to
 * `never` when all cases are covered — if a new member is added and not
 * handled, the compiler will report an error at this call site.
 *
 * @example
 * ```ts
 * type Status = "active" | "inactive";
 *
 * function label(s: Status): string {
 *   switch (s) {
 *     case "active":  return "Active";
 *     case "inactive": return "Inactive";
 *     default: return assertNever(s);
 *   }
 * }
 * ```
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${JSON.stringify(value)}`);
}
