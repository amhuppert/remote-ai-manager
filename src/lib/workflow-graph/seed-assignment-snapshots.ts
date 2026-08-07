/**
 * The one-way boundary between reference-bearing configuration and the bytes an
 * execution actually runs.
 *
 * Execution start calls this once, after the config cascade and before any
 * state is built. It resolves EVERY persisted assignment — the implementer,
 * every enabled cohort member, and every dormant assignment inside a disabled
 * cohort — and stores the full snapshot on each. Seeding the dormant ones is
 * the part that makes R4's immutability unconditional: enabling a dormant
 * assignment mid-run is a configuration edit, and if it had to resolve then, a
 * profile edited or deleted after start could still reach the execution.
 *
 * Past this point nothing consults the library. Lanes replay
 * `renderedInstructionBlock` verbatim, so a restart or a composer upgrade
 * re-sends byte-identical instructions.
 */

import { buildAgentProfileSnapshot } from "@/lib/agent-profiles/composer";
import type { AgentProfileLibraryService } from "@/lib/agent-profiles/library-service";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import { createLogger } from "@/lib/logging";
import type { AgentAssignment } from "./config-schemas";
import type {
  CascadeWorkflowSemanticDefinition,
  GraphWorkflowCascadeContext,
  GraphWorkflowResolvedContext,
  ResolvedWorkflowSemanticDefinition,
} from "./definition-schemas";
import {
  assignmentProfileBlockOptions,
  type AssignmentInstructionPlacement,
} from "./role-instructions";

const logger = createLogger("workflow-assignment-seeding");

export interface SeedAssignmentSnapshotsDeps {
  library: AgentProfileLibraryService;
  /** The project the execution belongs to — the scope the project tier resolves in. */
  projectPath: string;
}

export async function seedAssignmentSnapshots(
  definition: CascadeWorkflowSemanticDefinition,
  deps: SeedAssignmentSnapshotsDeps,
): Promise<ResolvedWorkflowSemanticDefinition> {
  const executionContexts: GraphWorkflowResolvedContext[] = [];
  for (const context of definition.executionContexts) {
    executionContexts.push(await seedContext(context, deps));
  }

  logger.info("workflow-assignment-seeding.seeded", {
    contextCount: executionContexts.length,
    assignmentCount: executionContexts.reduce(
      (total, context) =>
        total + 1 + context.contextValidator.assignments.length,
      0,
    ),
  });

  return { ...definition, executionContexts };
}

async function seedContext(
  context: GraphWorkflowCascadeContext,
  deps: SeedAssignmentSnapshotsDeps,
): Promise<GraphWorkflowResolvedContext> {
  const implementer = {
    ...context.implementer,
    profileSnapshot: await snapshotFor(context.implementer, deps),
  };

  const assignments = [];
  for (const assignment of context.contextValidator.assignments) {
    assignments.push({
      ...assignment,
      profileSnapshot: await snapshotFor(assignment, deps),
    });
  }

  return {
    ...context,
    implementer,
    contextValidator: { ...context.contextValidator, assignments },
  };
}

/**
 * Resolution fails closed by construction: the library throws on a dangling
 * reference and nothing here catches it, so a profile deleted between validate
 * and start aborts the seed rather than producing an execution with a hole in
 * it. The composer's own refusals (a colliding focus, an over-long one) reach
 * the caller the same way.
 */
async function snapshotFor(
  assignment: AgentAssignment & AssignmentInstructionPlacement,
  deps: SeedAssignmentSnapshotsDeps,
): Promise<AgentProfileSnapshot> {
  const resolved = await deps.library.resolve(
    deps.projectPath,
    assignment.profile,
  );
  return buildAgentProfileSnapshot(
    resolved,
    assignmentProfileBlockOptions(assignment),
  );
}
