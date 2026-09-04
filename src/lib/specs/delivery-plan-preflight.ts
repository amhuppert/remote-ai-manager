import { z } from "zod";

import { getStateDb } from "@/lib/state-store/store";
import { getSharedWriteQueue } from "@/lib/state-store/write-queue";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import type {
  ManagedDefinitionPreflightPort,
  ManagedDefinitionPreflightResult,
} from "@/lib/workflow-graph/managed-definition-preflight";

import type { DeliveryPlanService } from "./delivery-plan-service";
import type { Spec } from "./schemas";

export interface ManagedDeliveryPlanOwnership {
  readonly projectPath: string;
  readonly specId: string;
  readonly specSlug: string;
  readonly attemptId: string;
}

export interface DeliveryPlanPreflightPortDeps {
  findOwnerships(
    workflowDefinitionId: string,
  ): Promise<readonly ManagedDeliveryPlanOwnership[]>;
  findSpec(specId: string): Promise<Spec | null>;
  deliveryPlanFor(
    projectPath: string,
  ): Promise<Pick<DeliveryPlanService, "preflight">>;
}

export function createDeliveryPlanPreflightPort(
  deps: DeliveryPlanPreflightPortDeps,
): ManagedDefinitionPreflightPort {
  return {
    async preflight(input): Promise<ManagedDefinitionPreflightResult> {
      const ownerships = await deps.findOwnerships(input.workflowDefinitionId);
      const ownership = ownerships.find(
        (candidate) => candidate.projectPath === input.projectPath,
      );
      if (ownership === undefined) {
        const foreign = ownerships[0];
        if (foreign !== undefined) {
          return {
            ok: false,
            refusal: {
              code: "definition_project_mismatch",
              message: `Workflow definition ${input.workflowDefinitionId} belongs to another project.`,
              instruction: `Switch to its project and run \`cctl spec plan status ${foreign.specSlug}\`.`,
            },
          };
        }
        return {
          ok: false,
          refusal: {
            code: "definition_not_managed",
            message: `Workflow definition ${input.workflowDefinitionId} is not managed by a spec delivery plan.`,
            instruction:
              "Read the managed draft with `cctl spec plan status <slug>` and use the workflow definition id it names.",
          },
        };
      }

      const spec = await deps.findSpec(ownership.specId);
      if (spec === null || spec.projectPath !== input.projectPath) {
        return {
          ok: false,
          refusal: {
            code: "definition_not_managed",
            message: `Workflow definition ${input.workflowDefinitionId} has no readable owning spec.`,
            instruction: `Read the managed draft with \`cctl spec plan status ${ownership.specSlug}\` and use the workflow definition id it names.`,
          },
        };
      }

      const deliveryPlan = await deps.deliveryPlanFor(input.projectPath);
      return deliveryPlan.preflight({
        spec,
        attemptId: ownership.attemptId,
        workflowDefinitionId: input.workflowDefinitionId,
        launch: input.launch,
      });
    },
  };
}

const ownershipRowSchema = z
  .object({
    project_path: z.string().min(1),
    spec_id: z.string().min(1),
    spec_slug: z.string().min(1),
    attempt_id: z.string().min(1),
  })
  .strict();

function productionOwnerships(
  workflowDefinitionId: string,
): ManagedDeliveryPlanOwnership[] {
  const rows: unknown[] = getStateDb()
    .prepare(
      `SELECT specs.project_path, specs.id AS spec_id, specs.slug AS spec_slug,
              attempts.id AS attempt_id
       FROM spec_delivery_plan_attempts attempts
       JOIN specs ON specs.id = attempts.spec_id
       WHERE attempts.workflow_definition_id = ?
       UNION
       SELECT specs.project_path, specs.id AS spec_id, specs.slug AS spec_slug,
              attempts.id AS attempt_id
       FROM spec_delivery_plan_snapshots snapshots
       JOIN spec_delivery_plan_attempts attempts
         ON attempts.id = snapshots.attempt_id
       JOIN specs ON specs.id = attempts.spec_id
       WHERE snapshots.workflow_definition_id = ?
       ORDER BY project_path, spec_id, attempt_id`,
    )
    .all(workflowDefinitionId, workflowDefinitionId);
  return rows.map((row) => {
    const parsed = ownershipRowSchema.parse(row);
    return {
      projectPath: parsed.project_path,
      specId: parsed.spec_id,
      specSlug: parsed.spec_slug,
      attemptId: parsed.attempt_id,
    };
  });
}

/** Built without opening the database; every dependency resolves per request. */
export function createProductionDeliveryPlanPreflightPort(): ManagedDefinitionPreflightPort {
  return createDeliveryPlanPreflightPort({
    findOwnerships: async (workflowDefinitionId) =>
      productionOwnerships(workflowDefinitionId),
    findSpec: (specId) =>
      createSpecsRepo(getStateDb(), getSharedWriteQueue()).findById(specId),
    async deliveryPlanFor(projectPath) {
      const { createProductionSpecRouteServices } =
        await import("./service-factory");
      return (await createProductionSpecRouteServices(projectPath))
        .deliveryPlan;
    },
  });
}
