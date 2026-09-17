import {
  invocation,
  protocolLimits,
  type Failure,
  type Invocation,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { renderInvocation } from "cli-for-agents/runtime";
import { z } from "zod";
import {
  memoryLifecycleSchema,
  memoryScopeSchema,
  type MemoryScope,
} from "@/lib/memory/schemas";
import type { CcErrorCode, explicitScopeFlags } from "../../framework/context";
import {
  ccRequestFailure,
  type CcFailedRequest,
} from "../../framework/request";
import { memoryGetCommand, memoryListCommand } from "./definitions";

export type MemoryRecovery = (
  slug: string,
  scope: MemoryScope,
) => Invocation | null;
const candidatesSchema = z.object({
  candidates: z.array(
    z.object({
      slug: z.string().min(1),
      scope: memoryScopeSchema,
      lifecycle: memoryLifecycleSchema,
    }),
  ),
});
const staleSchema = z.object({
  slug: z.string().min(1),
  currentRevision: z.number().int().positive(),
});

export function memoryFailure(
  response: CcFailedRequest,
  recover?: MemoryRecovery,
  scopeFlags: ReturnType<typeof explicitScopeFlags> = {},
): Failure<never, CcErrorCode> {
  let visible = response;
  if (response.kind === "error" && response.code === "not_found") {
    const details = z.record(z.string(), z.json()).safeParse(response.details);
    visible = {
      ...response,
      ...(details.success
        ? {
            details: Object.fromEntries(
              Object.entries(details.data).filter(([key]) => key !== "handle"),
            ),
          }
        : {}),
    };
  }
  const failure = ccRequestFailure(
    visible,
    response.kind === "error" && response.code === "not_found"
      ? { errorCode: "CC_OPERATION_FAILED" }
      : {},
  );
  if (response.kind !== "error") return failure;
  if (response.code === "ambiguous_handle") {
    const parsed = candidatesSchema.safeParse(response.details);
    if (parsed.success) {
      const recoveries = parsed.data.candidates.map((candidate) => {
        const narrowed = recover?.(candidate.slug, candidate.scope);
        const command = renderInvocation(
          narrowed ??
            invocation(memoryGetCommand, {
              args: { slug: candidate.slug },
              flags: { ...scopeFlags, scope: candidate.scope },
            }),
          "cctl",
        );
        const message =
          narrowed === null
            ? `Repeat the original command with --scope=${candidate.scope}; inspect ${command}.`
            : `${candidate.slug} [${candidate.scope}] ${candidate.lifecycle}: ${command}`;
        const fits =
          !/[\p{Cc}\p{Cs}]/u.test(message) &&
          new TextEncoder().encode(JSON.stringify(message)).byteLength <=
            protocolLimits.diagnosticSummary;
        return { ...candidate, command, message, fits };
      });
      const expanded = recoveries.filter((recovery) => !recovery.fits);
      return {
        ...failure,
        error: {
          ...failure.error,
          ...(expanded.length
            ? {
                details: {
                  ...z
                    .record(z.string(), z.json())
                    .parse(failure.error.details ?? {}),
                  memoryRecoveries: expanded.map(
                    ({ slug, scope, lifecycle, command }) => ({
                      slug,
                      scope,
                      lifecycle,
                      command,
                    }),
                  ),
                },
              }
            : {}),
          issues: [
            ...(failure.error.issues ?? []),
            ...recoveries.map((recovery) => ({
              code: "MEMORY_SCOPE_CANDIDATE",
              message: recovery.fits
                ? recovery.message
                : `Narrow to --scope=${recovery.scope}; the complete command is in memoryRecoveries.`,
            })),
          ],
        },
      };
    }
  }
  if (response.code === "stale_revision") {
    const parsed = staleSchema.safeParse(response.details);
    if (parsed.success)
      return {
        ...failure,
        error: {
          ...failure.error,
          issues: [
            ...(failure.error.issues ?? []),
            {
              code: "MEMORY_CURRENT_REVISION",
              message: `Read ${renderInvocation(invocation(memoryGetCommand, { args: { slug: parsed.data.slug }, flags: scopeFlags }), "cctl")} before retrying with --if-revision=${parsed.data.currentRevision}.`,
            },
          ],
        },
      };
  }
  if (response.code === "not_found" && failure.instruction === undefined)
    return {
      ...failure,
      hint: hint(
        invocation(memoryListCommand, { flags: scopeFlags }),
        "List visible memory slugs",
      ),
    };
  return failure;
}
