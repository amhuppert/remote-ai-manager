import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";

// ============================================================
// Command registry (CommandCenter.json `validation` block)
// ============================================================

// CLI-safe kebab-case identifiers: these names are typed as `cctl validate
// run <name>` arguments and rendered in generated references, so shell- or
// flag-ambiguous names are unrepresentable.
export const validationCommandNameSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "Validation command names must be kebab-case (lowercase letters, digits, single hyphens)",
  );
export type ValidationCommandName = z.infer<typeof validationCommandNameSchema>;

export const validationCommandConfigSchema = z.object({
  // Script path resolved from the canonical project root and run with
  // execFile — never a shell string. The candidate worktree is only cwd, so a
  // branch cannot validate itself with a script it modified.
  command: z.string().trim().min(1),
  // Reservation weight against the global budget. Required with no default:
  // a project must state its weight, and admission math depends on it.
  cost: z.number().int().positive(),
  timeoutMs: z.number().int().positive().optional(),
  description: z.string().optional(),
  // "paths" permits forwarding worktree-contained file paths (narrowing
  // only); "forbid" rejects every forwarded token.
  scopeArgs: z.enum(["forbid", "paths"]).default("forbid"),
});
export type ValidationCommandConfig = z.infer<
  typeof validationCommandConfigSchema
>;

function requireRegisteredNames(
  block: {
    commands: Record<string, ValidationCommandConfig>;
    preMerge: string[];
    laneMerge?: string[] | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const registered = Object.keys(block.commands);
  const known = new Set(registered);
  const lists: Array<[key: "preMerge" | "laneMerge", names: string[]]> = [
    ["preMerge", block.preMerge],
    ["laneMerge", block.laneMerge ?? []],
  ];
  for (const [key, names] of lists) {
    names.forEach((name, index) => {
      if (known.has(name)) return;
      ctx.addIssue({
        code: "custom",
        path: [key, index],
        message: `Unknown validation command "${name}"; registered commands: ${
          registered.length > 0 ? registered.join(", ") : "(none)"
        }`,
      });
    });
  }
}

export const repoValidationConfigSchema = z
  .object({
    commands: z.record(
      validationCommandNameSchema,
      validationCommandConfigSchema,
    ),
    // Ordered selection used by Smart Merge and Smart Commit; independent of
    // graph script-validator selection by design.
    preMerge: z.array(validationCommandNameSchema).default([]),
    // Ordered selection for graph lane merges; absent means lane merges fall
    // back to preMerge.
    laneMerge: z.array(validationCommandNameSchema).optional(),
  })
  .superRefine(requireRegisteredNames);
export type RepoValidationConfig = z.infer<typeof repoValidationConfigSchema>;

// ============================================================
// Registry summaries (GET /api/validation-commands)
// ============================================================

// Advisory display projection of a registered command for the workflow UI's
// command multi-selects. Never an enforcement input: unknown names still fail
// closed at the project-bound server boundaries.
export const validationCommandSummarySchema = z.object({
  name: validationCommandNameSchema,
  cost: z.number().int().positive(),
  description: z.string().optional(),
});
export type ValidationCommandSummary = z.infer<
  typeof validationCommandSummarySchema
>;

// One entry per readable project, with an empty list when the project
// registers no commands. A project whose CommandCenter.json cannot be read is
// OMITTED (unknown registry ≠ empty registry) so clients can distinguish
// "nothing registered" from "registry unavailable".
export const validationCommandsResponseSchema = z.object({
  projects: z.array(
    z.object({
      projectName: z.string().min(1),
      commands: z.array(validationCommandSummarySchema),
    }),
  ),
});
export type ValidationCommandsResponse = z.infer<
  typeof validationCommandsResponseSchema
>;

// ============================================================
// Global capacity (OS-level config.json `validation` block)
// ============================================================

export const globalValidationConfigSchema = z.object({
  // sum(cost of running commands) <= concurrencyLimit. Deliberately a
  // prominent explicit setting: memory pressure, not CPU count, is the
  // failure mode, so it cannot be inferred from the machine.
  concurrencyLimit: z.number().int().positive().default(8),
  defaultTimeoutMs: z.number().int().positive().default(600_000),
});
export type GlobalValidationConfig = z.infer<
  typeof globalValidationConfigSchema
>;

// ============================================================
// Run vocabulary
// ============================================================

export const validationRunSourceSchema = z.enum([
  "agent_cli",
  "graph_script_validator",
  "graph_lane_merge",
  "smart_merge",
  "smart_commit",
]);
export type ValidationRunSource = z.infer<typeof validationRunSourceSchema>;

const runIdSchema = z.string().trim().min(1);

// Submission/run outcomes shared by the service, CLI, and gate callers.
// Refusals (`capacity_unavailable`, `cost_exceeds_limit`, `command_not_found`)
// and the pre-admission no-op (`skipped_by_policy`) occur before a run
// exists, so they carry no runId.
export const validationRunResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("skipped_by_policy"),
    // Composed server-side from resolved configuration; must only claim
    // another component handles the command when that is true.
    message: z.string(),
  }),
  z.object({
    kind: z.literal("capacity_unavailable"),
    cost: z.number().int().positive(),
    inUse: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    queueDepth: z.number().int().nonnegative(),
    // Strict FIFO can refuse admission even when raw capacity is free; the
    // refusal message must say which situation the caller is in.
    blockedByOlderWaiter: z.boolean(),
  }),
  z.object({
    kind: z.literal("queued"),
    runId: runIdSchema,
    position: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("passed"),
    runId: runIdSchema,
    exitCode: z.number().int(),
    output: z.string(),
  }),
  z.object({
    kind: z.literal("failed"),
    runId: runIdSchema,
    // Null when the process could not be spawned at all.
    exitCode: z.number().int().nullable(),
    output: z.string(),
  }),
  z.object({
    kind: z.literal("timed_out"),
    runId: runIdSchema,
    timeoutMs: z.number().int().positive(),
    output: z.string(),
  }),
  z.object({ kind: z.literal("cancelled"), runId: runIdSchema }),
  // Terminal verdict for runs orphaned by an unclean server death; recovery
  // reconciles and terminates the owned process group, v1 never auto-resumes.
  z.object({ kind: z.literal("interrupted"), runId: runIdSchema }),
  z.object({
    kind: z.literal("command_not_found"),
    name: z.string(),
    knownCommands: z.array(z.string()),
  }),
  // Unrunnable configuration, not a temporarily-busy command: rejected even
  // under --wait, and never clamped.
  z.object({
    kind: z.literal("cost_exceeds_limit"),
    name: z.string(),
    cost: z.number().int().positive(),
    limit: z.number().int().positive(),
  }),
]);
export type ValidationRunResult = z.infer<typeof validationRunResultSchema>;

