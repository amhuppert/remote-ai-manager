import { z } from "zod";

/**
 * Production-only skip of Zod parsing for trusted internal Command Center state
 * — data that is always valid absent a bug. In production the value is returned
 * as-is; in every other environment (dev, test, CI, Storybook) it is fully
 * validated, so serialization drift is always caught before it can reach
 * production. The rationale and the two distinct safety justifications live in
 * `PERFORMANCE.md`.
 */

type OnInvalid = (issues: z.core.$ZodIssue[]) => never;

const trustedSchemaRegistry = new Map<z.ZodType, string>();

/**
 * Records `schema` as a trusted, effect-free schema eligible for `parseTrusted`.
 * Wrap a schema at its definition site so registration happens at module load,
 * before any read. Returns the schema unchanged. The effect-free guardrail
 * (`trusted-schemas.contract.test.ts`) iterates this registry, so every schema
 * routed through `parseTrusted` is proven effect-free at build time.
 */
export function registerTrustedSchema<T extends z.ZodType>(
  schema: T,
  name: string,
): T {
  trustedSchemaRegistry.set(schema, name);
  return schema;
}

export function getTrustedSchemaRegistry(): ReadonlyMap<z.ZodType, string> {
  return trustedSchemaRegistry;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function validateNonProduction<T extends z.ZodType>(
  schema: T,
  data: unknown,
  onInvalid: OnInvalid | undefined,
): z.infer<T> {
  if (onInvalid) {
    const result = schema.safeParse(data);
    if (!result.success) return onInvalid(result.error.issues);
    return result.data;
  }
  return schema.parse(data);
}

/**
 * First-parse of trusted state read from storage. In production returns `data`
 * as-is (the schema must be effect-free, so `parse(raw)` would deep-equal
 * `raw`). Outside production the schema is validated; an unregistered schema
 * throws so a new skip site cannot escape the effect-free guardrail.
 *
 * Pass `onInvalid` to keep a call site's existing failure idiom (e.g. logging +
 * `PersistenceError`); omit it to throw a `ZodError` on invalid data.
 */
export function parseTrusted<T extends z.ZodType>(
  schema: T,
  data: unknown,
  onInvalid?: OnInvalid,
): z.infer<T> {
  if (isProduction()) return data as z.infer<T>;
  if (!trustedSchemaRegistry.has(schema)) {
    throw new Error(
      "parseTrusted called with an unregistered schema; wrap its definition with registerTrustedSchema(schema, name) so the effect-free guardrail covers it.",
    );
  }
  return validateNonProduction(schema, data, onInvalid);
}

/**
 * Re-validation of already-canonical trusted state (whole-state assertion
 * sites). In production returns `data` as-is. Outside production it re-validates;
 * no registry check because the skip is safe by the caller's canonical-input
 * contract (the data already passed a first parse), not by effect-freedom — so
 * an effect-bearing schema is permitted here.
 */
export function revalidateTrusted<T extends z.ZodType>(
  schema: T,
  data: unknown,
  onInvalid?: OnInvalid,
): z.infer<T> {
  if (isProduction()) return data as z.infer<T>;
  return validateNonProduction(schema, data, onInvalid);
}
