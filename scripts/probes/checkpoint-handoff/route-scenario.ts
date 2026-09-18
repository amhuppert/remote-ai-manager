import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { checkpointReceiptSchema } from "@/lib/conversation-checkpoints/receipt";
import {
  conversationTargetApiBase,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import type { ProbeEnvironment } from "../checkpoint-continuation/environment";
import { HANDOFF_SOURCE, HANDOFF_EXPECTATIONS } from "./corpus";
import { createSubmissionBudget, digest } from "./evidence";
import { checkpointProbeRoutes, resolveDevProbeClient } from "./routes";
import { routeCaptureMode } from "./route-capture-mode";
import {
  collectStoppedRouteProcesses,
  observeRouteServer,
  productionRouteCleanup,
} from "./route-cleanup";

/**
 * A separate, tiny authenticated route journey. Remote generation reserves six
 * slots BEFORE start: one full envelope (initial/schema/guard) and at most two
 * working-state attempts, with one conservative spare. The fixture has only one
 * short source exchange, no earlier envelope and no tools. Reservations are
 * published separately from observed generationPassCount, never called usage.
 */
export async function runHandoffRouteScenario(options: {
  scope: "session" | "project";
  backend: "claude" | "codex";
  environment: ProbeEnvironment;
  budget: ReturnType<typeof createSubmissionBudget>;
}) {
  const { environment, scope, backend, budget } = options;
  const client = resolveDevProbeClient();
  const serverProcess = observeRouteServer(client.server);
  const records: { step: string; status: number; body: unknown }[] = [];
  async function request(step: string, route: string, body?: unknown) {
    const response = await client.request(
      route,
      body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
    );
    records.push({ step, ...response });
    if (response.status >= 400)
      throw new Error(`${step} returned HTTP ${response.status}`);
    return response.body;
  }
  const current = z
    .object({ raw: z.record(z.string(), z.unknown()) })
    .parse(await request("read dev config", "/api/config"));
  const configured = await client.request("/api/config", {
    method: "PUT",
    body: JSON.stringify({
      ...current.raw,
      baseDir: path.dirname(environment.projectPath),
      conversationNaming: { enabled: false },
    }),
  });
  if (configured.status !== 200)
    throw new Error(`scratch dev configuration refused: ${configured.status}`);
  let target: ConversationTarget | null = null;
  let worktree = environment.projectPath;
  let cleanupSettled = false;
  try {
    const project = encodeURIComponent(environment.projectName);
    let base = `/api/projects/${project}`;
    if (scope === "session") {
      const sessionName = `route-${randomUUID().slice(0, 8)}`;
      const session = z.object({ worktreePath: z.string() }).parse(
        await request("create session", `${base}/sessions`, {
          mode: "normal",
          sessionName,
        }),
      );
      worktree = session.worktreePath;
      base += `/sessions/${encodeURIComponent(sessionName)}`;
      const conversation = z
        .object({ id: z.string() })
        .parse(
          await request("create conversation", `${base}/conversations`, {}),
        );
      target = {
        scope,
        projectName: environment.projectName,
        sessionName,
        conversationId: conversation.id,
      };
    } else {
      const conversation = z.object({ id: z.string() }).parse(
        await request("create conversation", `${base}/conversations`, {
          agentBackend: backend,
          name: "handoff route probe",
        }),
      );
      target = {
        scope,
        projectName: environment.projectName,
        conversationId: conversation.id,
      };
    }
    const conversationBase = conversationTargetApiBase(target);
    async function ordinary(prompt: string, label: string) {
      budget.admit("ordinary", label);
      const response = await client.stream(`${conversationBase}/prompt`, {
        prompt,
        backend,
        ...(environment.modelSelection
          ? { modelSelection: environment.modelSelection }
          : {}),
      });
      records.push({
        step: label,
        status: response.status,
        body: response.text,
      });
      if (response.status !== 200 || /event: error/.test(response.text))
        throw new Error(`${label} failed`);
      if (
        label === "route source" &&
        (Buffer.byteLength(response.text, "utf8") > 100_000 ||
          /"tool_use"|"tool_result"/.test(response.text))
      ) {
        throw new Error(
          "route source exceeds the tool-free single-window fixture; generation was not submitted",
        );
      }
    }
    await ordinary(
      `${HANDOFF_SOURCE}\nDo not call tools. Reply briefly and leave all pending actions for a future ordinary turn.`,
      "route source",
    );
    const controls = checkpointProbeRoutes(client, target);
    const eligibility = await controls.check();
    records.push({ step: "capture eligibility", ...eligibility });
    const captureMode = routeCaptureMode(eligibility.body);
    budget.reserve("capture", "route capture upper-bound reservation");
    for (let slot = 0; slot < 6; slot++)
      budget.reserve(
        "generation",
        `route generation upper-bound reservation ${slot + 1}/6`,
      );
    const started = await controls.start({
      requestId: randomUUID(),
      handoff: { mode: captureMode },
    });
    records.push({ step: "start", ...started });
    if (started.status !== 202)
      throw new Error("route admission did not return 202");
    const receiptEnvelope = z.object({ receipt: checkpointReceiptSchema });
    let receipt = receiptEnvelope.parse(started.body).receipt;
    const operationId = receipt.operationId;
    const deadline = Date.now() + 300_000;
    while (
      ["building", "retiring"].includes(receipt.phase) &&
      Date.now() < deadline
    ) {
      await delay(250);
      receipt = receiptEnvelope.parse(
        (await controls.get(operationId)).body,
      ).receipt;
    }
    records.push({ step: "settled checkpoint", status: 200, body: receipt });
    if (receipt.phase !== "ready")
      throw new Error(`route checkpoint ended ${receipt.phase}`);
    const frozen = await controls.get(operationId);
    records.push({ step: "frozen seed", ...frozen });
    await ordinary(
      "Reply ROUTE-CONTINUED. State the exact issue ID, failed approach and next action from the historical task. Do not use tools or perform the pending file action.",
      "route fresh continuation",
    );
    const applied = receiptEnvelope.parse(
      (await controls.get(operationId)).body,
    ).receipt;
    records.push({ step: "applied receipt", status: 200, body: applied });
    const canaryAbsent = !existsSync(
      path.join(worktree, HANDOFF_EXPECTATIONS.absentFile),
    );
    const passed =
      applied.phase === "applied" &&
      applied.hasAcceptedContinuation &&
      canaryAbsent &&
      receipt.handoff?.modeEstablished === true &&
      receipt.handoff.requestedMode === captureMode;
    return {
      status: passed ? "passed" : "failed",
      target,
      records,
      server: client.server,
      configDir: client.configDir,
      generationReservations: 6,
      generationSubmissionsObserved: applied.generationPassCount,
      canaryAbsent,
      captureMode,
      startFailureCode: client.startFailureCode ?? null,
      frozenResponseSha256: digest(JSON.stringify(frozen.body)),
      // This is live HTTP/persistence evidence, not the three-cycle certification.
      coverage: "one authenticated capture and fresh continuation",
    };
  } finally {
    let configRestored = false;
    let processCleanup: Awaited<
      ReturnType<typeof collectStoppedRouteProcesses>
    > | null = null;
    const cleanupErrors: string[] = [];
    try {
      const restored = await client.request("/api/config", {
        method: "PUT",
        body: JSON.stringify(current.raw),
      });
      configRestored = restored.status === 200;
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      processCleanup = await collectStoppedRouteProcesses(
        serverProcess,
        productionRouteCleanup,
      );
      cleanupSettled = processCleanup.settled;
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
    writeFileSync(
      path.join(environment.evidenceDir, "route-evidence.json"),
      JSON.stringify(
        {
          records,
          target,
          cleanupSettled,
          processCleanup,
          configRestored,
          cleanupErrors,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (!configRestored || !cleanupSettled)
      throw new Error(
        "route fixture cleanup or config restoration did not settle; inspect protected evidence",
      );
  }
}