// ============================================================
// Lifecycle SSE event (published through events/publication only)
// ============================================================

export const validationRunEventPhaseSchema = z.enum([
  "requested",
  "rejected",
  "queued",
  "started",
  "completed",
  "cancelled",
  "interrupted",
  "policy_skipped",
]);
export type ValidationRunEventPhase = z.infer<
  typeof validationRunEventPhaseSchema
>;

export const validationRunEventSchema = z.object({
  type: z.literal("validation-run"),
  phase: validationRunEventPhaseSchema,
  // Null for refusals that occur before a run exists.
  runId: z.string().nullable(),
  commandName: z.string(),
  source: validationRunSourceSchema,
  projectPath: z.string(),
  conversationId: z.string().nullable(),
  /** Result kind for rejected/terminal phases (e.g. passed, cost_exceeds_limit). */
  outcome: z.string().nullable(),
  timestamp: z.string(),
});
export type ValidationRunEvent = z.infer<typeof validationRunEventSchema>;

// ============================================================
// Ledger run record + lease
// ============================================================

export const validationRunStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
  // Queued work retired by a limit lowering: unrunnable configuration, not a
  // cancellation — the durable verdict must survive a restart as the same
  // configuration error the submitter was told about.
  "cost_exceeds_limit",
]);
export type ValidationRunStatus = z.infer<typeof validationRunStatusSchema>;

// Requester role for runs submitted from inside a graph execution context.
// Mirrors the workflow-graph lane vocabulary by value; declared here so the
// validation domain stays leaf-level with no workflow-graph import.
export const validationWorkflowRoleSchema = z.enum([
  "implementer",
  "context_validator",
]);
export type ValidationWorkflowRole = z.infer<
  typeof validationWorkflowRoleSchema
>;

// One ledger row per run: operational ownership state for crash recovery
// first, retained after terminal transitions as the per-run timing record.
// Command/cost/policy are snapshots taken at submission — a live config edit
// never changes an in-flight run.
export const validationRunRecordSchema = registerTrustedSchema(
  z.object({
    runId: runIdSchema,
    source: validationRunSourceSchema,
    commandName: validationCommandNameSchema,
    cost: z.number().int().positive(),
    queueOrder: z.number().int().nonnegative(),
    status: validationRunStatusSchema,
    // Per-run process identity: PIDs are reused, so recovery trusts the nonce
    // (exported to the child environment), not a bare PID.
    nonce: z.string().trim().min(1),
    // Null lease = system-owned, lease-exempt run (script validator, merge and
    // commit gates) whose orchestrator lifecycle performs cancellation.
    leaseToken: z.string().trim().min(1).nullable(),
    leaseExpiresAt: z.string().trim().min(1).nullable(),
    processGroupPid: z.number().int().positive().nullable(),
    projectPath: z.string().trim().min(1),
    worktreePath: z.string().trim().min(1),
    sessionName: z.string().trim().min(1).nullable(),
    conversationId: z.string().trim().min(1).nullable(),
    workflowExecutionId: z.string().trim().min(1).nullable(),
    workflowContextId: z.string().trim().min(1).nullable(),
    workflowRole: validationWorkflowRoleSchema.nullable(),
    submittedAt: z.string().trim().min(1),
    // Timeout starts at spawn, so queue time is never charged to execution:
    // queueMs = startedAt - submittedAt, execMs = finishedAt - startedAt, and
    // the two are always kept separate (contention vs command cost).
    startedAt: z.string().trim().min(1).nullable(),
    finishedAt: z.string().trim().min(1).nullable(),
    queueMs: z.number().int().nonnegative().nullable(),
    execMs: z.number().int().nonnegative().nullable(),
    // Whether scope paths were forwarded, and how many: a scoped TDD run and a
    // full-suite run of the same command must never share one duration
    // distribution.
    scoped: z.boolean(),
    scopedPathCount: z.number().int().nonnegative(),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
  }),
  "validationRunRecordSchema",
);
export type ValidationRunRecord = z.infer<typeof validationRunRecordSchema>;

// Issued only to the submitter; only the token holder can renew or cancel,
// so read-only status polling can never keep abandoned work alive.
export const validationLeaseSchema = z.object({
  runId: runIdSchema,
  token: z.string().trim().min(1),
  expiresAt: z.string().trim().min(1),
});
export type ValidationLease = z.infer<typeof validationLeaseSchema>;
