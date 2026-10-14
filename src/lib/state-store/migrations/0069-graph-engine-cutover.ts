import {
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { rawGlobalConfigSchema } from "@/lib/config/schemas";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import type { MigrationContext, StateMigration } from "./types";

const objectSchema = z.record(z.string(), z.unknown());
const rowSchema = z.object({ id: z.string(), payload_json: z.string() });

/** Preserve file-only settings while moving the two retired workflow policies. */
export function transformCutoverConfig(
  input: unknown,
): Record<string, unknown> {
  const config = objectSchema.parse(input);
  const memory = objectSchema.parse(config.memory ?? {});
  if (config.workflowDefaults !== undefined || memory.roles === undefined) {
    const defaults = objectSchema.parse(config.workflowDefaults ?? {});
    const old = objectSchema.parse(defaults.memory ?? {});
    memory.roles = {
      implementer: {
        read: "ambient",
        contribute: "on",
        ...objectSchema.parse(old.implementer ?? {}),
      },
      validator: {
        read: "off",
        contribute: "off",
        ...objectSchema.parse(old.validator ?? {}),
      },
    };
  }
  config.memory = memory;
  delete config.workflowDefaults;
  delete config.preMergeTimeoutMs;
  delete config.graphWorkflowLaunchesFrozen;
  if (config.pushNotification !== undefined) {
    const push = objectSchema.parse(config.pushNotification);
    if (push.triggers !== undefined) {
      const triggers = objectSchema.parse(push.triggers);
      delete triggers.planRepair;
      push.triggers = triggers;
    }
    config.pushNotification = push;
  }
  const parsed = rawGlobalConfigSchema.safeParse(config);
  if (!parsed.success)
    throw new Error(`Cutover config is invalid: ${parsed.error.message}`);
  return config;
}

function retireWorkflowSubscriptions({ db }: MigrationContext): void {
  const batches = db
    .prepare(
      `
    SELECT b.id, b.payload_json FROM conversation_subscription_wake_batches b
    WHERE b.state IN ('planned','queued','failed','uncertain') AND (
      EXISTS (SELECT 1 FROM conversation_subscription_waits w
        JOIN conversation_subscriptions s ON s.id=w.subscription_id
        WHERE w.batch_id=b.id AND s.source_kind='workflow')
      OR EXISTS (SELECT 1 FROM json_each(b.payload_json, '$.followDeliveryIds') member
        JOIN conversation_subscription_deliveries d ON d.id=member.value
        WHERE d.source_kind='workflow')
      OR EXISTS (SELECT 1 FROM json_each(b.payload_json, '$.deliveryIds') member
        JOIN conversation_subscription_deliveries d ON d.id=member.value
        WHERE d.source_kind='workflow'))
  `,
    )
    .all();
  for (const raw of batches) {
    const batch = rowSchema.parse(raw);
    const payload = objectSchema.parse(JSON.parse(batch.payload_json));
    const deliveryIds = z.array(z.string()).parse(payload.deliveryIds ?? []);
    const followDeliveryIds = z
      .array(z.string())
      .parse(payload.followDeliveryIds ?? []);
    for (const table of ["conversations", "project_conversations"]) {
      db.prepare(
        `UPDATE ${table} SET pending_queue = (
        SELECT CASE WHEN count(*)=0 THEN NULL ELSE json_group_array(json(value)) END
        FROM json_each(${table}.pending_queue)
        WHERE NOT (json_extract(value,'$.metadata.kind') IS 'subscription_update'
          AND json_extract(value,'$.metadata.batchId') IS ?
          AND json_extract(value,'$.status') IN ('pending','failed','uncertain'))
      ) WHERE pending_queue IS NOT NULL`,
      ).run(batch.id);
    }
    db.prepare(
      `UPDATE conversation_subscription_wake_batches
      SET state='cancelled', payload_json=json_set(payload_json,'$.state','cancelled')
      WHERE id=?`,
    ).run(batch.id);
    db.prepare(
      `UPDATE conversation_subscription_waits SET batch_id=NULL,
      payload_json=json_set(payload_json,'$.batchId',json('null')) WHERE batch_id=?`,
    ).run(batch.id);
    for (const id of [...deliveryIds, ...followDeliveryIds]) {
      db.prepare(
        `UPDATE conversation_subscription_deliveries SET state='pending',
        attempt_id=NULL, queued_at=NULL, accepted_at=NULL, finished_at=NULL, last_error=NULL
        WHERE id=? AND state IN ('queued','failed','uncertain')`,
      ).run(id);
    }
  }
  db.exec(`
    DELETE FROM conversation_subscription_read_state WHERE delivery_id IN
      (SELECT id FROM conversation_subscription_deliveries WHERE source_kind='workflow');
    DELETE FROM conversation_subscription_waits WHERE subscription_id IN
      (SELECT id FROM conversation_subscriptions WHERE source_kind='workflow');
    DELETE FROM conversation_subscription_deliveries WHERE source_kind='workflow';
    DELETE FROM conversation_subscriptions WHERE source_kind='workflow';
  `);
}

/** Offline retirement: the operator's whole-state backup owns rollback. */
export const graphEngineCutover: StateMigration = {
  name: "0069-graph-engine-cutover",
  async up({ context }) {
    const { db, configDir } = context;
    const configPath =
      configDir === null ? null : path.join(configDir, "config.json");
    const config =
      configPath !== null && existsSync(configPath)
        ? transformCutoverConfig(JSON.parse(readFileSync(configPath, "utf8")))
        : null;
    // Parse before publishing the forward-only barrier or changing any bytes.
    if (configDir !== null) {
      if (configPath !== null && config !== null) {
        const backupPath = `${configPath}.pre-deploy-2`;
        if (!existsSync(backupPath))
          copyFileSync(configPath, backupPath, constants.COPYFILE_EXCL);
      }
      await publishSchemaCompatibilityBarrier(configDir, 30);
      if (configPath !== null && config !== null)
        await atomicWriteJson(configPath, config);
    }
    db.transaction(() => {
      enforceCurrentSchemaCompatibility(db, db.name, 30);
      for (const table of ["conversations", "project_conversations"]) {
        db.prepare(
          `UPDATE ${table} SET checkpoint_fork=
          json_set(checkpoint_fork,'$.relatedWork',json('null'))
          WHERE json_extract(checkpoint_fork,'$.relatedWork.kind')='workflow_assignment'`,
        ).run();
        db.prepare(
          `UPDATE ${table} SET pending_queue=NULL,
          status=CASE WHEN status IN ('running','waiting_for_input') THEN 'awaiting' ELSE status END,
          pending_question_id=NULL, pending_questions=NULL, pending_prompt_text=NULL,
          conversation_owner=NULL
          WHERE role IS NOT NULL AND NOT EXISTS
            (SELECT 1 FROM core_seat_bindings seat WHERE seat.conversation_id=${table}.id)`,
        ).run();
      }
      db.exec(`
        CREATE TEMP TABLE cutover_delivery_approvals AS SELECT approval_id FROM spec_gate_admissions
          WHERE gate IN ('execution_start','delivery') AND approval_id IS NOT NULL;
        CREATE TEMP TABLE cutover_attention_ids AS SELECT spec_gate_request_id AS id FROM notifications
          WHERE source='spec' AND (spec_gate IN ('execution_start','delivery') OR type='spec-waiver-requested');
        DELETE FROM spec_gate_admissions WHERE gate IN ('execution_start','delivery');
        DELETE FROM spec_approvals WHERE id IN (SELECT approval_id FROM cutover_delivery_approvals)
          AND NOT EXISTS (SELECT 1 FROM spec_gate_admissions WHERE approval_id=spec_approvals.id);
        DELETE FROM spec_events WHERE event_type IN ('spec-execution-changed','spec-evidence-changed')
          OR event_type GLOB 'spec-delivery-plan-*'
          OR json_extract(payload_json,'$.gate') IN ('execution_start','delivery')
          OR json_extract(payload_json,'$.executionId') IS NOT NULL
          OR json_extract(payload_json,'$.attemptId') IS NOT NULL
          OR json_extract(payload_json,'$.surface') IN ('execution_start','delivery_gate')
          OR (event_type='spec-review-item-approved' AND json_extract(payload_json,'$.kind')
            IN ('delivery-approval-granted','execution-start-approval-granted'))
          OR (event_type='spec-attention-changed' AND json_extract(payload_json,'$.kind')='waiver-request-routed')
          OR (event_type='approval-request-retired' AND json_extract(payload_json,'$.attentionId')
            IN (SELECT id FROM cutover_attention_ids));
        DELETE FROM notifications WHERE source='workflow' OR (source='spec' AND
          (spec_gate IN ('execution_start','delivery') OR type='spec-waiver-requested'));
        DELETE FROM spec_links WHERE object_kind IN ('workflow_execution','merge_job');
        UPDATE specs SET gate_policy_json=json_remove(gate_policy_json,'$.overrides.execution_start','$.overrides.delivery')
          WHERE gate_policy_json IS NOT NULL;
        CREATE TEMP TABLE cutover_plan_drafts AS SELECT id FROM spec_revisions
          WHERE state='draft' AND authoring_stage='plan';
        CREATE TEMP TABLE cutover_plan_requests AS
          SELECT spec_id, json_extract(payload_json,'$.attentionId') AS attention_id FROM spec_events
          WHERE event_type='spec-attention-changed' AND json_extract(payload_json,'$.kind')='approval-requested'
            AND json_extract(payload_json,'$.gate')='plan'
            AND json_extract(payload_json,'$.revisionId') IN (SELECT id FROM cutover_plan_drafts);
        INSERT INTO spec_events(spec_id,occurred_at,event_type,actor_json,payload_json)
          SELECT request.spec_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'spec-attention-changed',
            '{"kind":"system"}', json_object('kind','approval-request-retired',
              'attentionId',request.attention_id,'reason','legacy plan stage retired','active',json('false'))
          FROM cutover_plan_requests request WHERE NOT EXISTS
            (SELECT 1 FROM spec_events retired WHERE retired.spec_id=request.spec_id
              AND json_extract(retired.payload_json,'$.kind')='approval-request-retired'
              AND json_extract(retired.payload_json,'$.attentionId')=request.attention_id);
        UPDATE spec_revisions SET state='withdrawn' WHERE id IN (SELECT id FROM cutover_plan_drafts);
        DELETE FROM notifications WHERE source='spec'
          AND spec_gate_request_id IN (SELECT attention_id FROM cutover_plan_requests);
        DROP TABLE cutover_plan_requests;
        DROP TABLE cutover_plan_drafts;
        DROP TABLE cutover_delivery_approvals;
        DROP TABLE cutover_attention_ids;
      `);
      retireWorkflowSubscriptions(context);
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations(version,description) VALUES (30,?)",
      ).run(
        "retire graph workflows, conversation actors and native spec delivery",
      );
    }).immediate();
    if (configDir !== null)
      rmSync(path.join(configDir, "workflows"), {
        recursive: true,
        force: true,
      });
  },
};
