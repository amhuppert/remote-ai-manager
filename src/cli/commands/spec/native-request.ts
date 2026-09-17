import type { Failure } from "cli-for-agents";
import type { z } from "zod";
import { specSlugSchema } from "@/lib/specs/handles";
import { createLogger } from "@/lib/logging";
import {
  cliRequest,
  encodePathSegment,
  type ProjectContext,
  type CliRequestParams,
} from "../../transport";
import { resolveCcProject, type CcErrorCode } from "../../framework/context";
import { ccErrors, type CcApplication } from "../../framework/family";
import { ccRequestFailure } from "../../framework/request";

const logger = createLogger("cli.spec");
export type SpecJsonResult<T> =
  | { readonly ok: true; readonly data: T }
  | Failure<never, CcErrorCode>;

export function specPath(project: string, slug: string): string {
  return `/api/specs/${encodePathSegment(project)}/${encodePathSegment(slug)}`;
}

export async function readSpecJson<T>(
  app: CcApplication,
  path: (context: ProjectContext) => string,
  schema: z.ZodType<T>,
  slug?: string,
): Promise<SpecJsonResult<T>> {
  if (slug !== undefined && !specSlugSchema.safeParse(slug).success)
    return {
      ok: false,
      error: ccErrors.error("CC_USAGE", {
        message: `Invalid spec slug ${JSON.stringify(slug)}.`,
      }),
    };
  const resolved = await resolveCcProject(app);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return requestSpecJson(
    app,
    { ...resolved.value, method: "GET", path: path(resolved.value) },
    schema,
  );
}

export async function requestSpecJson<T>(
  app: CcApplication,
  request: CliRequestParams,
  schema: z.ZodType<T>,
): Promise<SpecJsonResult<T>> {
  const response = await cliRequest(app.host, request);
  if (response.kind !== "ok") return ccRequestFailure(response);
  const parsed = schema.safeParse(response.body);
  if (!parsed.success) {
    logger.debug("cli.spec.invalid_response", {
      path: request.path,
      issueCount: parsed.error.issues.length,
    });
    return {
      ok: false,
      error: ccErrors.error("CC_INVALID_RESPONSE", {
        message: "The spec endpoint returned an invalid response.",
        issues: parsed.error.issues.map((issue) => ({
          code: "CC_RESPONSE_ISSUE",
          path: issue.path.map(String),
          message: issue.message,
        })),
      }),
    };
  }
  logger.debug("cli.spec.read_complete", { path: request.path });
  return { ok: true, data: parsed.data };
}
