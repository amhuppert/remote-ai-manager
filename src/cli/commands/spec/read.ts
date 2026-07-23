import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { createLogger } from "@/lib/logging";
import {
  formatElementHandle,
  parseElementHandle,
  specSlugSchema,
} from "@/lib/specs/handles";
import { specMeasuresReportSchema } from "@/lib/specs/measures";
import {
  canonicalSpecBundleSchema,
  integrityReportSchema,
  specDetailViewSchema,
  specElementGetResponseSchema,
  specInventoryViewSchema,
  specSearchViewSchema,
  specStatusViewSchema,
  specSummaryViewSchema,
  type CanonicalSpecBundle,
  type SpecStatusView,
} from "@/lib/specs/view-schemas";
import { flagNamesFor } from "../../help-registry";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  render,
  resolveProjectContext,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
  type ProjectContext,
  type RequestIssue,
} from "../../shared";

const logger = createLogger("cli.spec");
const specShowResponseSchema = z.union([
  specDetailViewSchema,
  specSummaryViewSchema,
]);

type ReadResult<T> = { ok: true; value: T } | { ok: false; result: CliResult };

function specBasePath(context: ProjectContext, slug: string): string {
  return `/api/specs/${encodePathSegment(context.project)}/${encodePathSegment(slug)}`;
}

function validateSlug(
  input: string | undefined,
  command: string,
  json: boolean,
): ReadResult<string> {
  if (input === undefined) {
    return {
      ok: false,
      result: usageFailure(`spec ${command} requires <slug>`, json),
    };
  }
  const parsed = specSlugSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      result: usageFailure(
        `spec ${command}: invalid spec slug ${JSON.stringify(input)}`,
        json,
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

function noExtraPositionals(
  rest: string[],
  expected: number,
  command: string,
  json: boolean,
): CliResult | null {
  if (rest.length === expected) return null;
  return usageFailure(`spec ${command} received unexpected arguments`, json);
}

async function requestTyped<T>(
  host: CliHost,
  context: ProjectContext,
  path: string,
  schema: z.ZodType<T>,
  command: string,
  json: boolean,
): Promise<ReadResult<T>> {
  const response = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path,
  });
  if (response.kind !== "ok") {
    return { ok: false, result: failureFromRequest(response, json) };
  }
  const parsed = schema.safeParse(response.body);
  if (!parsed.success) {
    logger.debug("cli.spec.invalid_response", {
      command,
      issueCount: parsed.error.issues.length,
    });
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `spec ${command} returned an unexpected response — is the CC server the same build as this CLI?`,
        code: "invalid_response",
        json,
      }),
    };
  }
  return { ok: true, value: parsed.data };
}

function statusText(status: SpecStatusView): string {
  const lines = [
    `${status.slug}  phase: ${status.phase.primary}`,
    ...(status.phase.authoringStage === undefined
      ? []
      : [
          `authoring stage: ${status.phase.authoringStage} (concluding gate: ${status.phase.authoringStage})`,
        ]),
    `coverage: ${status.coverage.coveredCriteria}/${status.coverage.totalCriteria} (${status.coverage.percentage}%)`,
    "gates:",
    ...status.gates.map(
      (gate) => `  ${gate.gate}: ${gate.state} (${gate.dial})`,
    ),
    "pending approvals:",
    ...(status.pendingApprovals.length === 0
      ? ["  none"]
      : status.pendingApprovals.map(
          (approval) => `  ${approval.gate}: ${approval.subject}`,
        )),
    "open questions:",
    ...(status.openQuestions.length === 0
      ? ["  none"]
      : status.openQuestions.map(
          (question) => `  ${question.handle}: ${question.text}`,
        )),
    "assumptions:",
    ...(status.assumptions.length === 0
      ? ["  none"]
      : status.assumptions.map(
          (assumption) =>
            `  ${assumption.handle} [${assumption.disposition}]: ${assumption.text}`,
        )),
    "plan tasks:",
    ...(status.taskPlan.length === 0
      ? ["  none"]
      : status.taskPlan.flatMap((task) => [
          `  ${task.handle}: ${task.title}`,
          `    dependencies: ${task.dependsOn.join(", ") || "none"}`,
          `    lane group: ${task.laneGroup ?? "one task per lane"}`,
          `    touched surfaces: ${task.touchedPaths.join(", ") || "not declared"}`,
          `    criterion coverage: ${task.criterionCoverage.join(", ") || "none"}`,
        ])),
  ];
  return `${lines.join("\n")}\n`;
}

