import { z } from "zod";
import {
  validationCommandCostSchema,
  validationLeaseSchema,
  validationRunResultSchema,
  validationRunSourceSchema,
  validationRunStatusSchema,
  validationScopeSchema,
} from "./schemas";

/** Private submitter lease carried by poll/cancel requests. */
export const VALIDATION_LEASE_HEADER = "x-cc-validation-lease-token";

/**
 * Wire contract for the conversation-scoped validation endpoints (design:
 * validation-concurrency §5). Shared by the route handlers and the `cctl
 * validate` command so the two sides parse one shape; the run/result
 * vocabulary itself comes from the foundation `schemas.ts` and is never
 * redefined here.
 *
 * Deliberately absent from every response: a command's underlying executable
 * (`command`). Listing it would hand agents a copy-paste path around the
 * wrapper, so the wire shape has no field for it to occupy.
 */

export const validationSubmitBodySchema = z
  .object({
    commandName: z.string().trim().min(1),
    scope: validationScopeSchema.default("changed"),
    scopePaths: z.array(z.string()).optional(),
    wait: z.boolean().optional(),
    /**
     * CC_VALIDATION_RUN_ID observed in the submitter's environment; the
     * server rejects nested invocations (a registered command would hold
     * capacity while waiting for capacity).
     */
    nestedValidationRunId: z.string().trim().min(1).optional(),
    // Claimed lane identity from CC_WORKFLOW_EXECUTION_ID/CONTEXT_ID. Never
    // authoritative — the server cross-checks it against graph state and
    // fails closed on any mismatch. Both travel together or not at all.
    workflowExecutionId: z.string().trim().min(1).optional(),
    workflowContextId: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (body) =>
      (body.workflowExecutionId === undefined) ===
      (body.workflowContextId === undefined),
    {
      message:
        "workflowExecutionId and workflowContextId must be supplied together",
    },
  );
export type ValidationSubmitBody = z.infer<typeof validationSubmitBodySchema>;

// Accepted submissions answer 202 (the work is initiated, never awaited);
// pre-admission refusals (`not_started`) answer 200 with the foundation
// result so the CLI renders capacity numbers, policy skips, and unknown
// commands from one discriminated shape. `invalid` submissions are HTTP
// errors ({ error, code }) and never reach this envelope.
export const validationSubmitResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("accepted"),
    runId: z.string().min(1),
    status: z.enum(["queued", "running"]),
    position: z.number().int().nonnegative().nullable(),
    requestedScope: validationScopeSchema,
    effectiveScope: validationScopeSchema,
    /** Present only for the submitter (agent CLI source). */
    lease: validationLeaseSchema.nullable(),
  }),
  z.object({
    kind: z.literal("not_started"),
    result: validationRunResultSchema,
  }),
]);
export type ValidationSubmitResponse = z.infer<
  typeof validationSubmitResponseSchema
>;

export const validationPollResponseSchema = z.object({
  runId: z.string().min(1),
  status: validationRunStatusSchema,
  position: z.number().int().nonnegative().nullable(),
  result: validationRunResultSchema.nullable(),
  requestedScope: validationScopeSchema.nullable(),
  effectiveScope: validationScopeSchema.nullable(),
});
export type ValidationPollResponse = z.infer<
  typeof validationPollResponseSchema
>;

/**
 * Server ceiling on a status long-poll. It must stay well under the run
 * lease TTL (`DEFAULT_LEASE_TTL_MS`, 60s): the lease is renewed once per poll
 * request, so the hold budget is also the gap between renewals, and a budget
 * approaching the TTL would let a healthy waiting submitter's run be reaped
 * by the lease sweep.
 */
export const VALIDATION_POLL_MAX_WAIT_MS = 25_000;

