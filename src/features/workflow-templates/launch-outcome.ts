import { z } from "zod";
import { ApiCallError } from "@/lib/api/errors";
import { agentBackendSchema } from "@/lib/shared/schemas";
import type { MissingPrerequisite } from "@/lib/workflow-graph/preflight-prerequisite-service";
import type { TemplateLaunchOutcome } from "./components/TemplateLibrary";

// Mirrors `MissingPrerequisite` from the preflight service. The launch response
// is an untrusted external body, so `details.missing` is SAFE-parsed against
// this schema (per the project rule on external input) before it is surfaced —
// a backend-unscoped skill carries `backend: null` to signal "unmet on at least
// one used backend".
const reasonSchema = z.enum(["absent", "probe_error"]);

const missingPrerequisiteSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("path"),
    path: z.string(),
    label: z.string().nullable(),
    reason: reasonSchema,
  }),
  z.object({
    kind: z.literal("skill"),
    skill: z.string(),
    backend: agentBackendSchema.nullable(),
    label: z.string().nullable(),
    reason: reasonSchema,
  }),
]) satisfies z.ZodType<MissingPrerequisite>;

const missingListSchema = z.array(missingPrerequisiteSchema);

/**
 * The result of a single launch attempt, before it is mapped to the library's
 * `TemplateLaunchOutcome`. `success` is a running start,
 * `awaiting_approval` is a created execution parked for a human decision, and
 * `error` carries a thrown value from the start mutation.
 */
export type LaunchAttempt =
  | { kind: "success" }
  | {
      kind: "awaiting_approval";
      executionId: string;
      instruction: string;
    }
  | { kind: "error"; error: unknown };

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Launch failed";
}

/**
 * Maps a launch attempt to the `TemplateLaunchOutcome` the TemplateLibrary
 * renders. A parked execution remains an actionable approval outcome. A
 * `prerequisites_unmet` ApiCallError whose `details.missing` parses to a valid
 * itemized list becomes the itemized `prerequisites_unmet` outcome; any other
 * failure becomes a `rejected` outcome carrying the engine's message.
 */
export function mapLaunchOutcome(
  attempt: LaunchAttempt,
): TemplateLaunchOutcome {
  if (attempt.kind === "success") {
    return { status: "started" };
  }

  if (attempt.kind === "awaiting_approval") {
    return {
      status: "awaiting_approval",
      executionId: attempt.executionId,
      instruction: attempt.instruction,
    };
  }

  const { error } = attempt;

  if (error instanceof ApiCallError && error.code === "prerequisites_unmet") {
    const parsed = missingListSchema.safeParse(error.details?.["missing"]);
    if (parsed.success) {
      return { status: "prerequisites_unmet", missing: parsed.data };
    }
    return { status: "rejected", reason: error.message };
  }

  return { status: "rejected", reason: errorMessage(error) };
}
