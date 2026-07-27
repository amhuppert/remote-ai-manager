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

/**
 * A handle without the spec it belongs to. Questions and assumptions are
 * spec-scoped records read from rows that carry a spec id rather than a slug,
 * so requiring a slug to render `Q<n>` would push those callers into building
 * the grammar themselves.
 */
export const bareElementHandleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("requirement"),
    requirementNumber: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("criterion"),
    requirementNumber: z.number().int().positive(),
    criterionNumber: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("decision"),
    number: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("task"), number: z.number().int().positive() }),
  z.object({
    kind: z.literal("question"),
    number: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("assumption"),
    number: z.number().int().positive(),
  }),
]);
export type BareElementHandle = z.infer<typeof bareElementHandleSchema>;

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

/**
 * The one authored description of the handle grammar. Every invalid-handle
 * refusal (CLI and route) quotes it so an agent that mis-addressed an element
 * learns the vocabulary from the refusal itself.
 */
export const ELEMENT_HANDLE_FORMAT =
  "Element handles are R<n> for a requirement, R<n>.<m> for a criterion, D<n> for a decision, T<n> for a task, Q<n> for a question, and A<n> for an assumption — for example R1, R1.2, D3, T4, Q1, A2. Optionally qualify a handle with its spec slug, for example native-sdd/R1.";

/** Kebab/snake-cased values are the shape caller-chosen element ids take. */
const ELEMENT_ID_SHAPE = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/;

/**
 * Whether a value is grammatically a handle, regardless of whether it resolves.
 * Separates "you addressed this wrong" from "nothing is at that address".
 */
export function isWellFormedElementHandle(
  input: string,
  contextSlug?: string,
): boolean {
  try {
    parseElementHandle(input, contextSlug);
    return true;
  } catch {
    return false;
  }
}

/**
 * Explain why a value is not an element handle. Element ids are caller-chosen
 * strings, so the grammar alone cannot prove one was supplied: a caller-owned
 * handle map (when the reader has a snapshot in hand) names the real handle,
 * and otherwise the shape of the value is reported as a likeness, not a fact.
 */
export function explainInvalidElementHandle(
  input: string,
  handleByElementId?: ReadonlyMap<string, string>,
): string {
  const separatorIndex = input.lastIndexOf("/");
  const bare = separatorIndex === -1 ? input : input.slice(separatorIndex + 1);
  const knownHandle = handleByElementId?.get(bare);
  if (knownHandle !== undefined && knownHandle !== bare) {
    return `${JSON.stringify(bare)} is an element id, not an element handle; its handle is ${knownHandle}. ${ELEMENT_HANDLE_FORMAT}`;
  }
  if (ELEMENT_ID_SHAPE.test(bare)) {
    return `${JSON.stringify(input)} looks like an element id, not an element handle. ${ELEMENT_HANDLE_FORMAT}`;
  }
  return `${JSON.stringify(input)} is not a valid element handle. ${ELEMENT_HANDLE_FORMAT}`;
}

export function formatElementHandle(
  handle: ParsedElementHandle,
  qualification: HandleQualification = "qualified",
): string {
  const parsed = parsedElementHandleSchema.parse(handle);
  const bare = formatBareElementHandle(parsed);
  return qualification === "bare" ? bare : `${parsed.slug}/${bare}`;
}

export function toDeepLinkElementId(handle: ParsedElementHandle): string {
  return formatElementHandle(handle, "bare");
}

/**
 * The one site in `src/lib/specs` that renders the handle grammar. Client and
 * CLI surfaces still build these strings from element numbers themselves, so a
 * grammar change has to reach them too.
 */
export function formatBareElementHandle(handle: BareElementHandle): string {
  const parsed = bareElementHandleSchema.parse(handle);
  switch (parsed.kind) {
    case "requirement":
      return `R${parsed.requirementNumber}`;
    case "criterion":
      return `R${parsed.requirementNumber}.${parsed.criterionNumber}`;
    case "decision":
      return `D${parsed.number}`;
    case "task":
      return `T${parsed.number}`;
    case "question":
      return `Q${parsed.number}`;
    case "assumption":
      return `A${parsed.number}`;
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