export const validationPollQuerySchema = z.object({
  /**
   * How long the server may hold the request waiting for the run to move.
   * Absent, empty, or zero means "answer from current state", which is what
   * keeps a one-shot status read — and a CLI that predates the parameter —
   * instant. An over-cap budget is clamped rather than refused: the caller is
   * expressing "hold as long as you can" and the server owns the ceiling. A
   * value that cannot be read as whole milliseconds is a caller defect and is
   * refused, because guessing at it would silently change the wait.
   */
  waitMs: z
    .string()
    .nullish()
    .transform((raw) => (raw ?? "").trim())
    .refine((raw) => raw === "" || /^\d+$/.test(raw), {
      message: "waitMs must be a whole number of milliseconds",
    })
    .transform((raw) =>
      raw === ""
        ? 0
        : Math.min(Number.parseInt(raw, 10), VALIDATION_POLL_MAX_WAIT_MS),
    ),
});
export type ValidationPollQuery = z.infer<typeof validationPollQuerySchema>;

export const validationCancelResponseSchema = z.object({
  cancelled: z.literal(true),
});
export type ValidationCancelResponse = z.infer<
  typeof validationCancelResponseSchema
>;

export const validationListCommandSchema = z.object({
  name: z.string().min(1),
  // The registration as declared, not a resolved reservation: a scope-aware
  // table travels whole so the caller can see what narrowing would charge
  // before submitting.
  cost: validationCommandCostSchema,
  description: z.string().nullable(),
  pathArgs: z.enum(["forbid", "paths"]),
  changedScope: z.enum(["native", "full_fallback"]),
  timeoutMs: z.number().int().positive().nullable(),
  /** Whether the resolved caller (role/context) may submit this command. */
  enabled: z.boolean(),
});
export type ValidationListCommand = z.infer<typeof validationListCommandSchema>;

export const validationCapacitySchema = z.object({
  limit: z.number().int().positive(),
  /** Sum of running costs — the number admission compares against `limit`. */
  inUse: z.number().int().nonnegative(),
  queueDepth: z.number().int().nonnegative(),
});
export type ValidationCapacity = z.infer<typeof validationCapacitySchema>;

// Active (queued + running) runs across the whole server: the budget is
// global, so the run blocking a caller may belong to another project.
export const validationActiveRunSchema = z.object({
  runId: z.string().min(1),
  commandName: z.string().min(1),
  status: z.enum(["queued", "running"]),
  cost: z.number().int().positive(),
  source: validationRunSourceSchema,
  projectPath: z.string().min(1),
  conversationId: z.string().min(1).nullable(),
  requestedScope: validationScopeSchema.nullable(),
  effectiveScope: validationScopeSchema.nullable(),
  position: z.number().int().nonnegative().nullable(),
});
export type ValidationActiveRun = z.infer<typeof validationActiveRunSchema>;

export const validationListResponseSchema = z.object({
  commands: z.array(validationListCommandSchema),
  capacity: validationCapacitySchema,
  runs: z.array(validationActiveRunSchema),
});
export type ValidationListResponse = z.infer<
  typeof validationListResponseSchema
>;

// ============================================================
// Global budget read (topbar indicator)
// ============================================================

/**
 * One active run as the budget indicator needs it. Deliberately narrower than
 * `validationActiveRunSchema`: no scopes, no source, and `projectName` rather
 * than `projectPath` — the indicator names and links to work, it does not
 * reproduce the agent CLI's listing. `sessionName`/`conversationId` are both
 * nullable because system-owned runs (lane merge, Smart Merge, Smart Commit,
 * script validator) belong to a project and nothing finer.
 */
export const validationBudgetRunSchema = z.object({
  runId: z.string().min(1),
  commandName: z.string().min(1),
  status: z.enum(["queued", "running"]),
  cost: z.number().int().positive(),
  projectName: z.string().min(1),
  sessionName: z.string().min(1).nullable(),
  conversationId: z.string().min(1).nullable(),
  /** FIFO index among queued runs; null while running. */
  position: z.number().int().nonnegative().nullable(),
});
export type ValidationBudgetRun = z.infer<typeof validationBudgetRunSchema>;

export const validationBudgetResponseSchema = z.object({
  /**
   * False when startup recovery failed and admission is closed. The ledger may
   * still hold rows from before the failure, so the indicator hides rather
   * than reporting a capacity number that no longer governs anything.
   */
  available: z.boolean(),
  capacity: validationCapacitySchema,
  runs: z.array(validationBudgetRunSchema),
});
export type ValidationBudgetResponse = z.infer<
  typeof validationBudgetResponseSchema
>;
