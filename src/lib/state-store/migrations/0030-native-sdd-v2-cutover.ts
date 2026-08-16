import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";
import { rawRecordHoldsExecutionLease } from "@/lib/workflow-graph/lifecycle-classifier";
import {
  enforceCurrentSchemaCompatibility,
  enforceSchemaCompatibilityBarrier,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import {
  KNOWN_SCHEMA_VERSION,
  SPEC_DELIVERY_PLAN_SCHEMA_DDL,
} from "../state-db";
import type { MigrationContext, StateMigration } from "./types";

const logger = createLogger("state-store/migrations/native-sdd-v2-cutover");

const MIGRATION_NAME = "0030-native-sdd-v2-cutover";
const MIGRATION_SCHEMA_VERSION = 9;
const MIGRATION_SCHEMA_DESCRIPTION =
  "native SDD version-2 cutover removed legacy delivery runtime artifacts";
const INVENTORY_SAMPLE_LIMIT = 20;
const LOCK_FILE_NAME = ".native-sdd-v2-cutover.lock";
const QUARANTINE_PREFIX = "native-sdd-v2-cutover-quarantine-";

export const NATIVE_SDD_V2_CUTOVER_MANIFEST_FILE_NAME =
  "native-sdd-v2-cutover-manifest.json";

export interface NativeSddV2CutoverCounts {
  activeGraphExecutions: number;
  archivedGraphExecutions: number;
  candidates: number;
  compiledDefinitions: number;
  deliveryEvents: number;
  deliveryVerdicts: number;
  discoveries: number;
  dispositions: number;
  evidence: number;
  gateAdmissions: number;
  graphEvents: number;
  legacyAttempts: number;
  legacyDefinitionFiles: number;
  legacyDefinitionOrigins: number;
  legacySpecExecutions: number;
  planApprovals: number;
  planComments: number;
  proofVerdicts: number;
  resumableActiveGraphExecutions: number;
  savedDefinitions: number;
  snapshots: number;
  specLinks: number;
  taskClaims: number;
}

export interface NativeSddV2CutoverSamples {
  activeGraphExecutionIds: string[];
  archivedGraphExecutionIds: string[];
  definitionPaths: string[];
  legacyAttemptIds: string[];
  legacySpecExecutionIds: string[];
  resumableActiveGraphExecutionIds: string[];
}

export interface NativeSddV2CutoverInventory {
  counts: NativeSddV2CutoverCounts;
  samples: NativeSddV2CutoverSamples;
}

export interface NativeSddV2CutoverResult {
  readonly applied: boolean;
  readonly completed: true;
  readonly inventory: NativeSddV2CutoverInventory;
}

export interface NativeSddV2CutoverHooks {
  reach(point: NativeSddV2CutoverFailurePoint): void;
  beforeLockPublish?(): Promise<void>;
}

export type NativeSddV2CutoverFailurePoint =
  | "before_manifest_create"
  | "after_manifest_create"
  | `before_definition_rename:${number}`
  | `after_definition_rename:${number}`
  | "before_sqlite_begin"
  | "after_sqlite_begin"
  | "before_relational_delete"
  | "after_relational_delete"
  | "before_postcondition_assert"
  | "after_postcondition_assert"
  | "before_sqlite_commit"
  | "after_sqlite_commit"
  | "before_quarantine_cleanup"
  | "after_quarantine_cleanup"
  | "before_completion_mark"
  | "after_completion_mark";

interface LegacyDefinitionFile {
  readonly sourceRelativePath: string;
  readonly definitionId: string;
  readonly projectPath: string | null;
  readonly tier: "global" | "project";
  readonly classifications: Array<"compiled" | "saved">;
  readonly hasLegacyOrigin: boolean;
}

interface LegacySpecExecutionRow {
  readonly id: string;
  readonly project_path: string;
  readonly linked_workflow_execution_id: string | null;
  readonly workflow_definition_id: string | null;
  readonly workflow_execution_id: string | null;
  readonly workflow_seed_source_json: string | null;
}

interface GraphExecutionRow {
  readonly definition_json: string;
  readonly execution_id: string;
  readonly project_path: string;
  readonly runtime_json: string;
  readonly seed_definition_id: string | null;
  readonly status: string;
}

interface ArchivedGraphExecutionRow {
  readonly execution_id: string;
  readonly execution_json: string;
  readonly project_path: string;
  readonly status: string;
}

interface CutoverTargets {
  readonly activeGraphExecutionIds: string[];
  readonly affectedSpecIds: string[];
  readonly archivedGraphExecutionIds: string[];
  readonly definitionFiles: LegacyDefinitionFile[];
  readonly deletableSpecIds: string[];
  readonly deliveryEventIds: number[];
  readonly discoveryIds: string[];
  readonly evidenceIds: string[];
  readonly gateAdmissionIds: string[];
  readonly legacyAttemptIds: string[];
  readonly legacySpecExecutionIds: string[];
  readonly linkedWorkflowExecutionIds: string[];
  readonly mergeJobIds: string[];
  readonly planApprovalIds: string[];
  readonly proofVerdictIds: string[];
  readonly specLinkIds: string[];
  readonly taskClaimIds: string[];
  readonly deliveryVerdictIds: string[];
}

interface InventoryWithTargets {
  readonly inventory: NativeSddV2CutoverInventory;
  readonly targets: CutoverTargets;
}

type ManifestPhase =
  | "prepared"
  | "quarantining"
  | "quarantined"
  | "sqlite_committed"
  | "cleanup"
  | "complete";

interface ManifestDefinitionFile extends LegacyDefinitionFile {
  readonly quarantineRelativePath: string;
  quarantined: boolean;
}

interface NativeSddV2CutoverManifest {
  readonly protocol: "native-sdd-v2-cutover/v1";
  readonly id: string;
  readonly schemaVersion: 9;
  readonly createdAt: string;
  phase: ManifestPhase;
  definitionFiles: ManifestDefinitionFile[];
  readonly inventory: NativeSddV2CutoverInventory;
}

export class NativeSddV2CutoverActiveExecutionError extends Error {
  constructor(readonly inventory: NativeSddV2CutoverInventory) {
    const ids = inventory.samples.resumableActiveGraphExecutionIds;
    super(
      `Cannot run the native-SDD version-2 cutover while resumable linked graph execution(s) remain active: ${ids.join(", ")}`,
    );
    this.name = "NativeSddV2CutoverActiveExecutionError";
  }
}

export class NativeSddV2CutoverBusyError extends Error {
  constructor() {
    super("Another startup worker is running the native-SDD version-2 cutover");
    this.name = "NativeSddV2CutoverBusyError";
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function bounded(values: Iterable<string>): string[] {
  return sortedUnique(values).slice(0, INVENTORY_SAMPLE_LIMIT);
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function tableExists(context: MigrationContext, table: string): boolean {
  return (
    context.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function tableHasColumn(
  context: MigrationContext,
  table: string,
  column: string,
): boolean {
  const columns = context.db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

function rowsByIds<T>(
  context: MigrationContext,
  sql: string,
  ids: readonly unknown[],
): T[] {
  if (ids.length === 0) return [];
  return context.db
    .prepare(sql.replace("__IDS__", placeholders(ids)))
    .all(...ids) as T[];
}

function idsByIds(
  context: MigrationContext,
  table: string,
  idColumn: string,
  filterColumn: string,
  ids: readonly string[],
): string[] {
  return rowsByIds<{ id: string }>(
    context,
    `SELECT ${idColumn} AS id FROM ${table} WHERE ${filterColumn} IN (__IDS__) ORDER BY ${idColumn}`,
    ids,
  ).map((row) => row.id);
}

function countByIds(
  context: MigrationContext,
  table: string,
  filterColumn: string,
  ids: readonly string[],
): number {
  if (ids.length === 0) return 0;
  const row = context.db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${filterColumn} IN (${placeholders(ids)})`,
    )
    .get(...ids) as { count: number };
  return row.count;
}

function parsedRecord(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parsedStringArray(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function idsCitingEvidence(
  context: MigrationContext,
  table: "spec_proof_verdicts" | "spec_task_claims",
  evidenceIds: readonly string[],
): string[] {
  if (evidenceIds.length === 0) return [];
  const targetedEvidence = new Set(evidenceIds);
  const rows = context.db
    .prepare(`SELECT id, evidence_ids_json FROM ${table} ORDER BY id`)
    .all() as Array<{ id: string; evidence_ids_json: string }>;
  return rows
    .filter((row) =>
      parsedStringArray(row.evidence_ids_json).some((id) =>
        targetedEvidence.has(id),
      ),
    )
    .map((row) => row.id);
}

/**
 * `spec_evidence.ref_json` carries workflow-event and merge-validation
 * references whose only tie to the legacy runtime is the graph execution or
 * merge job they cite: such a row can have both `execution_id` and
 * `source_event_id` NULL, so no column filter reaches it.
 */
function evidenceIdsCitingRef(
  context: MigrationContext,
  refKey: "workflowExecutionId" | "mergeJobId",
  ids: readonly string[],
): string[] {
  if (ids.length === 0) return [];
  const targeted = new Set(ids);
  const rows = context.db
    .prepare("SELECT id, ref_json FROM spec_evidence ORDER BY id")
    .all() as Array<{ id: string; ref_json: string }>;
  return rows
    .filter((row) => {
      const reference = parsedRecord(row.ref_json)?.[refKey];
      return typeof reference === "string" && targeted.has(reference);
    })
    .map((row) => row.id);
}

/**
 * A spec link records a purged execution under object kinds beyond
 * `workflow_execution` (a delivered execution also produces a `merge_job`
 * link), so identity is read from the reference and snapshot documents rather
 * than from the object kind alone.
 */
function specLinkIdsCitingExecutions(
  context: MigrationContext,
  specExecutionIds: readonly string[],
  workflowExecutionIds: readonly string[],
): string[] {
  const targeted = new Set([...specExecutionIds, ...workflowExecutionIds]);
  if (targeted.size === 0) return [];
  const rows = context.db
    .prepare(
      "SELECT id, object_ref_json, snapshot_json FROM spec_links ORDER BY id",
    )
    .all() as Array<{
    id: string;
    object_ref_json: string;
    snapshot_json: string | null;
  }>;
  return rows
    .filter((row) =>
      [row.object_ref_json, row.snapshot_json].some((raw) => {
        if (raw === null) return false;
        const document = parsedRecord(raw);
        if (document === null) return false;
        return ["executionId", "specExecutionId", "workflowExecutionId"].some(
          (key) => {
            const value = document[key];
            return typeof value === "string" && targeted.has(value);
          },
        );
      }),
    )
    .map((row) => row.id);
}

function isVersion2Attempt(raw: string): boolean {
  const value = parsedRecord(raw);
  return (
    value?.["schemaVersion"] === 2 &&
    typeof value["launch"] === "object" &&
    value["launch"] !== null &&
    typeof value["binding"] === "object" &&
    value["binding"] !== null
  );
}

function isLegacyOriginUri(value: string): boolean {
  if (value.startsWith("spec-execution://")) return true;
  if (!value.startsWith("spec-plan://")) return false;
  try {
    return new URL(value).searchParams.has("plan");
  } catch {
    return /[?&]plan=/.test(value);
  }
}

function legacyOriginUris(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => legacyOriginUris(entry));
  }
  if (typeof value !== "object" || value === null) return [];

  const record = value as Record<string, unknown>;
  const ownSource =
    typeof record["sourceUri"] === "string" &&
    isLegacyOriginUri(record["sourceUri"])
      ? [record["sourceUri"]]
      : [];
  return [
    ...ownSource,
    ...Object.values(record).flatMap((entry) => legacyOriginUris(entry)),
  ];
}

function rawHasLegacyOrigin(raw: string): boolean {
  const parsed = parsedRecord(raw);
  if (parsed !== null) return legacyOriginUris(parsed).length > 0;
  return (
    raw.includes("spec-execution://") ||
    (/spec-plan:\/\//.test(raw) && /[?&]plan=/.test(raw))
  );
}

function savedDefinitionReference(
  row: LegacySpecExecutionRow,
): { id: string; relativePath: string } | null {
  if (row.workflow_seed_source_json === null) return null;
  const value = parsedRecord(row.workflow_seed_source_json);
  if (
    value?.["kind"] !== "saved-definition" ||
    typeof value["id"] !== "string" ||
    (value["tier"] !== "project" && value["tier"] !== "global")
  ) {
    return null;
  }
  const scopeKey =
    value["tier"] === "global"
      ? "global.shared"
      : Buffer.from(row.project_path).toString("base64url");
  return {
    id: value["id"],
    relativePath: path.join("workflows", scopeKey, `${value["id"]}.json`),
  };
}

function definitionScope(
  scopeKey: string,
): Pick<LegacyDefinitionFile, "projectPath" | "tier"> {
  if (scopeKey === "global.shared") {
    return { projectPath: null, tier: "global" };
  }
  return {
    projectPath: Buffer.from(scopeKey, "base64url").toString("utf8"),
    tier: "project",
  };
}

function scanDefinitionFiles(
  context: MigrationContext,
  executionRows: readonly LegacySpecExecutionRow[],
): LegacyDefinitionFile[] {
  if (context.configDir === null) return [];
  const workflowsRoot = path.join(context.configDir, "workflows");
  if (!existsSync(workflowsRoot)) return [];

  const savedPaths = new Set(
    executionRows.flatMap((row) => {
      const reference = savedDefinitionReference(row);
      return reference === null ? [] : [reference.relativePath];
    }),
  );
  const files: LegacyDefinitionFile[] = [];

  for (const scopeEntry of readdirSync(workflowsRoot, {
    withFileTypes: true,
  })) {
    if (!scopeEntry.isDirectory()) continue;
    const scopeDir = path.join(workflowsRoot, scopeEntry.name);
    for (const fileEntry of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith(".json")) continue;
      const absolutePath = path.join(scopeDir, fileEntry.name);
      const sourceRelativePath = path.relative(context.configDir, absolutePath);
      const record = parsedRecord(readFileSync(absolutePath, "utf8"));
      if (record === null || typeof record["id"] !== "string") continue;
      const originUris = legacyOriginUris(record["definition"]);
      const originSaved = originUris.some((uri) =>
        uri.startsWith("spec-execution://"),
      );
      const originCompiled = originUris.some(
        (uri) => uri.startsWith("spec-plan://") && isLegacyOriginUri(uri),
      );
      const classifications: Array<"compiled" | "saved"> = [];
      if (savedPaths.has(sourceRelativePath) || originSaved) {
        classifications.push("saved");
      }
      if (originCompiled) {
        classifications.push("compiled");
      }
      if (classifications.length === 0) continue;
      const scope = definitionScope(scopeEntry.name);
      files.push({
        sourceRelativePath,
        definitionId: record["id"],
        ...scope,
        classifications,
        hasLegacyOrigin: originUris.length > 0,
      });
    }
  }

  return files.sort((left, right) =>
    left.sourceRelativePath.localeCompare(right.sourceRelativePath),
  );
}

function savedDefinitionPathFromExecutionJson(
  raw: string,
  projectPath: string,
): string | null {
  const value = parsedRecord(raw);
  const source = value?.["seedSource"];
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return null;
  }
  const record = source as Record<string, unknown>;
  if (
    record["kind"] !== "saved-definition" ||
    typeof record["id"] !== "string" ||
    (record["tier"] !== "global" && record["tier"] !== "project")
  ) {
    return null;
  }
  const scopeKey =
    record["tier"] === "global"
      ? "global.shared"
      : Buffer.from(projectPath).toString("base64url");
  return path.join("workflows", scopeKey, `${record["id"]}.json`);
}

function payloadString(
  payload: Record<string, unknown> | null,
  field: string,
): string | null {
  const value = payload?.[field];
  return typeof value === "string" ? value : null;
}

function affectedSpecCanOpenV2(
  context: MigrationContext,
  specId: string,
): boolean {
  const spec = context.db
    .prepare("SELECT abandoned_at FROM specs WHERE id = ?")
    .get(specId) as { abandoned_at: string | null } | undefined;
  if (spec === undefined || spec.abandoned_at !== null) return false;
  return (
    context.db
      .prepare(
        `SELECT 1
           FROM spec_revisions
          WHERE spec_id = ?
            AND state = 'approved'
            AND authoring_stage = 'plan'
          LIMIT 1`,
      )
      .get(specId) !== undefined
  );
}

function buildInventory(context: MigrationContext): InventoryWithTargets {
  const attemptRows = context.db
    .prepare(
      "SELECT id, spec_id, content_json FROM spec_delivery_plan_attempts ORDER BY id",
    )
    .all() as Array<{ id: string; spec_id: string; content_json: string }>;
  const legacyAttempts = attemptRows.filter(
    (row) => !isVersion2Attempt(row.content_json),
  );
  const legacyAttemptIds = legacyAttempts.map((row) => row.id);

  const bindingTableExists = tableExists(context, "spec_execution_bindings");
  const seedSourceProjection = tableHasColumn(
    context,
    "spec_executions",
    "workflow_seed_source_json",
  )
    ? "se.workflow_seed_source_json"
    : "NULL AS workflow_seed_source_json";
  const executionRows = context.db
    .prepare(
      `SELECT se.id, s.project_path, se.linked_workflow_execution_id,
              se.workflow_definition_id, se.workflow_execution_id,
              ${seedSourceProjection}
         FROM spec_executions se
         JOIN specs s ON s.id = se.spec_id
         ${
           bindingTableExists
             ? `LEFT JOIN spec_execution_bindings binding
                  ON binding.spec_execution_id = se.id`
             : ""
         }
        ${bindingTableExists ? "WHERE binding.spec_execution_id IS NULL" : ""}
        ORDER BY se.id`,
    )
    .all() as LegacySpecExecutionRow[];
  const legacySpecExecutionIds = executionRows.map((row) => row.id);
  const affectedSpecIds = sortedUnique([
    ...legacyAttempts.map((row) => row.spec_id),
    ...rowsByIds<{ spec_id: string }>(
      context,
      "SELECT spec_id FROM spec_executions WHERE id IN (__IDS__)",
      legacySpecExecutionIds,
    ).map((row) => row.spec_id),
  ]);
  const deletableSpecIds = affectedSpecIds.filter(
    (specId) => !affectedSpecCanOpenV2(context, specId),
  );

  const definitionFiles = scanDefinitionFiles(context, executionRows);
  const definitionPaths = new Set(
    definitionFiles.map((file) => file.sourceRelativePath),
  );
  const linkedWorkflowExecutionIds = new Set(
    executionRows.flatMap((row) => [
      ...(row.workflow_execution_id === null
        ? []
        : [row.workflow_execution_id]),
      ...(row.linked_workflow_execution_id === null
        ? []
        : [row.linked_workflow_execution_id]),
    ]),
  );

  const activeRows = context.db
    .prepare(
      `SELECT project_path, execution_id, seed_definition_id, status, definition_json, runtime_json
         FROM graph_workflow_executions
        ORDER BY execution_id`,
    )
    .all() as GraphExecutionRow[];
  const linkedActiveRows = activeRows.filter(
    (row) =>
      linkedWorkflowExecutionIds.has(row.execution_id) ||
      definitionPaths.has(
        savedDefinitionPathFromExecutionJson(
          row.definition_json,
          row.project_path,
        ) ?? "",
      ) ||
      rawHasLegacyOrigin(row.definition_json),
  );
  for (const row of linkedActiveRows)
    linkedWorkflowExecutionIds.add(row.execution_id);

  const archivedRows = context.db
    .prepare(
      `SELECT project_path, execution_id, status, execution_json
         FROM graph_workflow_archived_executions
        ORDER BY execution_id`,
    )
    .all() as ArchivedGraphExecutionRow[];
  const linkedArchivedRows = archivedRows.filter(
    (row) =>
      linkedWorkflowExecutionIds.has(row.execution_id) ||
      definitionPaths.has(
        savedDefinitionPathFromExecutionJson(
          row.execution_json,
          row.project_path,
        ) ?? "",
      ) ||
      rawHasLegacyOrigin(row.execution_json),
  );
  for (const row of linkedArchivedRows) {
    linkedWorkflowExecutionIds.add(row.execution_id);
  }

  // "This run still owns the session, refuse cutover" is the lease question,
  // answered by the canonical raw-record predicate: unreadable inputs resolve
  // to lease-HELD, so a row this migration cannot classify refuses the cutover
  // rather than being purged.
  const resumableActiveGraphExecutionIds = linkedActiveRows.flatMap((row) => {
    const runtime = parsedRecord(row.runtime_json);
    const leaseHeld =
      runtime === null ||
      rawRecordHoldsExecutionLease({
        status: row.status,
        haltReason: runtime["haltReason"] ?? null,
        abandonment: runtime["abandonment"] ?? null,
      });
    return leaseHeld ? [row.execution_id] : [];
  });
  const activeGraphExecutionIds = linkedActiveRows.map(
    (row) => row.execution_id,
  );
  const archivedGraphExecutionIds = linkedArchivedRows.map(
    (row) => row.execution_id,
  );
  const linkedWorkflowIds = sortedUnique(linkedWorkflowExecutionIds);

  const candidateIds = idsByIds(
    context,
    "spec_delivery_plan_candidates",
    "id",
    "attempt_id",
    legacyAttemptIds,
  );
  const affectedEventRows = rowsByIds<{
    id: number;
    event_type: string;
    payload_json: string;
  }>(
    context,
    `SELECT id, event_type, payload_json
       FROM spec_events
      WHERE spec_id IN (__IDS__)
      ORDER BY id`,
    affectedSpecIds,
  );
  const legacyAttemptEvents = affectedEventRows.filter((row) => {
    const payload = parsedRecord(row.payload_json);
    return legacyAttemptIds.includes(payloadString(payload, "attemptId") ?? "");
  });
  const eventAdmissionIds = legacyAttemptEvents.flatMap((row) => {
    const value = payloadString(parsedRecord(row.payload_json), "admissionId");
    return value === null ? [] : [value];
  });
  const gateAdmissionIds = sortedUnique([
    ...idsByIds(
      context,
      "spec_gate_admissions",
      "id",
      "execution_id",
      legacySpecExecutionIds,
    ),
    ...eventAdmissionIds,
  ]);
  const admissionApprovalIds = rowsByIds<{ approval_id: string | null }>(
    context,
    `SELECT approval_id
       FROM spec_gate_admissions
      WHERE id IN (__IDS__)
      ORDER BY id`,
    gateAdmissionIds,
  ).flatMap((row) => (row.approval_id === null ? [] : [row.approval_id]));
  const eventApprovalIds = legacyAttemptEvents.flatMap((row) => {
    const value = payloadString(parsedRecord(row.payload_json), "approvalId");
    return value === null ? [] : [value];
  });
  const planApprovalIds = sortedUnique([
    ...rowsByIds<{ id: string }>(
      context,
      `SELECT id
         FROM spec_approvals
        WHERE subject_kind = 'plan'
          AND spec_id IN (__IDS__)
        ORDER BY id`,
      affectedSpecIds,
    ).map((row) => row.id),
    ...admissionApprovalIds,
    ...eventApprovalIds,
  ]);
  const deliveryEventIds = affectedEventRows
    .filter((row) => {
      const payload = parsedRecord(row.payload_json);
      if (
        legacyAttemptIds.includes(payloadString(payload, "attemptId") ?? "") ||
        candidateIds.includes(payloadString(payload, "candidateId") ?? "")
      ) {
        return true;
      }
      if (row.event_type.startsWith("spec-delivery-plan-")) {
        return (
          typeof payload?.["attemptId"] !== "string" ||
          legacyAttemptIds.includes(payload["attemptId"])
        );
      }
      return (
        typeof payload?.["executionId"] === "string" &&
        legacySpecExecutionIds.includes(payload["executionId"])
      );
    })
    .map((row) => row.id);
  const mergeJobIds = rowsByIds<{ id: string }>(
    context,
    `SELECT job_id AS id
       FROM job_records
      WHERE execution_id IN (__IDS__)
      ORDER BY job_id`,
    linkedWorkflowIds,
  ).map((row) => row.id);
  const evidenceIds = sortedUnique([
    ...idsByIds(
      context,
      "spec_evidence",
      "id",
      "execution_id",
      legacySpecExecutionIds,
    ),
    ...rowsByIds<{ id: string }>(
      context,
      `SELECT id
         FROM spec_evidence
        WHERE source_event_id IN (__IDS__)
        ORDER BY id`,
      deliveryEventIds,
    ).map((row) => row.id),
    ...evidenceIdsCitingRef(context, "workflowExecutionId", linkedWorkflowIds),
    ...evidenceIdsCitingRef(context, "mergeJobId", mergeJobIds),
  ]);
  const proofVerdictIds = sortedUnique([
    ...idsByIds(
      context,
      "spec_proof_verdicts",
      "id",
      "execution_id",
      legacySpecExecutionIds,
    ),
    ...idsCitingEvidence(context, "spec_proof_verdicts", evidenceIds),
  ]);
  const deliveryVerdictIds = tableExists(context, "spec_delivery_verdicts")
    ? sortedUnique([
        ...idsByIds(
          context,
          "spec_delivery_verdicts",
          "id",
          "spec_execution_id",
          legacySpecExecutionIds,
        ),
        ...idsByIds(
          context,
          "spec_delivery_verdicts",
          "id",
          "workflow_execution_id",
          linkedWorkflowIds,
        ),
      ])
    : [];
  const taskClaimIds = sortedUnique([
    ...idsByIds(
      context,
      "spec_task_claims",
      "id",
      "execution_id",
      legacySpecExecutionIds,
    ),
    ...idsCitingEvidence(context, "spec_task_claims", evidenceIds),
  ]);
  const specLinkIds = sortedUnique([
    ...rowsByIds<{ id: string }>(
      context,
      `SELECT id
         FROM spec_links
        WHERE object_kind = 'workflow_execution'
          AND spec_id IN (__IDS__)
        ORDER BY id`,
      affectedSpecIds,
    ).map((row) => row.id),
    ...specLinkIdsCitingExecutions(
      context,
      legacySpecExecutionIds,
      linkedWorkflowIds,
    ),
  ]);
  const discoveryIds = sortedUnique([
    ...idsByIds(
      context,
      "spec_delivery_discoveries",
      "id",
      "execution_id",
      legacySpecExecutionIds,
    ),
    ...idsByIds(
      context,
      "spec_delivery_discoveries",
      "id",
      "attempt_id",
      legacyAttemptIds,
    ),
  ]);
  const dispositions =
    legacySpecExecutionIds.length === 0
      ? 0
      : (
          context.db
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM spec_criterion_dispositions
                WHERE execution_id IN (${placeholders(legacySpecExecutionIds)})
                   OR delivered_by_execution_id IN (${placeholders(legacySpecExecutionIds)})`,
            )
            .get(...legacySpecExecutionIds, ...legacySpecExecutionIds) as {
            count: number;
          }
        ).count;

  const counts: NativeSddV2CutoverCounts = {
    activeGraphExecutions: activeGraphExecutionIds.length,
    archivedGraphExecutions: archivedGraphExecutionIds.length,
    candidates: countByIds(
      context,
      "spec_delivery_plan_candidates",
      "attempt_id",
      legacyAttemptIds,
    ),
    compiledDefinitions: definitionFiles.filter((file) =>
      file.classifications.includes("compiled"),
    ).length,
    deliveryEvents: deliveryEventIds.length,
    deliveryVerdicts: deliveryVerdictIds.length,
    discoveries: discoveryIds.length,
    dispositions,
    evidence: evidenceIds.length,
    gateAdmissions: gateAdmissionIds.length,
    graphEvents: countByIds(
      context,
      "graph_workflow_events",
      "execution_id",
      linkedWorkflowIds,
    ),
    legacyAttempts: legacyAttemptIds.length,
    legacyDefinitionFiles: definitionFiles.length,
    legacyDefinitionOrigins: definitionFiles.filter(
      (file) => file.hasLegacyOrigin,
    ).length,
    legacySpecExecutions: legacySpecExecutionIds.length,
    planApprovals: planApprovalIds.length,
    planComments: countByIds(
      context,
      "spec_delivery_plan_comments",
      "attempt_id",
      legacyAttemptIds,
    ),
    proofVerdicts: proofVerdictIds.length,
    resumableActiveGraphExecutions: resumableActiveGraphExecutionIds.length,
    savedDefinitions: definitionFiles.filter((file) =>
      file.classifications.includes("saved"),
    ).length,
    snapshots: countByIds(
      context,
      "spec_delivery_plan_snapshots",
      "attempt_id",
      legacyAttemptIds,
    ),
    specLinks: specLinkIds.length,
    taskClaims: taskClaimIds.length,
  };
  const inventory: NativeSddV2CutoverInventory = {
    counts,
    samples: {
      activeGraphExecutionIds: bounded(activeGraphExecutionIds),
      archivedGraphExecutionIds: bounded(archivedGraphExecutionIds),
      definitionPaths: bounded(
        definitionFiles.map((file) => file.sourceRelativePath),
      ),
      legacyAttemptIds: bounded(legacyAttemptIds),
      legacySpecExecutionIds: bounded(legacySpecExecutionIds),
      resumableActiveGraphExecutionIds: bounded(
        resumableActiveGraphExecutionIds,
      ),
    },
  };

  return {
    inventory,
    targets: {
      activeGraphExecutionIds: sortedUnique(activeGraphExecutionIds),
      affectedSpecIds,
      archivedGraphExecutionIds: sortedUnique(archivedGraphExecutionIds),
      definitionFiles,
      deletableSpecIds,
      deliveryEventIds,
      deliveryVerdictIds,
      discoveryIds,
      evidenceIds,
      gateAdmissionIds,
      legacyAttemptIds,
      legacySpecExecutionIds,
      linkedWorkflowExecutionIds: linkedWorkflowIds,
      mergeJobIds: sortedUnique(mergeJobIds),
      planApprovalIds,
      proofVerdictIds,
      specLinkIds,
      taskClaimIds,
    },
  };
}

export function inspectNativeSddV2Cutover(
  context: MigrationContext,
): NativeSddV2CutoverInventory {
  return buildInventory(context).inventory;
}

function logInventory(inventory: NativeSddV2CutoverInventory): void {
  logger.info("state-store.native_sdd_v2_cutover_inventory", {
    counts: inventory.counts,
    ...inventory.samples,
  });
}

function manifestPath(configDir: string): string {
  return path.join(configDir, NATIVE_SDD_V2_CUTOVER_MANIFEST_FILE_NAME);
}

function quarantineRoot(configDir: string, manifestId: string): string {
  return path.join(configDir, `${QUARANTINE_PREFIX}${manifestId}`);
}

function quarantineRelativePath(
  manifestId: string,
  sourceRelativePath: string,
): string {
  return path.join(`${QUARANTINE_PREFIX}${manifestId}`, sourceRelativePath);
}

function parseManifest(raw: string): NativeSddV2CutoverManifest {
  const value = parsedRecord(raw);
  if (
    value?.["protocol"] !== "native-sdd-v2-cutover/v1" ||
    typeof value["id"] !== "string" ||
    value["schemaVersion"] !== MIGRATION_SCHEMA_VERSION ||
    typeof value["phase"] !== "string" ||
    !Array.isArray(value["definitionFiles"]) ||
    typeof value["inventory"] !== "object" ||
    value["inventory"] === null
  ) {
    throw new Error("The native-SDD v2 cutover manifest is invalid");
  }
  return value as unknown as NativeSddV2CutoverManifest;
}

async function readManifest(
  configDir: string,
): Promise<NativeSddV2CutoverManifest | null> {
  const target = manifestPath(configDir);
  if (!existsSync(target)) return null;
  return parseManifest(await readFile(target, "utf8"));
}

async function writeManifest(
  configDir: string,
  manifest: NativeSddV2CutoverManifest,
): Promise<void> {
  await atomicWriteJson(manifestPath(configDir), manifest);
}

async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    ["EISDIR", "EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EBADF"].includes(
      code,
    )
  );
}

function hook(
  hooks: NativeSddV2CutoverHooks | undefined,
  point: NativeSddV2CutoverFailurePoint,
): void {
  hooks?.reach(point);
}

async function renameDurably(
  source: string,
  destination: string,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(source, destination);
  await syncDirectory(path.dirname(source));
  if (path.dirname(source) !== path.dirname(destination)) {
    await syncDirectory(path.dirname(destination));
  }
}

function hasSchemaVersion(context: MigrationContext): boolean {
  return (
    context.db
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(MIGRATION_SCHEMA_VERSION) !== undefined
  );
}

async function cleanupQuarantine(
  configDir: string,
  manifest: NativeSddV2CutoverManifest,
): Promise<void> {
  const root = quarantineRoot(configDir, manifest.id);
  await rm(root, { recursive: true, force: true });
  await syncDirectory(configDir);
}

async function restorePreCommit(
  configDir: string,
  manifest: NativeSddV2CutoverManifest,
): Promise<void> {
  for (const file of [...manifest.definitionFiles].reverse()) {
    const source = path.join(configDir, file.sourceRelativePath);
    const quarantined = path.join(configDir, file.quarantineRelativePath);
    const sourceExists = existsSync(source);
    const quarantinedExists = existsSync(quarantined);
    if (sourceExists && quarantinedExists) {
      throw new Error(
        `Cannot restore cutover definition ${file.sourceRelativePath}: both source and quarantine exist`,
      );
    }
    if (!sourceExists && quarantinedExists) {
      await renameDurably(quarantined, source);
    }
  }
  await cleanupQuarantine(configDir, manifest);
  await unlink(manifestPath(configDir)).catch((error: unknown) => {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
  });
  await syncDirectory(configDir);
  logger.warn("state-store.native_sdd_v2_cutover_precommit_restored", {
    manifestId: manifest.id,
    definitionCount: manifest.definitionFiles.length,
  });
}

async function completePostCommit(
  configDir: string,
  manifest: NativeSddV2CutoverManifest,
  hooks?: NativeSddV2CutoverHooks,
): Promise<void> {
  manifest.phase = "cleanup";
  await writeManifest(configDir, manifest);
  hook(hooks, "before_quarantine_cleanup");
  await cleanupQuarantine(configDir, manifest);
  hook(hooks, "after_quarantine_cleanup");
  hook(hooks, "before_completion_mark");
  manifest.phase = "complete";
  await writeManifest(configDir, manifest);
  hook(hooks, "after_completion_mark");
}

async function recoverManifest(
  context: MigrationContext,
  hooks?: NativeSddV2CutoverHooks,
): Promise<NativeSddV2CutoverResult | null> {
  if (context.configDir === null) return null;
  const manifest = await readManifest(context.configDir);
  if (manifest === null) return null;
  if (manifest.phase === "complete") {
    logger.info("state-store.native_sdd_v2_cutover_recovered_postcommit", {
      manifestId: manifest.id,
    });
    return { applied: false, completed: true, inventory: manifest.inventory };
  }
  if (hasSchemaVersion(context)) {
    await completePostCommit(context.configDir, manifest, hooks);
    logger.info("state-store.native_sdd_v2_cutover_recovered_postcommit", {
      manifestId: manifest.id,
    });
    return { applied: false, completed: true, inventory: manifest.inventory };
  }
  await restorePreCommit(context.configDir, manifest);
  return null;
}

function deleteIds(
  context: MigrationContext,
  table: string,
  column: string,
  ids: readonly (number | string)[],
): void {
  if (ids.length === 0) return;
  context.db
    .prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders(ids)})`)
    .run(...ids);
}

function updateSessionPointers(
  context: MigrationContext,
  workflowExecutionIds: readonly string[],
): void {
  if (workflowExecutionIds.length === 0) return;
  const targets = new Set(workflowExecutionIds);
  const rows = context.db
    .prepare(
      `SELECT project_path, session_name, graph_workflow_execution,
              graph_workflow_execution_history
         FROM sessions`,
    )
    .all() as Array<{
    project_path: string;
    session_name: string;
    graph_workflow_execution: string | null;
    graph_workflow_execution_history: string;
  }>;
  const update = context.db.prepare(
    `UPDATE sessions
        SET graph_workflow_execution = ?, graph_workflow_execution_history = ?
      WHERE project_path = ? AND session_name = ?`,
  );
  for (const row of rows) {
    const active =
      row.graph_workflow_execution !== null &&
      targets.has(row.graph_workflow_execution)
        ? null
        : row.graph_workflow_execution;
    let history: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(row.graph_workflow_execution_history);
      history = Array.isArray(parsed) ? parsed : [];
    } catch {
      history = [];
    }
    const nextHistory = history.filter((entry) => {
      if (typeof entry === "string") return !targets.has(entry);
      if (typeof entry !== "object" || entry === null) return true;
      const id = (entry as Record<string, unknown>)["executionId"];
      return typeof id !== "string" || !targets.has(id);
    });
    const serialized = JSON.stringify(nextHistory);
    if (
      active === row.graph_workflow_execution &&
      serialized === row.graph_workflow_execution_history
    ) {
      continue;
    }
    update.run(active, serialized, row.project_path, row.session_name);
  }
}

/**
 * The compiled candidate was a second set of bytes an approval could have
 * meant, and `plan_hash` was its identity. Version 2 signs the snapshot bytes
 * themselves, so the cutover removes the SHAPE as well as the rows: a database
 * that merely emptied the table would still converge on a different schema
 * than a fresh install, and the next reader would have somewhere to write.
 */
function dropRetiredDeliveryPlanStorage(context: MigrationContext): void {
  const { db } = context;
  db.exec("DROP INDEX IF EXISTS idx_spec_delivery_plan_candidates_attempt;");
  db.exec("DROP TABLE IF EXISTS spec_delivery_plan_candidates;");
  const snapshotColumns = db.pragma(
    "table_info(spec_delivery_plan_snapshots)",
  ) as Array<{ name: string }>;
  if (!snapshotColumns.some((column) => column.name === "plan_hash")) return;
  db.exec(`
    DELETE FROM spec_delivery_plan_snapshots
     WHERE candidate_id IS NULL OR candidate_hash IS NULL;
    DROP INDEX IF EXISTS idx_spec_delivery_plan_snapshots_attempt;
    ALTER TABLE spec_delivery_plan_snapshots
      RENAME TO spec_delivery_plan_snapshots_pre_v2;
  `);
  // The floor owns the shape, so the rebuild replays its DDL verbatim rather
  // than restating it: a migration with its own copy converges on a schema
  // that only looks like a fresh install.
  db.exec(SPEC_DELIVERY_PLAN_SCHEMA_DDL);
  db.exec(`
    INSERT INTO spec_delivery_plan_snapshots (
      id, attempt_id, candidate_id, candidate_hash, draft_revision,
      content_json, pinned_revision_id, proposed_at, proposed_by_json
    ) SELECT
      id, attempt_id, candidate_id, candidate_hash, draft_revision,
      content_json, pinned_revision_id, proposed_at, proposed_by_json
    FROM spec_delivery_plan_snapshots_pre_v2;
    DROP TABLE spec_delivery_plan_snapshots_pre_v2;
  `);
}

function purgeRelationalArtifacts(
  context: MigrationContext,
  targets: CutoverTargets,
): void {
  deleteIds(context, "spec_gate_admissions", "id", targets.gateAdmissionIds);
  deleteIds(
    context,
    "spec_delivery_verdicts",
    "id",
    targets.deliveryVerdictIds,
  );
  if (targets.legacySpecExecutionIds.length > 0) {
    const values = targets.legacySpecExecutionIds;
    context.db
      .prepare(
        `DELETE FROM spec_criterion_dispositions
          WHERE execution_id IN (${placeholders(values)})
             OR delivered_by_execution_id IN (${placeholders(values)})`,
      )
      .run(...values, ...values);
  }
  deleteIds(context, "spec_task_claims", "id", targets.taskClaimIds);
  deleteIds(context, "spec_proof_verdicts", "id", targets.proofVerdictIds);
  deleteIds(context, "spec_evidence", "id", targets.evidenceIds);
  deleteIds(context, "spec_delivery_discoveries", "id", targets.discoveryIds);
  deleteIds(
    context,
    "spec_delivery_plan_comments",
    "attempt_id",
    targets.legacyAttemptIds,
  );
  deleteIds(
    context,
    "spec_delivery_plan_candidates",
    "attempt_id",
    targets.legacyAttemptIds,
  );
  deleteIds(
    context,
    "spec_delivery_plan_snapshots",
    "attempt_id",
    targets.legacyAttemptIds,
  );
  deleteIds(
    context,
    "spec_delivery_plan_attempts",
    "id",
    targets.legacyAttemptIds,
  );
  deleteIds(context, "spec_links", "id", targets.specLinkIds);
  deleteIds(context, "spec_events", "id", targets.deliveryEventIds);
  deleteIds(context, "spec_approvals", "id", targets.planApprovalIds);

  deleteIds(
    context,
    "graph_workflow_events",
    "execution_id",
    targets.linkedWorkflowExecutionIds,
  );
  deleteIds(
    context,
    "graph_workflow_executions",
    "execution_id",
    targets.activeGraphExecutionIds,
  );
  deleteIds(
    context,
    "graph_workflow_archived_executions",
    "execution_id",
    targets.archivedGraphExecutionIds,
  );
  deleteIds(
    context,
    "validation_runs",
    "workflow_execution_id",
    targets.linkedWorkflowExecutionIds,
  );
  deleteIds(
    context,
    "job_records",
    "execution_id",
    targets.linkedWorkflowExecutionIds,
  );
  updateSessionPointers(context, targets.linkedWorkflowExecutionIds);

  if (targets.legacySpecExecutionIds.length > 0) {
    const values = targets.legacySpecExecutionIds;
    context.db
      .prepare(
        `UPDATE spec_delivery_plan_attempts
            SET delta_basis_execution_id = CASE
                  WHEN delta_basis_execution_id IN (${placeholders(values)})
                    THEN NULL ELSE delta_basis_execution_id END,
                launched_execution_id = CASE
                  WHEN launched_execution_id IN (${placeholders(values)})
                    THEN NULL ELSE launched_execution_id END
          WHERE delta_basis_execution_id IN (${placeholders(values)})
             OR launched_execution_id IN (${placeholders(values)})`,
      )
      .run(...values, ...values, ...values, ...values);
  }
  deleteIds(context, "spec_executions", "id", targets.legacySpecExecutionIds);
  deleteIds(context, "specs", "id", targets.deletableSpecIds);
}

function assertPostconditions(
  context: MigrationContext,
  targets: CutoverTargets,
): void {
  const remaining = buildInventory(context).inventory.counts;
  const nonZero = Object.entries(remaining).filter(([, count]) => count !== 0);
  if (nonZero.length > 0) {
    throw new Error(
      `Native-SDD v2 cutover postcondition failed: ${nonZero
        .map(([name, count]) => `${name}=${count}`)
        .join(", ")}`,
    );
  }
  const danglingEvidenceSourceEventIds = rowsByIds<{ id: string }>(
    context,
    `SELECT id
       FROM spec_evidence
      WHERE source_event_id IN (__IDS__)
      ORDER BY id`,
    targets.deliveryEventIds,
  ).map((row) => row.id);
  const danglingProofVerdictIds = idsCitingEvidence(
    context,
    "spec_proof_verdicts",
    targets.evidenceIds,
  );
  const danglingTaskClaimIds = idsCitingEvidence(
    context,
    "spec_task_claims",
    targets.evidenceIds,
  );
  const danglingWorkflowEventEvidenceIds = evidenceIdsCitingRef(
    context,
    "workflowExecutionId",
    targets.linkedWorkflowExecutionIds,
  );
  const danglingMergeJobEvidenceIds = evidenceIdsCitingRef(
    context,
    "mergeJobId",
    targets.mergeJobIds,
  );
  const danglingSpecLinkIds = specLinkIdsCitingExecutions(
    context,
    targets.legacySpecExecutionIds,
    targets.linkedWorkflowExecutionIds,
  );
  const danglingLogicalReferences = [
    ["evidenceMergeJobRefs", danglingMergeJobEvidenceIds.length],
    ["evidenceSourceEvents", danglingEvidenceSourceEventIds.length],
    ["evidenceWorkflowEventRefs", danglingWorkflowEventEvidenceIds.length],
    ["proofVerdictEvidence", danglingProofVerdictIds.length],
    ["specLinkExecutionRefs", danglingSpecLinkIds.length],
    ["taskClaimEvidence", danglingTaskClaimIds.length],
  ] as const;
  const nonZeroLogicalReferences = danglingLogicalReferences.filter(
    ([, count]) => count !== 0,
  );
  if (nonZeroLogicalReferences.length > 0) {
    throw new Error(
      `Native-SDD v2 cutover postcondition failed: ${nonZeroLogicalReferences
        .map(([name, count]) => `${name}=${count}`)
        .join(", ")}`,
    );
  }
  for (const specId of targets.affectedSpecIds) {
    const exists =
      context.db.prepare("SELECT 1 FROM specs WHERE id = ?").get(specId) !==
      undefined;
    if (targets.deletableSpecIds.includes(specId)) {
      if (exists) {
        throw new Error(`Incompatible spec ${specId} survived the cutover`);
      }
      continue;
    }
    if (!exists || !affectedSpecCanOpenV2(context, specId)) {
      throw new Error(
        `Preserved spec ${specId} cannot legally open a version-2 attempt`,
      );
    }
  }
  const foreignKeys = context.db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    throw new Error(
      `Native-SDD v2 cutover left ${foreignKeys.length} foreign-key violation(s)`,
    );
  }
}

function runSqliteCutover(
  context: MigrationContext,
  targets: CutoverTargets,
  hooks?: NativeSddV2CutoverHooks,
): void {
  hook(hooks, "before_sqlite_begin");
  context.db.exec("BEGIN IMMEDIATE");
  try {
    enforceCurrentSchemaCompatibility(
      context.db,
      context.db.name,
      KNOWN_SCHEMA_VERSION,
    );
    hook(hooks, "after_sqlite_begin");
    hook(hooks, "before_relational_delete");
    purgeRelationalArtifacts(context, targets);
    hook(hooks, "after_relational_delete");
    context.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (version, description)
         VALUES (?, ?)`,
      )
      .run(MIGRATION_SCHEMA_VERSION, MIGRATION_SCHEMA_DESCRIPTION);
    hook(hooks, "before_postcondition_assert");
    assertPostconditions(context, targets);
    hook(hooks, "after_postcondition_assert");
    dropRetiredDeliveryPlanStorage(context);
    hook(hooks, "before_sqlite_commit");
    context.db.exec("COMMIT");
  } catch (error) {
    if (context.db.inTransaction) context.db.exec("ROLLBACK");
    throw error;
  }
  hook(hooks, "after_sqlite_commit");
}