function mismatchIssues(
  report: z.infer<typeof integrityReportSchema>,
): RequestIssue[] {
  return report.mismatches.map((mismatch) => ({
    path: `revisions.${mismatch.revisionId}`,
    message:
      mismatch.mismatchedElementIds.length === 0
        ? "revision content hash does not match"
        : `payload hash mismatch for ${mismatch.mismatchedElementIds.join(", ")}`,
  }));
}

function integrityFailure(
  message: string,
  instruction: string,
  details: Record<string, unknown>,
  issues: RequestIssue[],
  json: boolean,
): CliResult {
  return failure({
    exitCode: EXIT_OPERATION_FAILED,
    message,
    code: "integrity_mismatch",
    instruction,
    details,
    ...(issues.length > 0
      ? {
          issues,
          detail: issues
            .map((issue) => `  ${issue.path}: ${issue.message}`)
            .join("\n"),
        }
      : {}),
    json,
  });
}

async function readBundleFile(
  host: CliHost,
  filePath: string,
  json: boolean,
): Promise<ReadResult<CanonicalSpecBundle>> {
  const raw = await host.readTextFile(filePath);
  if (raw === null) {
    return {
      ok: false,
      result: usageFailure(
        `spec verify: cannot read --against file ${JSON.stringify(filePath)}`,
        json,
      ),
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      result: usageFailure(
        `spec verify: --against file ${JSON.stringify(filePath)} is not valid JSON`,
        json,
      ),
    };
  }
  const parsed = canonicalSpecBundleSchema.safeParse(decoded);
  if (!parsed.success) {
    return {
      ok: false,
      result: usageFailure(
        `spec verify: --against file ${JSON.stringify(filePath)} is not a canonical spec bundle`,
        json,
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

export async function runSpecList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec list"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 0, "list", json);
  if (extra) return extra;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    `/api/specs/${encodePathSegment(resolved.context.project)}`,
    specInventoryViewSchema,
    "list",
    json,
  );
  if (!response.ok) return response.result;
  logger.debug("cli.spec.read_complete", {
    command: "list",
    specCount: response.value.specs.length,
  });
  const human =
    response.value.specs.length === 0
      ? "no specs\n"
      : `${response.value.specs
          .map(
            (item) =>
              `${item.spec.slug}\t${item.phase.primary}\t${item.spec.name}`,
          )
          .join("\n")}\n`;
  return {
    exitCode: EXIT_OK,
    stdout: render(json, human, { ok: true, specs: response.value.specs }),
    stderr: "",
  };
}

export async function runSpecMeasures(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec measures"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 0, "measures", json);
  if (extra) return extra;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    `/api/projects/${encodePathSegment(resolved.context.project)}/spec-measures`,
    specMeasuresReportSchema,
    "measures",
    json,
  );
  if (!response.ok) return response.result;
  const report = response.value;
  logger.info("cli.spec.measures_complete", {
    definitionsVersion: report.definitionsVersion,
    deliveredCriterionCount:
      report.traceabilityCompleteness.deliveredInScopeCriterionCount,
    completeChainCount: report.traceabilityCompleteness.completeChainCount,
    navigationChainCount: report.navigationChains.length,
  });
  const traceabilityShare = report.traceabilityCompleteness.share;
  const evidenceShare = report.automaticEvidenceCapture.share;
  const human = [
    `definitions: ${report.definitionsVersion}`,
    `requirement-caused rework: ${report.requirementCausedRework.totalReworkEventCount}`,
    `approval friction: ${report.approvalFriction.activeReviewTimeMs}ms active, ${report.approvalFriction.interventionCount} interventions, ${report.approvalFriction.reapprovalLoopCount} re-approval loops`,
    `traceability completeness: ${traceabilityShare === null ? "n/a" : `${(traceabilityShare * 100).toFixed(1)}%`} (${report.traceabilityCompleteness.completeChainCount}/${report.traceabilityCompleteness.deliveredInScopeCriterionCount})`,
    `automatic evidence capture: ${evidenceShare === null ? "n/a" : `${(evidenceShare * 100).toFixed(1)}%`} (${report.automaticEvidenceCapture.automaticallyIngestedCount}/${report.automaticEvidenceCapture.totalEvidenceCount})`,
    `reviewer navigation chains: ${report.navigationChains.length}`,
  ].join("\n");
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${human}\n`, { ok: true, ...report }),
    stderr: "",
  };
}

export async function runSpecShow(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec show"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "show", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "show", json);
  if (!slug.ok) return slug.result;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const summary = values["summary"] === "true";
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}${summary ? "/summary" : ""}`,
    specShowResponseSchema,
    "show",
    json,
  );
  if (!response.ok) return response.result;
  logger.debug("cli.spec.read_complete", {
    command: "show",
    slug: slug.value,
    summary,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${JSON.stringify(response.value, null, 2)}\n`, {
      ok: true,
      spec: response.value,
    }),
    stderr: "",
  };
}

export async function runSpecStatus(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec status"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "status", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "status", json);
  if (!slug.ok) return slug.result;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/status`,
    specStatusViewSchema,
    "status",
    json,
  );
  if (!response.ok) return response.result;
  logger.debug("cli.spec.read_complete", {
    command: "status",
    slug: slug.value,
    pendingApprovalCount: response.value.pendingApprovals.length,
    openQuestionCount: response.value.openQuestions.length,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, statusText(response.value), {
      ok: true,
      status: response.value,
    }),
    stderr: "",
  };
}

function parseGetTarget(
  rest: string[],
  json: boolean,
): ReadResult<{ slug: string; handle: string }> {
  if (rest.length !== 1 && rest.length !== 2) {
    return {
      ok: false,
      result: usageFailure(
        "spec get requires <slug>/<handle> or <slug> <handle>",
        json,
      ),
    };
  }
  try {
    const parsed =
      rest.length === 1
        ? parseElementHandle(rest[0] ?? "")
        : parseElementHandle(rest[1] ?? "", rest[0]);
    return {
      ok: true,
      value: {
        slug: parsed.slug,
        handle: formatElementHandle(parsed, "bare"),
      },
    };
  } catch {
    return {
      ok: false,
      result: usageFailure("spec get: invalid spec element handle", json),
    };
  }
}

export async function runSpecGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec get"), json);
  if (denied) return denied;
  const target = parseGetTarget(rest, json);
  if (!target.ok) return target.result;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, target.value.slug)}/elements/${encodePathSegment(target.value.handle)}`,
    specElementGetResponseSchema,
    "get",
    json,
  );
  if (!response.ok) return response.result;
  logger.debug("cli.spec.read_complete", {
    command: "get",
    slug: target.value.slug,
    handle: target.value.handle,
    evidenceStateCount:
      "evidenceState" in response.value
        ? response.value.evidenceState.length
        : 0,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${JSON.stringify(response.value, null, 2)}\n`, {
      ok: true,
      element: response.value,
    }),
    stderr: "",
  };
}

