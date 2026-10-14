import { createLogger } from "@/lib/logging";
import type { SpecsRepo } from "@/lib/state-store/specs-repo";
import type { WriteQueue } from "@/lib/state-store/write-queue";
import type { ActorProvenance, Refusal, Spec } from "./schemas";
import type { SpecEventsPublisher } from "./events";

const logger = createLogger("specs.abandonment");

export interface SpecAttentionClearInput {
  specId: string;
  scope: "spec";
  reason: string;
  occurredAt: string;
}
export interface SpecAttentionNotifier {
  specAttentionCleared(input: SpecAttentionClearInput): void;
}
export interface AbandonSpecInput {
  specId: string;
  reason: string;
  actor: ActorProvenance;
}
export type SpecAbandonmentResult =
  | { ok: true; value: Spec }
  | { ok: false; refusal: Refusal };
export interface SpecAbandonmentService {
  abandonSpec(input: AbandonSpecInput): Promise<SpecAbandonmentResult>;
}
export interface SpecAbandonmentDeps {
  specsRepo: SpecsRepo;
  events: SpecEventsPublisher;
  writeQueue: Pick<WriteQueue, "withWriteQueue">;
  runInImmediateTransaction<T>(operation: () => T): T;
  now(): string;
  attentionNotifier?: SpecAttentionNotifier;
}

export function createSpecAbandonmentService(
  deps: SpecAbandonmentDeps,
): SpecAbandonmentService {
  return {
    async abandonSpec(input) {
      const reason = input.reason.trim();
      if (!reason) {
        return {
          ok: false,
          refusal: {
            code: "validation",
            unmetConditions: ["Abandonment requires a non-empty reason."],
            instruction: "Provide the reason for abandonment.",
          },
        };
      }
      return deps.writeQueue.withWriteQueue(
        `spec-abandon[${input.specId}]`,
        async () => {
          const current = await deps.specsRepo.findById(input.specId);
          if (current === null) {
            return {
              ok: false,
              refusal: {
                code: "not_found",
                unmetConditions: [`Spec ${input.specId} was not found.`],
                instruction: "Select an existing spec.",
              },
            };
          }
          if (current.abandonedAt !== null) {
            return {
              ok: false,
              refusal: {
                code: "gate_blocked",
                unmetConditions: [
                  "The spec is already abandoned and terminal.",
                ],
                instruction: "Use the abandoned spec history.",
              },
            };
          }
          const occurredAt = deps.now();
          const committed = deps.runInImmediateTransaction(() => {
            const spec = deps.specsRepo.abandonInTransaction({
              specId: input.specId,
              abandonedAt: occurredAt,
              reason,
              updatedAt: occurredAt,
            });
            const prepared = deps.events.appendInTransaction({
              actor: input.actor,
              durableEventType: "spec-changed",
              durablePayload: { kind: "spec_abandoned", reason },
              sseEvent: {
                type: "spec-changed",
                kind: "spec_abandoned",
                projectPath: spec.projectPath,
                specId: spec.id,
                specSlug: spec.slug,
                occurredAt,
              },
            });
            return { spec, prepared };
          });
          deps.events.publishAfterCommit(committed.prepared);
          deps.attentionNotifier?.specAttentionCleared({
            specId: input.specId,
            scope: "spec",
            reason,
            occurredAt,
          });
          logger.info("specs.abandonment.complete", {
            specId: input.specId,
            reasonLength: reason.length,
          });
          return { ok: true, value: committed.spec };
        },
      );
    },
  };
}