function assertDefinitionsQuarantined(
  configDir: string,
  manifest: NativeSddV2CutoverManifest,
): void {
  for (const file of manifest.definitionFiles) {
    const source = path.join(configDir, file.sourceRelativePath);
    const quarantined = path.join(configDir, file.quarantineRelativePath);
    if (existsSync(source) || !existsSync(quarantined)) {
      throw new Error(
        `Definition quarantine postcondition failed for ${file.sourceRelativePath}`,
      );
    }
  }
}

async function quarantineDefinitions(
  configDir: string,
  manifest: NativeSddV2CutoverManifest,
  hooks?: NativeSddV2CutoverHooks,
): Promise<void> {
  manifest.phase = "quarantining";
  await writeManifest(configDir, manifest);
  for (const [index, file] of manifest.definitionFiles.entries()) {
    hook(hooks, `before_definition_rename:${index}`);
    const source = path.join(configDir, file.sourceRelativePath);
    const quarantined = path.join(configDir, file.quarantineRelativePath);
    if (!existsSync(source) && !existsSync(quarantined)) {
      throw new Error(
        `Cutover definition ${file.sourceRelativePath} vanished before quarantine`,
      );
    }
    if (existsSync(source) && existsSync(quarantined)) {
      throw new Error(
        `Cutover definition ${file.sourceRelativePath} exists in both stores`,
      );
    }
    if (existsSync(source)) await renameDurably(source, quarantined);
    file.quarantined = true;
    await writeManifest(configDir, manifest);
    hook(hooks, `after_definition_rename:${index}`);
  }
  manifest.phase = "quarantined";
  await writeManifest(configDir, manifest);
  assertDefinitionsQuarantined(configDir, manifest);
}

