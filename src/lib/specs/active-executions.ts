/**
 * Read model for the Active Work rail: every spec execution currently in
 * definition_review or running, joined with its spec's identity so the
 * sidebar can render and deep-link without further lookups.
 */

import { getProjectDisplayName } from "@/lib/projects/resolver";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { getStateDb } from "@/lib/state-store/store";
import { getSharedWriteQueue } from "@/lib/state-store/write-queue";
import type { Spec, SpecExecutionRow, SpecExecutionState } from "./schemas";

export interface ActiveSpecExecutionFeedItem {
  executionId: string;
  state: SpecExecutionState;
  specSlug: string;
  specName: string;
  projectPath: string;
  projectName: string;
  sessionName: string;
  createdAt: string;
}

export interface ActiveSpecExecutionsFeedDeps {
  listActiveExecutions(): SpecExecutionRow[];
  findSpecById(specId: string): Promise<Spec | null>;
  getProjectDisplayName(projectPath: string): string;
}

export async function listActiveSpecExecutionsFromDeps(
  deps: ActiveSpecExecutionsFeedDeps,
): Promise<ActiveSpecExecutionFeedItem[]> {
  const items: ActiveSpecExecutionFeedItem[] = [];
  for (const execution of deps.listActiveExecutions()) {
    const spec = await deps.findSpecById(execution.spec_id);
    if (spec === null || spec.abandonedAt !== null) continue;
    items.push({
      executionId: execution.id,
      state: execution.state,
      specSlug: spec.slug,
      specName: spec.name,
      projectPath: spec.projectPath,
      projectName: deps.getProjectDisplayName(spec.projectPath),
      sessionName: execution.session_name ?? "main",
      createdAt: execution.created_at,
    });
  }
  return items;
}

/** Production reader over the shared state DB. */
export function listActiveSpecExecutionsForFeed(): Promise<
  ActiveSpecExecutionFeedItem[]
> {
  const db = getStateDb();
  const deliveryRepo = createSpecDeliveryRepo(db);
  const specsRepo = createSpecsRepo(db, getSharedWriteQueue());
  return listActiveSpecExecutionsFromDeps({
    listActiveExecutions: () => deliveryRepo.listActiveExecutions(),
    findSpecById: (specId) => specsRepo.findById(specId),
    getProjectDisplayName,
  });
}
