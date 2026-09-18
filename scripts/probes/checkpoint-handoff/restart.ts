import { restartCaptureStarts } from "./restart-capture-evidence";
import { routeCaptureMode } from "./route-capture-mode";
import { waitForRestartApi } from "./restart-readiness";
import {
  restartQueueRequest,
  restartQueuedMessageId,
} from "./restart-requests";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { checkpointReceiptSchema } from "@/lib/conversation-checkpoints/receipt";
import {
  conversationTargetApiBase,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import type { ProbeEnvironment } from "../checkpoint-continuation/environment";
import { createSubmissionBudget, parseJsonl } from "./evidence";
import { checkpointProbeRoutes, resolveDevProbeClient } from "./routes";
import {
  collectStoppedRouteProcesses,
  observeRouteServer,
  productionRouteCleanup,
  snapshotRouteProcesses,
  type ObservedProcess,
} from "./route-cleanup";
import {
  assessRestartEvidence,
  type RestartEvidence,
} from "./restart-evidence";

const envelope = z.object({ receipt: checkpointReceiptSchema });
const conversationList = z.array(
  z.object({
    id: z.string(),
    pendingQueue: z.array(z.object({ id: z.string(), status: z.string() })),
  }),
);

/** Explicit destructive stop of only the already observed isolated dev daemon. */
export async function runDaemonRestartProbe(options: {
  backend: "claude" | "codex";
  scope: "session" | "project";
  environment: ProbeEnvironment;
  budget: ReturnType<typeof createSubmissionBudget>;
}) {
  const { environment, scope, budget, backend } = options;
  let client = resolveDevProbeClient();
  let serverProcess: ObservedProcess | null = observeRouteServer(client.server);
  const records: { step: string; status: number; body: unknown }[] = [];
  let originalConfig: Record<string, unknown> | null = null;
  let target: ConversationTarget | null = null;
  let interruptionCleanup: Awaited<
    ReturnType<typeof collectStoppedRouteProcesses>
  > | null = null;
  let testimony: unknown = null;
  let verdict: RestartEvidence | null = null;
  async function request(
    step: string,
    route: string,
    method = "GET",
    body?: unknown,
  ) {
    const response = await client.request(route, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    records.push({ step, ...response });
    if (response.status >= 400)
      throw new Error(`${step}: HTTP ${response.status}`);
    return response.body;
  }
  try {
    originalConfig = z
      .object({ raw: z.record(z.string(), z.unknown()) })
      .parse(await request("read original dev config", "/api/config")).raw;
    await request("configure isolated project", "/api/config", "PUT", {
      ...originalConfig,
      baseDir: path.dirname(environment.projectPath),
      conversationNaming: { enabled: false },
    });
    let collection = `/api/projects/${encodeURIComponent(environment.projectName)}`;
    let sessionName: string | null = null;
    if (scope === "session") {
      sessionName = `restart-${randomUUID().slice(0, 8)}`;
      await request("create session", `${collection}/sessions`, "POST", {
        mode: "normal",
        sessionName,
      });
      collection += `/sessions/${encodeURIComponent(sessionName)}`;
    }
    const conversationId = z
      .object({ id: z.string() })
      .parse(
        await request(
          "create conversation",
          `${collection}/conversations`,
          "POST",
          scope === "project"
            ? { agentBackend: backend, name: "daemon restart probe" }
            : {},
        ),
      ).id;
    target =
      sessionName === null
        ? {
            scope: "project",
            projectName: environment.projectName,
            conversationId,
          }
        : {
            scope: "session",
            projectName: environment.projectName,
            sessionName,
            conversationId,
          };
    const base = conversationTargetApiBase(target);
    budget.admit("ordinary", "daemon restart source");
    const source = await client.stream(`${base}/prompt`, {
      prompt:
        "Record working state for RESTART-731. Failed approach: replaying an uncertain queued message duplicates work. Hypothesis: the earlier worker may be gone, not established. Next action remains pending until explicitly asked. Do not call tools. Reply briefly.",
      backend,
      ...(environment.modelSelection
        ? { modelSelection: environment.modelSelection }
        : {}),
    });
    records.push({
      step: "source turn",
      status: source.status,
      body: source.text,
    });
    if (
      source.status !== 200 ||
      /event: error/.test(source.text) ||
      Buffer.byteLength(source.text) > 100_000 ||
      /"tool_use"|"tool_result"/.test(source.text)
    )
      throw new Error("source did not establish a bounded tool-free fixture");
    let controls = checkpointProbeRoutes(client, target);
    // Compile the read handlers before the short capture window begins.
    // These reads cannot admit provider work or mutate checkpoint state.
    const queueWarmup = await client.request(`${base}/queue`);
    records.push({ step: "prewarm queue read", ...queueWarmup });
    if (![200, 404, 405].includes(queueWarmup.status))
      throw new Error(`queue prewarm refused: HTTP ${queueWarmup.status}`);
    // The POST-only queue module returns 405 to this compilation warmup.
    // A supported read must independently establish API readiness.
    const listWarmup = await client.request(`${collection}/conversations`);
    records.push({
      step: "prewarm supported conversation list",
      ...listWarmup,
    });
    if (listWarmup.status !== 200)
      throw new Error(`conversation read refused: HTTP ${listWarmup.status}`);
    conversationList.parse(listWarmup.body);
    const detailWarmup = await controls.get(randomUUID());
    records.push({ step: "prewarm missing checkpoint read", ...detailWarmup });
    if (detailWarmup.status !== 404)
      throw new Error(
        `missing checkpoint prewarm unexpected: HTTP ${detailWarmup.status}`,
      );
    const eligibility = await controls.check();
    records.push({ step: "capture eligibility", ...eligibility });
    const captureMode = routeCaptureMode(eligibility.body);
    budget.reserve("capture", "restart initial capture max1");
    for (let slot = 0; slot < 6; slot++)
      budget.reserve("generation", `restart initial generation max6:${slot}`);
    const started = await controls.start({
      requestId: randomUUID(),
      handoff: { mode: captureMode },
    });
    records.push({ step: "initial capture start", ...started });
    if (started.status !== 202)
      throw new Error("capture was not durably admitted");
    const operationId = envelope.parse(started.body).receipt.operationId;
    budget.reserve(
      "ordinary",
      "one queued continuation after explicit recovery",
    );
    const queueId = restartQueuedMessageId(
      await request(
        "enqueue held input",
        `${base}/queue`,
        "POST",
        restartQueueRequest(),
      ),
    );
    const captureId = `${operationId}:capture`;
    const transcriptPath = path.join(
      client.configDir,
      "transcripts",
      `${conversationId}.jsonl`,
    );
    const captureDeadline = Date.now() + 45_000;
    while (true) {
      const receipt = envelope.parse(
        (await controls.get(operationId)).body,
      ).receipt;
      const audit = existsSync(transcriptPath)
        ? restartCaptureStarts(
            readFileSync(transcriptPath, "utf8"),
            captureId,
            captureMode,
          )
        : null;
      if (
        receipt.phase === "building" &&
        receipt.handoff?.stage === "running" &&
        audit?.count === 1
      )
        break;
      if (receipt.phase !== "building" || Date.now() >= captureDeadline)
        throw new Error(
          "capture completed or did not initialize before the controlled daemon loss",
        );
      await delay(100);
    }
    const beforeKill = envelope.parse(
      (await controls.get(operationId)).body,
    ).receipt;
    if (
      beforeKill.phase !== "building" ||
      beforeKill.handoff?.stage !== "running"
    )
      throw new Error(
        "capture settled before interruption; no daemon-loss claim can be made",
      );
    const prefix = readFileSync(transcriptPath);
    records.push({
      step: "capture-owned provider start before interruption",
      status: 200,
      body: restartCaptureStarts(
        prefix.toString("utf8"),
        captureId,
        captureMode,
      ),
    });
    const ownedServer = serverProcess;
    if (!ownedServer) throw new Error("daemon ownership observation missing");
    interruptionCleanup = await collectStoppedRouteProcesses(ownedServer, {
      ...productionRouteCleanup,
      stopServer() {
        if (
          !snapshotRouteProcesses().some(
            (item) =>
              item.pid === ownedServer.pid &&
              item.started === ownedServer.started,
          )
        )
          throw new Error("owned daemon identity changed before interruption");
        process.kill(ownedServer.pid, "SIGKILL");
        productionRouteCleanup.stopServer();
      },
    });
    serverProcess = null;
    if (!interruptionCleanup.settled)
      throw new Error("daemon descendants remain; acknowledgement prohibited");
    client = resolveDevProbeClient();
    serverProcess = observeRouteServer(client.server);
    controls = checkpointProbeRoutes(client, target);
    const readiness = await waitForRestartApi({
      read: (signal) => client.request("/api/config", { signal }),
      now: Date.now,
      wait: async (ms) => {
        await delay(ms);
      },
    });
    records.push({
      step: "read-only restarted API readiness",
      status: readiness.status,
      body: readiness,
    });
    const restartedReconcile = await controls.reconcile(operationId);
    records.push({
      step: "deterministic restart reconciliation without testimony",
      ...restartedReconcile,
    });
    const receiptDeadline = Date.now() + 30_000;
    let interrupted = envelope.parse(
      (await controls.get(operationId)).body,
    ).receipt;
    while (interrupted.phase === "building" && Date.now() < receiptDeadline) {
      await delay(250);
      await controls.check();
      interrupted = envelope.parse(
        (await controls.get(operationId)).body,
      ).receipt;
    }
    records.push({ step: "restarted receipt", status: 200, body: interrupted });
    if (interrupted.phase !== "needs_reconciliation")
      throw new Error(
        `restart did not retain the required cleanup hold (${interrupted.phase})`,
      );
    const pendingIds = async () => {
      const rows = conversationList.parse(
        await request("read queue ownership", `${collection}/conversations`),
      );
      return (
        rows
          .find((row) => row.id === conversationId)
          ?.pendingQueue.filter((entry) => entry.status === "pending")
          .map((entry) => entry.id) ?? []
      );
    };
    const queuedAfterRestart = await pendingIds();
    if (!queuedAfterRestart.includes(queueId))
      throw new Error(
        "restart lost or released held input; no testimony submitted",
      );
    testimony = {
      actor: "explicit test operator",
      source: "api",
      statement:
        "The test operator observed the prior dev daemon and recorded descendants exit before acknowledging stopped capture execution.",
      processEvidence: interruptionCleanup,
    };
    const acknowledged =
      await controls.acknowledgeStoppedExecution(operationId);
    records.push({
      step: "explicit stopped-execution testimony",
      ...acknowledged,
    });
    const attested = envelope.parse(acknowledged.body).receipt;
    const queuedAfterAttestation = await pendingIds();
    if (
      attested.phase !== "needs_reconciliation" ||
      attested.handoff?.executionStopAttestation?.source !== "api" ||
      !queuedAfterAttestation.includes(queueId)
    )
      throw new Error(
        "acknowledgement did not preserve separate recovery ownership",
      );
    for (let slot = 0; slot < 6; slot++)
      budget.reserve("generation", `separate baseline recovery max6:${slot}`);
    const recovery = await controls.start({
      requestId: randomUUID(),
      recoversOperationId: operationId,
    });
    records.push({ step: "separate baseline recovery", ...recovery });
    if (recovery.status !== 202)
      throw new Error("separate baseline recovery refused");
    const recoveryId = envelope.parse(recovery.body).receipt.operationId;
    const deadline = Date.now() + 300_000;
    let applied = envelope.parse((await controls.get(recoveryId)).body).receipt;
    while (
      ["building", "retiring", "ready", "delivering"].includes(applied.phase) &&
      Date.now() < deadline
    ) {
      await delay(250);
      applied = envelope.parse((await controls.get(recoveryId)).body).receipt;
    }
    records.push({ step: "recovery outcome", status: 200, body: applied });
    const afterArchive = readFileSync(transcriptPath);
    const ownershipSchema = z.object({
      origin: z.object({
        source: z.literal("checkpoint_capture"),
        checkpointCapture: z.object({ captureId: z.string() }),
      }),
    });
    const captureIds = [
      ...new Set(
        parseJsonl(afterArchive.toString("utf8")).flatMap((entry) => {
          const owned = ownershipSchema.safeParse(entry);
          return owned.success
            ? [owned.data.origin.checkpointCapture.captureId]
            : [];
        }),
      ),
    ];
    const observedCaptureIds = captureIds.flatMap((id) =>
      Array.from(
        {
          length: Math.max(
            1,
            restartCaptureStarts(afterArchive.toString("utf8"), id, captureMode)
              .count,
          ),
        },
        () => id,
      ),
    );
    verdict = {
      observedProcessCount: interruptionCleanup.observed.length,
      remainingProcessCount: interruptionCleanup.remaining.length,
      originalCaptureId: captureId,
      observedCaptureIds,
      queueId,
      queuedAfterRestart,
      queuedAfterAttestation,
      archivePrefixHash: createHash("sha256").update(prefix).digest("hex"),
      reloadedArchivePrefixHash: createHash("sha256")
        .update(afterArchive.subarray(0, prefix.length))
        .digest("hex"),
      attestationSource:
        attested.handoff?.executionStopAttestation?.source ?? null,
      attestedPhase: attested.phase,
      recoveryPhase: applied.phase,
      recoveryHadHandoff: applied.handoff !== null,
      acceptedQueueId: applied.delivery?.queuedMessageId ?? null,
    };
    const failures = assessRestartEvidence(verdict);
    return {
      status: failures.length === 0 ? ("passed" as const) : ("failed" as const),
      failures,
      verdict,
      target,
      records,
      testimony,
      interruptionCleanup,
    };
  } finally {
    const cleanupErrors: string[] = [];
    let configRestored = originalConfig === null;
    if (originalConfig) {
      try {
        configRestored =
          (
            await client.request("/api/config", {
              method: "PUT",
              body: JSON.stringify(originalConfig),
            })
          ).status === 200;
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    let finalCleanup: Awaited<
      ReturnType<typeof collectStoppedRouteProcesses>
    > | null = null;
    if (serverProcess) {
      try {
        finalCleanup = await collectStoppedRouteProcesses(
          serverProcess,
          productionRouteCleanup,
        );
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    writeFileSync(
      path.join(environment.evidenceDir, "restart-evidence.json"),
      JSON.stringify(
        {
          target,
          records,
          testimony,
          verdict,
          interruptionCleanup,
          finalCleanup,
          configRestored,
          cleanupErrors,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (
      !configRestored ||
      (serverProcess !== null && finalCleanup?.settled !== true)
    )
      throw new Error(
        "restart probe cleanup unresolved; inspect protected restart-evidence.json",
      );
  }
}