async function acquireStartupLock(
  configDir: string,
  hooks?: NativeSddV2CutoverHooks,
): Promise<() => Promise<void>> {
  const lockPath = path.join(configDir, LOCK_FILE_NAME);
  const unpublishedPath = path.join(
    configDir,
    `${LOCK_FILE_NAME}.${process.pid}.${randomUUID()}.unpublished`,
  );
  const unpublished = await open(unpublishedPath, "wx");
  try {
    await unpublished.writeFile(JSON.stringify({ pid: process.pid }));
    await unpublished.sync();
  } finally {
    await unpublished.close();
  }
  await syncDirectory(configDir);
  await hooks?.beforeLockPublish?.();

  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      try {
        await link(unpublishedPath, lockPath);
        await unlink(unpublishedPath);
        await syncDirectory(configDir);
        return async () => {
          await unlink(lockPath).catch((error: unknown) => {
            if (!isNodeErrorCode(error, "ENOENT")) throw error;
          });
          await syncDirectory(configDir);
        };
      } catch (error) {
        if (!isNodeErrorCode(error, "EEXIST")) throw error;
        if (await removeStaleLock(lockPath)) continue;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
  } finally {
    await unlink(unpublishedPath).catch((error: unknown) => {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
    });
  }
  throw new NativeSddV2CutoverBusyError();
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const value = parsedRecord(await readFile(lockPath, "utf8"));
    const pid = value?.["pid"];
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      await unlink(lockPath);
      return true;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (!isNodeErrorCode(error, "ESRCH")) return false;
      await unlink(lockPath);
      return true;
    }
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return true;
    throw error;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function createManifest(
  inventory: NativeSddV2CutoverInventory,
  targets: CutoverTargets,
): NativeSddV2CutoverManifest {
  const id = randomUUID();
  return {
    protocol: "native-sdd-v2-cutover/v1",
    id,
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    phase: "prepared",
    definitionFiles: targets.definitionFiles.map((file) => ({
      ...file,
      quarantineRelativePath: quarantineRelativePath(
        id,
        file.sourceRelativePath,
      ),
      quarantined: false,
    })),
    inventory,
  };
}

