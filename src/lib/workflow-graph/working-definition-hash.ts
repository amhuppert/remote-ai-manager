import { createHash } from "node:crypto";

import { stableStringify } from "@/lib/state-store/serialization";

import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "./definition-schemas";

/**
 * Kept apart from `./execution-amendment` so that module stays free of
 * `node:crypto`: the amendment request and response schemas there are posted by
 * the Studio control, and a browser bundle cannot carry the builtin.
 */

/**
 * The identity an amendment moves. Hashing the whole working definition (not a
 * per-field digest) is what lets the audit row answer "is this still the
 * approved bytes?" against the stored candidate hash with one comparison.
 */
export function workingDefinitionHash(
  definition: WorkflowSemanticDefinition | ResolvedWorkflowSemanticDefinition,
): string {
  return `sha256:${createHash("sha256").update(stableStringify(definition)).digest("hex")}`;
}