export async function runSpecSearch(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec search"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 2, "search", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "search", json);
  if (!slug.ok) return slug.result;
  const query = rest[1]?.trim() ?? "";
  if (query.length === 0) {
    return usageFailure("spec search requires a non-empty <query>", json);
  }
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const params = new URLSearchParams({ q: query });
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/search?${params.toString()}`,
    specSearchViewSchema,
    "search",
    json,
  );
  if (!response.ok) return response.result;
  logger.debug("cli.spec.read_complete", {
    command: "search",
    slug: slug.value,
    queryLength: query.length,
    resultCount: response.value.results.length,
  });
  const human =
    response.value.results.length === 0
      ? "no matches\n"
      : `${response.value.results
          .map((match) => `${match.handle}\t${match.kind}\t${match.text}`)
          .join("\n")}\n`;
  return {
    exitCode: EXIT_OK,
    stdout: render(json, human, { ok: true, search: response.value }),
    stderr: "",
  };
}

export async function runSpecExport(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec export"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "export", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "export", json);
  if (!slug.ok) return slug.result;
  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/export`,
    canonicalSpecBundleSchema,
    "export",
    json,
  );
  if (!response.ok) return response.result;
  const out = values["out"];
  if (out !== undefined) {
    if (host.writeTextFile === undefined) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: "spec export: this CLI host cannot write --out files",
        code: "write_unavailable",
        json,
      });
    }
    try {
      await host.writeTextFile(
        out,
        `${JSON.stringify(response.value, null, 2)}\n`,
      );
    } catch {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `spec export: could not write ${JSON.stringify(out)}`,
        code: "write_failed",
        json,
      });
    }
  }
  logger.debug("cli.spec.read_complete", {
    command: "export",
    slug: slug.value,
    markdownFileCount: response.value.markdownFiles.length,
    wroteOutput: out !== undefined,
  });
  const human =
    out === undefined
      ? `${JSON.stringify(response.value, null, 2)}\n`
      : `exported ${slug.value} to ${out}\n`;
  return {
    exitCode: EXIT_OK,
    stdout: render(json, human, {
      ok: true,
      bundle: response.value,
      ...(out === undefined ? {} : { out }),
    }),
    stderr: "",
  };
}

