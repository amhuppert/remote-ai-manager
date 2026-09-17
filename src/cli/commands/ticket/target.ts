import type {
  CommandSpec,
  HandlerInput,
  ReadHandler,
  WriteHandler,
} from "cli-for-agents";
import { parseTicketIdentifier } from "@/lib/tickets/references";
import { encodePathSegment } from "../../transport";
import {
  resolveCcProject,
  resolveCcServer,
  type CcErrorCode,
  type CcContextResult,
} from "../../framework/context";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import {
  ccRequestFailure,
  ccWriteFailure,
  type CcFailedRequest,
} from "../../framework/request";
import type { ReportedRecovery } from "cli-for-agents";
import type { TokenSource } from "../../transport";
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
export type { CcErrorCode };
export interface TicketTarget {
  server: string;
  token: string | null;
  tokenSource: TokenSource | null;
  projectName: string;
  number: number;
}
export function usage(message: string) {
  return { ok: false, error: ccErrors.error("CC_USAGE", { message }) } as const;
}
export function invalid(what: string) {
  return {
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", {
      message: `The ${what} response is invalid.`,
    }),
  } as const;
}
export function identifier(ticket: {
  readonly projectName: string;
  readonly number: number;
}) {
  return `${ticket.projectName}#${ticket.number}`;
}
export function ticketPath(project: string, number?: number) {
  return `/api/projects/${encodePathSegment(project)}/tickets${number === undefined ? "" : `/${number}`}`;
}
export function targetPath(target: TicketTarget, suffix = "") {
  return `${ticketPath(target.projectName, target.number)}${suffix}`;
}
export async function resolveTicket(
  app: CcApplication,
  raw: string,
): Promise<CcContextResult<TicketTarget>> {
  if (raw.includes("#")) {
    const parsed = parseTicketIdentifier(raw);
    if (!parsed)
      return usage(
        `Invalid ticket reference "${raw}"; use a number or project#number.`,
      );
    const resolved = await resolveCcServer(app);
    return resolved.ok
      ? {
          ok: true,
          value: {
            ...resolved.value,
            projectName: parsed.projectName,
            number: parsed.ticketNumber,
          },
        }
      : resolved;
  }
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    return usage(
      `Invalid ticket reference "${raw}"; use a number or project#number.`,
    );
  const resolved = await resolveCcProject(app);
  return resolved.ok
    ? {
        ok: true,
        value: {
          ...resolved.value,
          projectName: resolved.value.project,
          number: Number(raw),
        },
      }
    : resolved;
}
const semanticCodes = new Set([
  "relationship_self_link",
  "relationship_scope",
  "relationship_conflict",
  "relationship_cycle",
  "status_update_actor_required",
  "status_update_actor_not_found",
]);
function refusalOptions(response: CcFailedRequest) {
  if (response.kind !== "error") return {};
  const operationRefusal =
    (response.status === 404 &&
      ["ticket_not_found", "attachment_not_found"].includes(
        response.code ?? "",
      )) ||
    (response.status === 400 && semanticCodes.has(response.code ?? ""));
  return operationRefusal ? { errorCode: "CC_OPERATION_FAILED" as const } : {};
}
export function ticketFailure(response: CcFailedRequest) {
  return ccRequestFailure(response, refusalOptions(response));
}
export function ticketWriteFailure(
  response: CcFailedRequest,
  recovery: ReportedRecovery,
) {
  return ccWriteFailure(response, recovery, refusalOptions(response));
}