async function runWithConfigDir(
  context: MigrationContext & { configDir: string },
  hooks?: NativeSddV2CutoverHooks,
): Promise<NativeSddV2CutoverResult> {
  const releaseLock = await acquireStartupLock(context.configDir, hooks);
  let manifest: NativeSddV2CutoverManifest | null = null;
  try {
    const recovered = await recoverManifest(context, hooks);
    if (recovered !== null) return recovered;

    const { inventory, targets } = buildInventory(context);
    logInventory(inventory);
    if (inventory.counts.resumableActiveGraphExecutions > 0) {
      logger.warn("state-store.native_sdd_v2_cutover_refused_active", {
        activeExecutionCount: inventory.counts.resumableActiveGraphExecutions,
        activeExecutionIds: inventory.samples.resumableActiveGraphExecutionIds,
      });
      throw new NativeSddV2CutoverActiveExecutionError(inventory);
    }

    manifest = createManifest(inventory, targets);
    hook(hooks, "before_manifest_create");
    await writeManifest(context.configDir, manifest);
    hook(hooks, "after_manifest_create");
    await publishSchemaCompatibilityBarrier(
      context.configDir,
      MIGRATION_SCHEMA_VERSION,
    );
    await quarantineDefinitions(context.configDir, manifest, hooks);
    runSqliteCutover(context, targets, hooks);
    manifest.phase = "sqlite_committed";
    await writeManifest(context.configDir, manifest);
    await completePostCommit(context.configDir, manifest, hooks);
    logger.info("state-store.native_sdd_v2_cutover_completed", {
      manifestId: manifest.id,
      counts: inventory.counts,
    });
    return { applied: true, completed: true, inventory };
  } catch (error) {
    const committed = hasSchemaVersion(context);
    if (!committed && manifest !== null) {
      try {
        await restorePreCommit(context.configDir, manifest);
      } catch (recoveryError) {
        logger.error("state-store.native_sdd_v2_cutover_restore_failed", {
          manifestId: manifest.id,
          error: getErrorMessage(recoveryError),
        });
        throw new AggregateError(
          [error, recoveryError],
          "Native-SDD v2 cutover and pre-commit restoration both failed",
        );
      }
    }
    throw error;
  } finally {
    await releaseLock();
  }
}