export async function runSpecVerify(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec verify"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "verify", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "verify", json);
  if (!slug.ok) return slug.result;
  const againstPath = values["against"];
  const against =
    againstPath === undefined
      ? undefined
      : await readBundleFile(host, againstPath, json);
  if (against !== undefined && !against.ok) return against.result;

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const report = await requestTyped(
    host,
    resolved.context,
    `${specBasePath(resolved.context, slug.value)}/verify`,
    integrityReportSchema,
    "verify",
    json,
  );
  if (!report.ok) return report.result;
  if (!report.value.ok) {
    logger.debug("cli.spec.integrity_mismatch", {
      slug: slug.value,
      mismatchCount: report.value.mismatches.length,
    });
    return integrityFailure(
      `spec ${slug.value} failed integrity verification`,
      "Restore the approved revision content from a trusted export before continuing.",
      { report: report.value },
      mismatchIssues(report.value),
      json,
    );
  }

  if (against !== undefined && against.ok) {
    const current = await requestTyped(
      host,
      resolved.context,
      `${specBasePath(resolved.context, slug.value)}/export`,
      canonicalSpecBundleSchema,
      "verify",
      json,
    );
    if (!current.ok) return current.result;
    if (!isDeepStrictEqual(current.value, against.value)) {
      logger.debug("cli.spec.integrity_mismatch", {
        slug: slug.value,
        against: againstPath ?? null,
        mismatchKind: "export",
      });
      return integrityFailure(
        `spec ${slug.value} differs from ${againstPath}`,
        "Review the live spec or export a fresh canonical bundle before continuing.",
        { against: againstPath },
        [{ path: "bundle", message: "current canonical export differs" }],
        json,
      );
    }
  }

  logger.debug("cli.spec.read_complete", {
    command: "verify",
    slug: slug.value,
    checkedRevisionCount: report.value.checkedRevisionIds.length,
    comparedExport: againstPath !== undefined,
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `verified ${slug.value}\n`, {
      ok: true,
      report: report.value,
      ...(againstPath === undefined ? {} : { against: againstPath }),
    }),
    stderr: "",
  };
}
