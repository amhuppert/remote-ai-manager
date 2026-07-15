import { randomUUID } from "node:crypto";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
const DRAFT_TTL_MS = 15 * 60 * 1000;
const GLOBAL_KEY = "__cc_planner_draft_registry" as const;

interface DraftEntry {
  createdAt: number;
  definition: WorkflowSemanticDefinition | null;
}

function getRegistry(): Map<string, DraftEntry> {
  const globalState = globalThis as Record<string, unknown>;
  if (!globalState[GLOBAL_KEY]) {
    globalState[GLOBAL_KEY] = new Map<string, DraftEntry>();
  }
  return globalState[GLOBAL_KEY] as Map<string, DraftEntry>;
}

export function createPlannerDraftSubmission(): { draftId: string } {
  const draftId = randomUUID();
  getRegistry().set(draftId, {
    createdAt: Date.now(),
    definition: null,
  });
  return { draftId };
}

export function hasPlannerDraftSubmission(draftId: string): boolean {
  return getRegistry().has(draftId);
}

export function submitPlannerDraft(
  draftId: string,
  definition: WorkflowSemanticDefinition,
): void {
  const registry = getRegistry();
  const existing = registry.get(draftId);
  if (!existing) {
    return;
  }

  registry.set(draftId, {
    createdAt: existing.createdAt,
    definition,
  });
}

export function consumePlannerDraft(
  draftId: string,
): WorkflowSemanticDefinition | null {
  return getRegistry().get(draftId)?.definition ?? null;
}

export function deletePlannerDraft(draftId: string): void {
  getRegistry().delete(draftId);
}

export function cleanupExpiredPlannerDrafts(now = Date.now()): void {
  for (const [draftId, entry] of getRegistry()) {
    if (now - entry.createdAt > DRAFT_TTL_MS) {
      getRegistry().delete(draftId);
    }
  }
}
