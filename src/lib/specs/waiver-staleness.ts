import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type {
  PreparedSpecEventPublication,
  SpecEventsPublisher,
} from "./events";
import type {
  ActorProvenance,
  Spec,
  SpecExecutionRow,
  SpecRevisionSnapshot,
  SpecWaiverRow,
} from "./schemas";

/**
 * R14.5 at the moment it matters: approving a revision that changed a waived
 * criterion must invalidate the waiver in the SAME transaction as the
 * approval, or a crash between the two leaves a changed-criterion waiver the
 * delivery gate would still honor. Every revision-approval site (review
 * sign-off, fast-path combined approval, authoring's absorbed sign-off) runs
 * this sweep inside its transaction; the produced events are byte-compatible
 * with the evidence service's `waiver-staled` shape so downstream consumers
 * see one event vocabulary.
 */

export interface WaiverStalenessInput {
  /** 0 = valid, 1 = already stale (never re-staled). */
  stale: number;
  /** Criterion payload hash at the waived revision; null when absent there. */
  waivedHash: string | null;
  /** Criterion payload hash at the newly approved revision; null when removed. */
  laterHash: string | null;
}

/**
 * A waiver goes stale only when the criterion exists in both revisions with
 * different content (R14.5). A removed criterion has nothing left to waive,
 * and an unchanged criterion keeps the human's decision valid.
 */
export function shouldMarkWaiverStale(input: WaiverStalenessInput): boolean {
  return (
    input.stale === 0 &&
    input.waivedHash !== null &&
    input.laterHash !== null &&
    input.waivedHash !== input.laterHash
  );
}

/**
 * The single owner of waiver validity. A waiver excuses a criterion only while
 * it is non-stale and belongs to this spec, to this execution's pinned
 * revision, and to this criterion. It lives here rather than beside the
 * delivery gate that enforces it because the read-time delta projection needs
 * the same verdict and reaches client bundles: the gate module pulls the
 * server logger and therefore `node:async_hooks`, which cannot be bundled for
 * the browser. Keeping the rule in this dependency-free module is what lets
 * every surface share one copy instead of re-deriving it — a criterion that
 * reads `waived` on one surface and is refused on another is exactly that
 * drift.
 */
export function isWaiverValidForExecution(
  waiver: SpecWaiverRow | null,
  execution: SpecExecutionRow,
  criterionElementId: string,
): waiver is SpecWaiverRow {
  return (
    waiver !== null &&
    waiver.stale === 0 &&
    waiver.spec_id === execution.spec_id &&
    waiver.revision_id === execution.revision_id &&
    waiver.criterion_element_id === criterionElementId
  );
}

export interface MarkWaiversStaleAtSignOffInput {
  spec: Spec;
  approvedRevisionId: string;
  /** Synchronous in-transaction snapshot read (SpecsRepoTransaction). */
  getSnapshot(revisionId: string): SpecRevisionSnapshot | null;
  waivers: Pick<SpecDeliveryRepo, "findWaiversBySpecId" | "saveWaiver">;
  events: SpecEventsPublisher;
  actor: ActorProvenance;
  occurredAt: string;
}

function criterionPayloadHash(
  snapshot: SpecRevisionSnapshot | null,
  criterionElementId: string,
): string | null {
  const entry = snapshot?.elements.find(
    ({ element, version }) =>
      element.id === criterionElementId && version.payload.kind === "criterion",
  );
  return entry === undefined ? null : entry.version.payloadHash;
}

/**
 * Runs inside the caller's revision-approval transaction. Flips `stale` on
 * every valid waiver whose criterion changed between its waived revision and
 * the newly approved one, returning the prepared `waiver-staled` publications
 * for the caller's post-commit publish loop.
 */
export function markWaiversStaleAtSignOffInTransaction(
  input: MarkWaiversStaleAtSignOffInput,
): PreparedSpecEventPublication[] {
  const prepared: PreparedSpecEventPublication[] = [];
  const snapshots = new Map<string, SpecRevisionSnapshot | null>();
  function snapshotFor(revisionId: string): SpecRevisionSnapshot | null {
    const cached = snapshots.get(revisionId);
    if (cached !== undefined) return cached;
    const loaded = input.getSnapshot(revisionId);
    snapshots.set(revisionId, loaded);
    return loaded;
  }

  for (const waiver of input.waivers.findWaiversBySpecId(input.spec.id)) {
    if (waiver.revision_id === input.approvedRevisionId) continue;
    const decision = shouldMarkWaiverStale({
      stale: waiver.stale,
      waivedHash: criterionPayloadHash(
        snapshotFor(waiver.revision_id),
        waiver.criterion_element_id,
      ),
      laterHash: criterionPayloadHash(
        snapshotFor(input.approvedRevisionId),
        waiver.criterion_element_id,
      ),
    });
    if (!decision) continue;

    const persisted: SpecWaiverRow = { ...waiver, stale: 1 };
    input.waivers.saveWaiver(persisted);
    prepared.push(
      input.events.appendInTransaction({
        actor: input.actor,
        durableEventType: "spec-evidence-changed",
        durablePayload: {
          kind: "waiver-staled",
          waiverId: waiver.id,
          criterionElementId: waiver.criterion_element_id,
          waivedRevisionId: waiver.revision_id,
          laterRevisionId: input.approvedRevisionId,
        },
        sseEvent: {
          type: "spec-evidence-changed",
          kind: "waiver-staled",
          projectPath: input.spec.projectPath,
          specId: input.spec.id,
          specSlug: input.spec.slug,
          occurredAt: input.occurredAt,
          revisionId: waiver.revision_id,
          criterionId: waiver.criterion_element_id,
        },
      }),
    );
  }
  return prepared;
}
