import { materializeGlobalConfig } from "@/lib/config/loader";
import { rawGlobalConfigSchema } from "@/lib/config/schemas";
import {
  coerceGlobalDefaults,
  resolveAgentValidationWithProvenance,
  resolveCollaborationConfigWithProvenance,
  resolveContext,
} from "../resolve-config";
import type { LiveEditDeps } from "../runtime-edits";
import { makeProfileSnapshot, seedAssignment } from "../test-fixtures";

/**
 * The live-edit deps a pattern proof's runtime mutation is compiled against,
 * resolved through the REAL seeded cascade over an empty config — the same
 * defaults the engine harness runs under, so "the edit inherited the seeded
 * gates" is a property of the production resolver rather than of a hand-written
 * literal.
 *
 * Shared by every pattern proof that mutates a running graph (expansion, loop
 * repair), so two proofs cannot drift into compiling against different
 * defaults. Test-support only; not imported by production code.
 */
export function harnessLiveEditDeps(): LiveEditDeps {
  const config = materializeGlobalConfig(rawGlobalConfigSchema.parse({}));
  const defaults = coerceGlobalDefaults(config.workflowDefaults);
  const synthetic = {
    id: "__pattern_defaults__",
    title: "Pattern defaults",
    acceptanceCriteria: "Pattern defaults",
  };
  const resolved = resolveContext(defaults, {}, synthetic);
  const agentValidation = resolveAgentValidationWithProvenance(
    defaults,
    {},
    synthetic,
  );
  let minted = 0;
  return {
    createTaskId: () => `pattern-task-${(minted += 1)}`,
    resolvedGlobalDefaults: () => ({
      implementer: seedAssignment(resolved.implementer),
      contextValidator: {
        ...resolved.contextValidator,
        assignments: resolved.contextValidator.assignments.map((assignment) =>
          seedAssignment(assignment),
        ),
      },
      scriptValidator: resolved.scriptValidator,
      scriptValidatorSource: resolved.scriptValidatorSource,
      humanApprovalGate: resolved.humanApprovalGate,
      askUserQuestions: resolved.askUserQuestions,
      mutability: resolved.mutability,
      circuitBreaker: resolved.circuitBreaker,
      iterationPolicy: resolved.iterationPolicy,
      planRepair: resolved.planRepair,
      collaboration: resolveCollaborationConfigWithProvenance(
        defaults,
        {},
        synthetic,
      ),
      agentValidation: {
        implementer: { ...agentValidation.implementer, commands: [] },
        contextValidator: {
          ...agentValidation.contextValidator,
          commands: [],
        },
      },
    }),
    validationCommandPreflight: () => ({
      commandCosts: {},
      concurrencyLimit: 8,
    }),
    snapshotFor: (assignment) =>
      makeProfileSnapshot({
        tier: assignment.profile.tier,
        id: assignment.profile.id,
      }),
    now: () => "2026-08-05T00:00:00.000Z",
  };
}
