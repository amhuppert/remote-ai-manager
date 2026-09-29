import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { workingDefinitionHash } from "@/lib/workflow-graph/working-definition-hash";
import {
  authoredDeliveryPlanSources,
  isServerOwnedDeliveryPlanDocument,
} from "@/lib/specs/delivery-plan-finalization";

import {
  validateWorkflowPlan,
  type WorkflowPlanIssue,
  type WorkflowPlanValidationOptions,
} from "../plan-validation";

// Server-side only — `planDefinitionHash` reaches `node:crypto` through
// `workingDefinitionHash`, which no browser bundle can carry.

/**
 * The hash, or the reasons the plan could not be hashed. Never throws: every
 * caller is on an advisory path, and a malformed plan is already refused by
 * the validation it shares with create/replace.
 */
export type PlanDefinitionHashResult =
  | { ok: true; hash: string }
  | { ok: false; issues: WorkflowPlanIssue[] };

/**
 * The review identity of an ALREADY-canonical definition — for callers that
 * have run the shared admission and hold its canonical draft, so re-validating
 * to recover the same bytes would be pure waste.
 *
 * Both entry points funnel here so create/replace and the review verb cannot
 * drift into two digests of one revision.
 */
export function canonicalPlanDefinitionHash(
  definition: WorkflowSemanticDefinition,
): string {
  const authored = { ...definition };
  if (definition.origin?.sourceUri.startsWith("spec-plan://")) {
    delete authored.origin;
    delete authored.lockedRegions;
    delete authored.approvalRequired;
    authored.charter = {
      ...definition.charter,
      sourcesOfTruth: authoredDeliveryPlanSources(
        definition.charter.sourcesOfTruth,
      ),
    };
    if (definition.seededDocuments !== undefined)
      authored.seededDocuments = definition.seededDocuments.filter(
        (document) => !isServerOwnedDeliveryPlanDocument(document.relativePath),
      );
  }
  if (authored.seededDocuments?.length === 0) delete authored.seededDocuments;
  return workingDefinitionHash(authored);
}

/**
 * The one place a plan body becomes a review identity. Hashing the CANONICAL
 * definition `validateWorkflowPlan` returns — not the submitted bytes — is
 * what makes the identity stable: key order, and the prose/records spelling of
 * acceptance criteria, are two encodings of one revision, and a review bound
 * to one of them must bind to the other.
 */
export function planDefinitionHash(
  rawBody: unknown,
  options: WorkflowPlanValidationOptions = {},
): PlanDefinitionHashResult {
  const validated = validateWorkflowPlan(rawBody, options);
  if (!validated.ok) return { ok: false, issues: validated.issues };
  return {
    ok: true,
    hash: canonicalPlanDefinitionHash(validated.draft.definition),
  };
}
