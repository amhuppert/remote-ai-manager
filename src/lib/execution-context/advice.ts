import { z } from "zod";
import type { CertificationStanding } from "./certification";
import type { ContextFacts, ReviewRound } from "./schemas";
import { adviceDispositionSchema } from "./schemas";

export interface AdviceItem {
  id: string;
  roundId: string;
  assignmentId: string;
  title: string;
  description: string;
}

const adviceResponseSchema = z
  .object({
    dispositions: z.array(
      z
        .object({
          advisoryId: z.string().min(1),
          disposition: adviceDispositionSchema,
          reason: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

/** Output contract for the implementer's response to fresh advice, generated from the parser's schema. */
export const ADVICE_RESPONSE_OUTPUT_SCHEMA: Record<string, unknown> = z.toJSONSchema(adviceResponseSchema);

export type AdviceStanding =
  | { kind: "not_applicable" }
  | { kind: "settled" }
  | { kind: "owed"; items: AdviceItem[] }
  | { kind: "invalid" };

export function adviceItemsOf(round: ReviewRound): AdviceItem[] {
  return round.seats.flatMap((seat) =>
    seat.advisories.map((advisory, ordinal) => ({
      id: `${round.id}:${seat.assignmentId}:${ordinal + 1}`,
      roundId: round.id,
      assignmentId: seat.assignmentId,
      title: advisory.title,
      description: advisory.description,
    })),
  );
}

/**
 * Advice is owed once, after a cleared full round. A candidate produced by an
 * advisory response gets a blocking-only round, so its recertification never
 * starts another advisory cycle.
 */
export function adviceStanding(
  facts: ContextFacts,
  certification: CertificationStanding,
): AdviceStanding {
  if (certification.kind !== "cleared" || certification.round.kind !== "full") {
    return { kind: "not_applicable" };
  }
  const items = adviceItemsOf(certification.round);
  if (items.length === 0) return { kind: "not_applicable" };
  if (items.every((item) => facts.advice.dispositions[item.id] !== undefined)) {
    return { kind: "settled" };
  }
  if (facts.advice.correctionFailures > facts.policy.adviceCorrectionLimit) {
    return { kind: "invalid" };
  }
  return { kind: "owed", items };
}

/**
 * Records one disposition per advisory. A decline must give its reason. An
 * incomplete or malformed response spends one bounded correction; the engine
 * never invents a disposition.
 */
export function recordAdviceResponse(
  facts: ContextFacts,
  input: { items: AdviceItem[]; response: unknown },
): { facts: ContextFacts; complete: boolean } {
  const parsed = adviceResponseSchema.safeParse(input.response);
  const byId = new Map(
    parsed.success ? parsed.data.dispositions.map((d) => [d.advisoryId, d]) : [],
  );
  const complete =
    parsed.success &&
    input.items.every((item) => {
      const entry = byId.get(item.id);
      return (
        entry !== undefined &&
        (entry.disposition !== "declined" || entry.reason.trim().length > 0)
      );
    });
  if (!complete) {
    return {
      facts: {
        ...facts,
        advice: {
          ...facts.advice,
          correctionFailures: facts.advice.correctionFailures + 1,
        },
      },
      complete: false,
    };
  }
  const dispositions = { ...facts.advice.dispositions };
  for (const item of input.items) {
    const entry = byId.get(item.id);
    if (entry === undefined) continue;
    dispositions[item.id] = {
      disposition: entry.disposition,
      ...(entry.reason.trim().length > 0 ? { reason: entry.reason } : {}),
    };
  }
  return { facts: { ...facts, advice: { ...facts.advice, dispositions } }, complete: true };
}
