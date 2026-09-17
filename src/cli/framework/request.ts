import type { CliError, Failure, ReportedRecovery } from "cli-for-agents";
import { protocolLimits } from "cli-for-agents";
import { instruction } from "cli-for-agents/guidance";
import { z } from "zod";
import type { CliRequestResult } from "../transport";
import type { CcErrorCode } from "./context";
import { ccErrors } from "./family";

export type CcFailedRequest = Exclude<CliRequestResult, { kind: "ok" }>;
export type CcRequestFailureOptions = { readonly errorCode?: CcErrorCode };

/** Required diagnostics fit the protocol reservation; full remote prose stays in detail. */
function diagnosticFits(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !/[\p{Cc}\p{Cs}]/u.test(value) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      protocolLimits.diagnosticSummary
  );
}

function instructionFits(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !/[\p{Cc}\p{Cs}]/u.test(value) &&
    new TextEncoder().encode(
      JSON.stringify({ ownerId: "cc-server-refusal", text: value }),
    ).byteLength <= protocolLimits.instruction
  );
}

export function ccRequestError(
  response: Exclude<CliRequestResult, { kind: "ok" }>,
  options: CcRequestFailureOptions = {},
): CliError<CcErrorCode> {
  if (response.kind === "connection") {
    return ccErrors.error("CC_CONNECTION", {
      message: "cannot reach the CC server — is the CC server running?",
      details: { detail: response.detail },
    });
  }
  if (response.kind === "auth") {
    return ccErrors.error("CC_CONNECTION", {
      message: response.hadToken
        ? `the server rejected the API token (source: ${response.tokenSource ?? "-"})`
        : "no API token — pass --token or set CC_API_TOKEN",
    });
  }
  if (response.kind === "version_mismatch") {
    return ccErrors.error("CC_BUILD_MISMATCH", {
      message: `this cctl is build ${response.cliBuild}; the server is build ${response.serverBuild}`,
      why: "Build parity prevents stale observations. Run cctl doctor to locate the server’s published binary.",
      details: {
        cliBuild: response.cliBuild,
        serverBuild: response.serverBuild,
      },
    });
  }
  const details = z.json().safeParse({
    status: response.status,
    ...(response.instruction && !instructionFits(response.instruction)
      ? { serverInstruction: response.instruction }
      : {}),
    ...(response.code ? { serverCode: response.code } : {}),
    ...(!diagnosticFits(response.error)
      ? { serverMessage: response.error }
      : {}),
    ...(response.rationale && !diagnosticFits(response.rationale)
      ? { serverRationale: response.rationale }
      : {}),
    ...(response.details ? { serverDetails: response.details } : {}),
    ...(response.issues ? { serverIssues: response.issues } : {}),
  });
  if (!details.success) {
    return ccErrors.error("CC_INVALID_RESPONSE", {
      message: "The server refusal contained non-JSON structured detail.",
    });
  }
  return ccErrors.error(
    response.code === "build_skew"
      ? "CC_BUILD_MISMATCH"
      : (options.errorCode ??
          ([400, 404, 422].includes(response.status)
            ? "CC_USAGE"
            : "CC_OPERATION_FAILED")),
    {
      message: diagnosticFits(response.error)
        ? response.error
        : `Command Center rejected the request (HTTP ${response.status}); see serverMessage.`,
      ...(response.code === "build_skew"
        ? {
            why: "The server refused this request before execution; no changes were made. Run cctl doctor to locate its published binary.",
          }
        : response.rationale && diagnosticFits(response.rationale)
          ? { why: response.rationale }
          : {}),
      details: details.data,
      ...(response.issues
        ? {
            issues: response.issues.map((issue) => ({
              code: "CC_INPUT_ISSUE",
              message: diagnosticFits(issue.message)
                ? issue.message
                : "Input rejected; see serverIssues for the complete diagnostic.",
              path: [issue.path],
            })),
          }
        : {}),
    },
  );
}

/** Server instructions arrive over the authenticated CC transport, not a local rule firing. */
export function ccRequestFailure(
  response: CcFailedRequest,
  options: CcRequestFailureOptions = {},
): Failure<never, CcErrorCode> {
  return {
    ok: false,
    error: ccRequestError(response, options),
    ...(response.kind === "error" && response.instruction
      ? {
          instruction: instruction(
            "cc-server-refusal",
            instructionFits(response.instruction)
              ? response.instruction
              : "Read the complete serverInstruction in the error details or response artifact and follow it before continuing.",
          ),
        }
      : {}),
  };
}

export type CcWriteFailure =
  | {
      readonly effect: "unknown";
      readonly recovery: ReportedRecovery;
      readonly result: Failure<never, CcErrorCode>;
    }
  | {
      readonly effect: "not_applied";
      readonly result: Failure<never, CcErrorCode>;
    };

export function ccWriteFailure(
  response: CcFailedRequest,
  recovery: ReportedRecovery,
  options: CcRequestFailureOptions = {},
): CcWriteFailure {
  const result = ccRequestFailure(response, options);
  if (
    response.kind === "connection" ||
    (response.kind === "error" && response.status >= 500)
  ) {
    return { effect: "unknown", recovery, result };
  }
  return { effect: "not_applied", result };
}
