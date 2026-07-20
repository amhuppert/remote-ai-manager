import { z } from "zod";

const CANONICAL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POSITIVE_COUNTER = "[1-9][0-9]*";
const REQUIREMENT_HANDLE = new RegExp(`^R(${POSITIVE_COUNTER})$`);
const CRITERION_HANDLE = new RegExp(
  `^R(${POSITIVE_COUNTER})\\.(${POSITIVE_COUNTER})$`,
);
const NUMBERED_HANDLE = new RegExp(`^([DTQA])(${POSITIVE_COUNTER})$`);

export const specSlugSchema = z.string().regex(CANONICAL_SLUG);
export type SpecSlug = z.infer<typeof specSlugSchema>;

const requirementHandleSchema = z.object({
  slug: specSlugSchema,
  kind: z.literal("requirement"),
  requirementNumber: z.number().int().positive(),
});

const criterionHandleSchema = z.object({
  slug: specSlugSchema,
  kind: z.literal("criterion"),
  requirementNumber: z.number().int().positive(),
  criterionNumber: z.number().int().positive(),
});

const numberedElementHandleSchema = z.discriminatedUnion("kind", [
  z.object({
    slug: specSlugSchema,
    kind: z.literal("decision"),
    number: z.number().int().positive(),
  }),
  z.object({
    slug: specSlugSchema,
    kind: z.literal("task"),
    number: z.number().int().positive(),
  }),
  z.object({
    slug: specSlugSchema,
    kind: z.literal("question"),
    number: z.number().int().positive(),
  }),
  z.object({
    slug: specSlugSchema,
    kind: z.literal("assumption"),
    number: z.number().int().positive(),
  }),
]);

export const parsedElementHandleSchema = z.union([
  requirementHandleSchema,
  criterionHandleSchema,
  numberedElementHandleSchema,
]);
export type ParsedElementHandle = z.infer<typeof parsedElementHandleSchema>;

export type HandleQualification = "qualified" | "bare";

export function parseSpecSlug(input: string): SpecSlug {
  const result = specSlugSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid spec slug: ${JSON.stringify(input)}`);
  }

  return result.data;
}

export function formatSpecSlug(slug: SpecSlug): string {
  return parseSpecSlug(slug);
}

export function parseElementHandle(
  input: string,
  contextSlug?: string,
): ParsedElementHandle {
  const separatorIndex = input.indexOf("/");
  const isQualified = separatorIndex !== -1;
  if (isQualified && separatorIndex !== input.lastIndexOf("/")) {
    throw new Error(`Invalid spec element handle: ${JSON.stringify(input)}`);
  }

  const slug = isQualified
    ? parseSpecSlug(input.slice(0, separatorIndex))
    : contextSlug === undefined
      ? undefined
      : parseSpecSlug(contextSlug);
  if (slug === undefined) {
    throw new Error(
      "A context slug is required for a bare spec element handle",
    );
  }

  const bareHandle = isQualified ? input.slice(separatorIndex + 1) : input;
  const criterionMatch = CRITERION_HANDLE.exec(bareHandle);
  if (criterionMatch !== null) {
    return criterionHandleSchema.parse({
      slug,
      kind: "criterion",
      requirementNumber: Number(criterionMatch[1]),
      criterionNumber: Number(criterionMatch[2]),
    });
  }

  const requirementMatch = REQUIREMENT_HANDLE.exec(bareHandle);
  if (requirementMatch !== null) {
    return requirementHandleSchema.parse({
      slug,
      kind: "requirement",
      requirementNumber: Number(requirementMatch[1]),
    });
  }

  const numberedMatch = NUMBERED_HANDLE.exec(bareHandle);
  if (numberedMatch === null) {
    throw new Error(`Invalid spec element handle: ${JSON.stringify(input)}`);
  }

  const number = Number(numberedMatch[2]);
  switch (numberedMatch[1]) {
    case "D":
      return numberedElementHandleSchema.parse({
        slug,
        kind: "decision",
        number,
      });
    case "T":
      return numberedElementHandleSchema.parse({ slug, kind: "task", number });
    case "Q":
      return numberedElementHandleSchema.parse({
        slug,
        kind: "question",
        number,
      });
    case "A":
      return numberedElementHandleSchema.parse({
        slug,
        kind: "assumption",
        number,
      });
    default:
      throw new Error(`Invalid spec element handle: ${JSON.stringify(input)}`);
  }
}

export function formatElementHandle(
  handle: ParsedElementHandle,
  qualification: HandleQualification = "qualified",
): string {
  const parsed = parsedElementHandleSchema.parse(handle);
  const bare = formatBareHandle(parsed);
  return qualification === "bare" ? bare : `${parsed.slug}/${bare}`;
}

export function toDeepLinkElementId(handle: ParsedElementHandle): string {
  return formatElementHandle(handle, "bare");
}

function formatBareHandle(handle: ParsedElementHandle): string {
  switch (handle.kind) {
    case "requirement":
      return `R${handle.requirementNumber}`;
    case "criterion":
      return `R${handle.requirementNumber}.${handle.criterionNumber}`;
    case "decision":
      return `D${handle.number}`;
    case "task":
      return `T${handle.number}`;
    case "question":
      return `Q${handle.number}`;
    case "assumption":
      return `A${handle.number}`;
  }
}

/** Structural slice of a spec element needed to compute a criterion handle. */
export interface CriterionHandleElement {
  kind: string;
  number: number | null;
  parentElementId: string | null;
}

/**
 * Compute a criterion's bare handle (R<req>.<crit>) from durable element rows.
 * Returns null for anything that is not a requirement-attached criterion —
 * callers fall back to the raw element id rather than failing.
 */
export async function resolveCriterionBareHandle(
  findElement: (elementId: string) => Promise<CriterionHandleElement | null>,
  slug: string,
  criterionElementId: string,
): Promise<string | null> {
  const criterion = await findElement(criterionElementId);
  if (
    criterion?.kind !== "criterion" ||
    criterion.parentElementId === null ||
    criterion.number === null
  ) {
    return null;
  }
  const requirement = await findElement(criterion.parentElementId);
  if (requirement?.kind !== "requirement" || requirement.number === null) {
    return null;
  }
  try {
    return formatElementHandle(
      {
        slug: parseSpecSlug(slug),
        kind: "criterion",
        requirementNumber: requirement.number,
        criterionNumber: criterion.number,
      },
      "bare",
    );
  } catch {
    return null;
  }
}
