/**
 * Shared gate result vocabulary for the workflow primitive layer.
 *
 * Normalizes every reusable workflow checkpoint outcome as `pass`, `fail`, or
 * `pause`. The pause case carries the same `pauseKind` distinction surfaced by
 * the AgentCall vocabulary so workflows and UIs can resume the correct state:
 *
 *  - `mid_turn` pauses interrupt an in-flight backend turn (the canonical
 *    example is a backend asking the user a question while the agent is still
 *    generating). The owning workflow keeps that turn live and resumes inline.
 *  - `post_turn` pauses occur between steps of a workflow (the canonical
 *    example is a human-approval gate after a step completes). The owning
 *    workflow holds the next step until the pause is released.
 *
 * Two invariants on the gate kind enforce the mid-turn / post-turn split so
 * the rest of the primitive layer (and any feature adapter) cannot collapse
 * the two pause shapes by accident:
 *
 *  - `ask_user` gates are always `mid_turn` pauses.
 *  - `human_approval` gates are always `post_turn` pauses.
 *
 * Other gate kinds choose the shape that matches their semantics at the call
 * site (for example, a circuit-breaker gate may expose a `post_turn` pause
 * waiting for human inspection).
 */

import { z } from "zod";
import { pauseKindSchema, type PauseKind } from "./agent-call-vocabulary";

export const GATE_KINDS = [
  "structured_output",
  "ask_user",
  "human_approval",
  "script_validation",
  "change_set",
  "convergence",
  "circuit_breaker",
] as const;

export const gateKindSchema = z.enum(GATE_KINDS);
export type GateKind = z.infer<typeof gateKindSchema>;

const detailsSchema = z.record(z.string(), z.unknown());

const gatePassSchema = z
  .object({
    status: z.literal("pass"),
    kind: gateKindSchema,
    details: detailsSchema.optional(),
  })
  .strict();

const gateFailSchema = z
  .object({
    status: z.literal("fail"),
    kind: gateKindSchema,
    reason: z.string().min(1),
    details: detailsSchema.optional(),
  })
  .strict();

const gatePauseSchema = z
  .object({
    status: z.literal("pause"),
    kind: gateKindSchema,
    pauseKind: pauseKindSchema,
    resumeToken: z.string().min(1),
    details: detailsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "ask_user" && value.pauseKind !== "mid_turn") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ask_user gate pauses must be mid_turn",
        path: ["pauseKind"],
      });
    }
    if (value.kind === "human_approval" && value.pauseKind !== "post_turn") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "human_approval gate pauses must be post_turn",
        path: ["pauseKind"],
      });
    }
  });

export const gateResultSchema = z.discriminatedUnion("status", [
  gatePassSchema,
  gateFailSchema,
  gatePauseSchema,
]);
export type GateResult = z.infer<typeof gateResultSchema>;
export type GatePassResult = Extract<GateResult, { status: "pass" }>;
export type GateFailResult = Extract<GateResult, { status: "fail" }>;
export type GatePauseResult = Extract<GateResult, { status: "pause" }>;

export interface GatePassInput {
  kind: GateKind;
  details?: Record<string, unknown>;
}

export interface GateFailInput {
  kind: GateKind;
  reason: string;
  details?: Record<string, unknown>;
}

type MidTurnGateKind = Exclude<GateKind, "human_approval">;
type PostTurnGateKind = Exclude<GateKind, "ask_user">;

export interface GatePauseMidTurnInput {
  kind: MidTurnGateKind;
  resumeToken: string;
  details?: Record<string, unknown>;
}

export interface GatePausePostTurnInput {
  kind: PostTurnGateKind;
  resumeToken: string;
  details?: Record<string, unknown>;
}

export function gatePass(input: GatePassInput): GatePassResult {
  return gatePassSchema.parse({
    status: "pass",
    kind: input.kind,
    ...(input.details !== undefined ? { details: input.details } : {}),
  });
}

export function gateFail(input: GateFailInput): GateFailResult {
  return gateFailSchema.parse({
    status: "fail",
    kind: input.kind,
    reason: input.reason,
    ...(input.details !== undefined ? { details: input.details } : {}),
  });
}

export function gatePauseMidTurn(
  input: GatePauseMidTurnInput,
): GatePauseResult {
  return gatePauseSchema.parse({
    status: "pause",
    kind: input.kind,
    pauseKind: "mid_turn" satisfies PauseKind,
    resumeToken: input.resumeToken,
    ...(input.details !== undefined ? { details: input.details } : {}),
  });
}

export function gatePausePostTurn(
  input: GatePausePostTurnInput,
): GatePauseResult {
  return gatePauseSchema.parse({
    status: "pause",
    kind: input.kind,
    pauseKind: "post_turn" satisfies PauseKind,
    resumeToken: input.resumeToken,
    ...(input.details !== undefined ? { details: input.details } : {}),
  });
}

export function isPauseGateResult(
  result: GateResult,
): result is GatePauseResult {
  return result.status === "pause";
}
