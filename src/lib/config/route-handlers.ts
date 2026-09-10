/**
 * Config route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createConfigRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readConfig as defaultReadConfig,
  readRawConfig as defaultReadRawConfig,
  canonicalizeRawGlobalConfig,
  materializeGlobalConfig,
  writeRawConfig as defaultWriteRawConfig,
} from "@/lib/config/loader";
import { intersectKeys } from "@/lib/config/cascade";
import { deepEqualJson } from "@/lib/shared/deep-equal";
import { assertBackendExecution } from "@/lib/agent-backends/task-execution";
import { BackendAdmissionError } from "@/lib/agent-backends/execution-admission";
import {
  namingExecutionRequirements,
  compactionExecutionRequirements,
  compactionRepairRequirements,
} from "./task-admission";
import { resolveCompactionConfig } from "./cascade";
import { resolveConversationNamingConfig } from "./schemas";
import { rawGlobalConfigSchema } from "@/lib/config/schemas";
import type { GlobalConfig, RawGlobalConfig } from "@/lib/config/schemas";
import { createLogger, withTracing } from "@/lib/logging";
import {
  createAssignmentReferenceChecker,
  type AssignmentReferenceChecker,
} from "@/lib/workflow-graph/assignment-references";

const log = createLogger("config");

function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ConfigRouteDeps {
  readConfig(): Promise<GlobalConfig>;
  readRawConfig(): Promise<RawGlobalConfig>;
  writeRawConfig(config: RawGlobalConfig): Promise<void>;
  assignmentReferences?: AssignmentReferenceChecker;
}

const defaultDeps: ConfigRouteDeps = {
  readConfig: defaultReadConfig,
  readRawConfig: defaultReadRawConfig,
  writeRawConfig: defaultWriteRawConfig,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createConfigRouteHandlers(deps: ConfigRouteDeps = defaultDeps) {
  const assignmentReferences =
    deps.assignmentReferences ?? createAssignmentReferenceChecker();
  async function GET(): Promise<Response> {
    try {
      const [config, raw] = await Promise.all([
        deps.readConfig(),
        deps.readRawConfig(),
      ]);
      return NextResponse.json({ config, raw });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to read config";
      log.error("config.read_error", { error: message });
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  async function PUT(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const validation = rawGlobalConfigSchema.safeParse(body);
    if (!validation.success) {
      const detail = formatValidationIssues(validation.error);
      log.warn("config.update_validation_error", { error: detail });
      return NextResponse.json(
        { error: `Invalid config: ${detail}` },
        { status: 400 },
      );
    }

    // Strip Zod-injected defaults so only user-submitted keys are persisted.
    const stripped = intersectKeys(body, validation.data) as RawGlobalConfig;
    let canonical: RawGlobalConfig;
    try {
      canonical = canonicalizeRawGlobalConfig(stripped);
    } catch (err) {
      const detail =
        err instanceof z.ZodError
          ? formatValidationIssues(err)
          : err instanceof Error
            ? err.message
            : "Invalid effective config";
      log.warn("config.update_effective_validation_error", { error: detail });
      return NextResponse.json(
        { error: `Invalid config: ${detail}` },
        { status: 400 },
      );
    }

    const previous = materializeGlobalConfig(await deps.readRawConfig());
    const candidate = materializeGlobalConfig(canonical);
    const naming = resolveConversationNamingConfig(candidate);
    const previousNaming = resolveConversationNamingConfig(previous);
    const namingSelectionChanged =
      naming.backend !== previousNaming.backend ||
      !deepEqualJson(naming.modelSelection, previousNaming.modelSelection);
    const compaction = resolveCompactionConfig(candidate);
    try {
      if (
        namingSelectionChanged ||
        (naming.enabled && !deepEqualJson(naming, previousNaming))
      )
        await assertBackendExecution(
          naming.backend,
          namingExecutionRequirements,
        );
      if (!deepEqualJson(compaction, resolveCompactionConfig(previous))) {
        await assertBackendExecution(
          compaction.backend,
          compactionExecutionRequirements,
        );
        await assertBackendExecution(
          compaction.backend,
          compactionRepairRequirements,
        );
      }
    } catch (error) {
      if (!(error instanceof BackendAdmissionError)) throw error;
      return NextResponse.json(
        { error: error.message, code: error.code, refusal: error.refusal },
        { status: 400 },
      );
    }

    // Canonicalization proves the effective config and its model selections;
    // profile existence still needs the async library. `workflowDefaults` is a
    // global-scope document — it applies to every project — so it is held to
    // the global tier-scope rule.
    const referenceIssues = await assignmentReferences.checkWorkflowDefaults(
      canonical.workflowDefaults,
    );
    if (referenceIssues.length > 0) {
      const detail = referenceIssues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ");
      log.warn("config.update_assignment_reference_error", {
        paths: referenceIssues.map((issue) => issue.path),
      });
      return NextResponse.json(
        { error: `Invalid config: ${detail}` },
        { status: 400 },
      );
    }

    try {
      await deps.writeRawConfig(canonical);
      log.info("config.updated", {
        fieldCount: Object.keys(canonical).length,
        ...(canonical.compaction ? { compaction: canonical.compaction } : {}),
      });

      const [config, raw] = await Promise.all([
        deps.readConfig(),
        deps.readRawConfig(),
      ]);
      return NextResponse.json({ config, raw });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to write config";
      log.error("config.write_error", { error: message });
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  return { GET, PUT };
}

const defaultHandlers = createConfigRouteHandlers();

/** GET /api/config — returns full merged config + raw explicit values */
export const GET = withTracing(defaultHandlers.GET);

/** PUT /api/config — update explicit config values */
export const PUT = withTracing(defaultHandlers.PUT);
