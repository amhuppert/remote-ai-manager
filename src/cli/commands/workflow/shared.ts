import type {
  CommandSpec,
  Failure,
  JsonValue,
  HandlerInput,
  MutationHandler,
  PayloadReadHandler,
  ReadHandler,
  ReportedRecovery,
  WriteHandler,
} from "cli-for-agents";
import { z } from "zod";
import { seededWorkflowDocumentsSchema } from "@/lib/workflow-graph/seeded-documents";
import {
  cliRequest,
  encodePathSegment,
  type CliRequestParams,
  type LaneContext,
  type ProjectContext,
  type SessionContext,
} from "../../transport";
import { resolveCcPrincipal, type CcErrorCode } from "../../framework/context";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import {
  ccRequestFailure,
  ccWriteFailure,
  type CcFailedRequest,
  type CcWriteFailure,
} from "../../framework/request";

export type Input<S extends CommandSpec> = HandlerInput<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
export type Read<S extends CommandSpec> = ReadHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
export type Write<S extends CommandSpec> = WriteHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
export type PayloadRead<
  S extends CommandSpec,
  P = JsonObject,
> = PayloadReadHandler<
  S,
  CcApplication,
  P,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
export type Mutation<
  S extends CommandSpec,
  Prepared,
  P = JsonObject,
> = MutationHandler<
  S,
  CcApplication,
  Prepared,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  P
>;
export const jsonValueSchema = z.json().transform((value): JsonValue => value);
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export type JsonObject = z.infer<typeof jsonObjectSchema>;
export const planPayloadSchema = jsonObjectSchema.superRefine((value, ctx) => {
  const definition = value.definition;
  if (
    definition === null ||
    typeof definition !== "object" ||
    Array.isArray(definition) ||
    definition === undefined ||
    !("seededDocuments" in definition)
  )
    return;
  const parsed = seededWorkflowDocumentsSchema
    .optional()
    .safeParse(definition.seededDocuments);
  if (!parsed.success)
    for (const issue of parsed.error.issues)
      ctx.addIssue({
        code: "custom",
        path: ["definition", "seededDocuments", ...issue.path],
        message: issue.message,
      });
});
export const okSchema = z.object({ ok: z.literal(true) });
export function invalid(message: string): Failure<never, CcErrorCode> {
  return {
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", { message }),
  };
}
export function usage(message: string): Failure<never, CcErrorCode> {
  return { ok: false, error: ccErrors.error("CC_USAGE", { message }) };
}
export function graphPath(context: SessionContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/sessions/${encodePathSegment(context.session)}/graph-workflow`;
}
export function definitionsPath(context: ProjectContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/workflows`;
}
export function definitionPath(
  context: ProjectContext,
  tier: "global" | "project",
  id: string,
): string {
  return tier === "global"
    ? `/api/workflow-templates/${encodePathSegment(id)}`
    : `${definitionsPath(context)}/${encodePathSegment(id)}`;
}
export function lanePath(context: LaneContext): string {
  return `${graphPath(context)}/contexts/${encodePathSegment(context.contextId)}`;
}
export function principal(app: CcApplication) {
  return { principalIdentity: resolveCcPrincipal(app) };
}
export function callerHeaders(app: CcApplication) {
  const conversation = app.env["CC_CONVERSATION_ID"];
  const backend = app.env["CC_AGENT_BACKEND"];
  return conversation
    ? {
        headers: {
          "x-cc-conversation-id": conversation,
          ...(backend ? { "x-cc-agent-backend": backend } : {}),
        },
      }
    : {};
}
export function workflowFailure(
  response: CcFailedRequest,
  semantic = false,
): Failure<never, CcErrorCode> {
  return ccRequestFailure(
    response,
    semantic && response.kind === "error" && response.code
      ? { errorCode: "CC_OPERATION_FAILED" }
      : {},
  );
}
export async function readResponse<S extends z.ZodType>(
  app: CcApplication,
  request: CliRequestParams,
  schema: S,
  semantic = false,
): Promise<{ ok: true; data: z.infer<S> } | Failure<never, CcErrorCode>> {
  const response = await cliRequest(app.host, request);
  if (response.kind !== "ok") return workflowFailure(response, semantic);
  const parsed = schema.safeParse(response.body);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : invalid("The workflow endpoint returned an unreadable response.");
}
export type WorkflowWriteResult<T> =
  | CcWriteFailure
  | {
      effect: "applied";
      recovery: ReportedRecovery;
      result: { ok: true; data: T };
    };
export async function writeResponse<S extends z.ZodType>(
  app: CcApplication,
  request: CliRequestParams,
  schema: S,
  recovery: ReportedRecovery,
  semantic = false,
): Promise<WorkflowWriteResult<z.infer<S>>> {
  const response = await cliRequest(app.host, request);
  if (response.kind !== "ok") {
    const failed = ccWriteFailure(response, recovery);
    return { ...failed, result: workflowFailure(response, semantic) };
  }
  const parsed = schema.safeParse(response.body);
  return parsed.success
    ? { effect: "applied", recovery, result: { ok: true, data: parsed.data } }
    : {
        effect: "unknown",
        recovery,
        result: invalid(
          "The workflow write acknowledgement is unreadable. Inspect the addressed resource before retrying.",
        ),
      };
}
export function parseInputBindings(
  text: string | undefined,
): { ok: true; data: JsonObject | undefined } | Failure<never, CcErrorCode> {
  if (text === undefined) return { ok: true, data: undefined };
  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(text));
    return parsed.success
      ? { ok: true, data: parsed.data }
      : usage("Input bindings must be a JSON object.");
  } catch {
    return usage("Input bindings must be valid JSON.");
  }
}