export async function runNativeSddV2Cutover(
  context: MigrationContext,
  hooks?: NativeSddV2CutoverHooks,
): Promise<NativeSddV2CutoverResult> {
  if (context.configDir !== null) {
    return runWithConfigDir(
      { db: context.db, configDir: context.configDir },
      hooks,
    );
  }

  const { inventory, targets } = buildInventory(context);
  logInventory(inventory);
  if (inventory.counts.resumableActiveGraphExecutions > 0) {
    logger.warn("state-store.native_sdd_v2_cutover_refused_active", {
      activeExecutionCount: inventory.counts.resumableActiveGraphExecutions,
      activeExecutionIds: inventory.samples.resumableActiveGraphExecutionIds,
    });
    throw new NativeSddV2CutoverActiveExecutionError(inventory);
  }
  runSqliteCutover(context, targets, hooks);
  return { applied: true, completed: true, inventory };
}

export async function runNativeSddV2CutoverBeforeStateDbOpen(
  configDir: string,
): Promise<NativeSddV2CutoverResult | null> {
  const dbPath = path.join(configDir, "command-center.db");
  if (!existsSync(dbPath)) return null;

  enforceSchemaCompatibilityBarrier(dbPath, KNOWN_SCHEMA_VERSION);
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    return await runNativeSddV2Cutover({ db, configDir });
  } finally {
    db.close();
  }
}

export const nativeSddV2Cutover: StateMigration = {
  name: MIGRATION_NAME,
  async up({ context }) {
    await runNativeSddV2Cutover(context);
  },
};
