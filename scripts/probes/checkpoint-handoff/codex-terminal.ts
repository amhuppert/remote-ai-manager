import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProbeEnvironment } from "../checkpoint-continuation/environment";
import { assertIsolated } from "../checkpoint-continuation/environment";
import { createSubmissionBudget } from "./evidence";
import { auditCodexRun } from "./codex-native-evidence";
import { observeCodexFaultProcess } from "./codex-faults";

export interface TerminalProcessIdentity {
  pid: number;
  started: string;
  command: string;
}
const identitySchema = z.object({
  pid: z.number().int().positive(),
  started: z.string(),
  command: z.string(),
});
export function terminalIdentityMatches(
  marker: TerminalProcessIdentity,
  observed: TerminalProcessIdentity | null,
) {
  return (
    observed !== null &&
    marker.pid === observed.pid &&
    marker.started === observed.started &&
    observed.command === "/bin/sleep 120"
  );
}
function inspectProcess(pid: number): TerminalProcessIdentity | null {
  try {
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
    return started ? { pid, started, command } : null;
  } catch {
    return null;
  }
}
const completedNotification = z.object({
  threadId: z.string(),
  turn: z.object({ id: z.string(), status: z.literal("completed") }),
});

/** Ordinary callable terminal execution with observation only; never requests capture. */
export async function runCodexTerminalProbe(options: {
  environment: ProbeEnvironment;
  budget: ReturnType<typeof createSubmissionBudget>;
}) {
  const { environment, budget } = options;
  const { CodexConversationRuntime } =
    await import("@/lib/agent-backends/codex/conversation-runtime");
  const { createCodexAppServerClient } =
    await import("@/lib/agent-backends/codex/app-server-client");
  const { createAppServerProcessHost } =
    await import("@/lib/agent-backends/codex/app-server-client-process");
  const {
    listBackends,
    _resetBackendRegistryForTesting,
    _registerBackendForTesting,
  } = await import("@/lib/agent-backends/registry-core");
  const { createSessionRow, getStateDb } = await import("@/lib/state-store");
  const { sessionStateSchema } = await import("@/lib/sessions/schemas");
  const { makeConversationState } =
    await import("@/lib/conversations/testing/conversation-state-fixture");
  const { getTranscriptPath } = await import("@/lib/prompt/transcript");
  const { submitConversationTurn, stopConversationActor } =
    await import("@/lib/workflows/conversation/manager");
  assertIsolated(getStateDb().name, environment);
  const identityPath = path.join(
    environment.projectPath,
    "terminal-child.json",
  );
  const scriptPath = path.join(environment.projectPath, "terminal-child.py");
  writeFileSync(
    scriptPath,
    [
      "import json, os, subprocess",
      "pid = os.getpid()",
      "started = subprocess.check_output(['ps', '-p', str(pid), '-o', 'lstart='], text=True).strip()",
      `with open(${JSON.stringify(identityPath)}, 'w') as target: json.dump({'pid': pid, 'started': started, 'command': '/bin/sleep 120'}, target)`,
      "print('TERMINAL-CHILD-STARTED', flush=True)",
      "os.execv('/bin/sleep', ['/bin/sleep', '120'])",
    ].join("\n") + "\n",
  );
  const readMarker = () =>
    existsSync(identityPath)
      ? identitySchema.parse(JSON.parse(readFileSync(identityPath, "utf8")))
      : null;
  const samples: {
    turnId: string;
    threadId: string;
    marker: TerminalProcessIdentity | null;
    observed: TerminalProcessIdentity | null;
    liveAtCompletion: boolean;
  }[] = [];
  const children: ReturnType<typeof observeCodexFaultProcess>[] = [];
  const clients: ReturnType<typeof createCodexAppServerClient>[] = [];
  const descriptors = [...listBackends()];
  _resetBackendRegistryForTesting();
  for (const descriptor of descriptors) {
    if (descriptor.id !== "codex" || !descriptor.conversation) {
      _registerBackendForTesting(descriptor);
      continue;
    }
    const conversation = descriptor.conversation;
    _registerBackendForTesting({
      ...descriptor,
      conversation: {
        ...conversation,
        factory: {
          ...conversation.factory,
          async createRuntime(input) {
            return new CodexConversationRuntime(input, {
              createAppServer(clientOptions) {
                const child = observeCodexFaultProcess(
                  createAppServerProcessHost(),
                );
                children.push(child);
                const client = createCodexAppServerClient(
                  {
                    ...clientOptions,
                    onNotification(message) {
                      if (message.method === "turn/completed") {
                        const completed = completedNotification.safeParse(
                          message.params,
                        );
                        if (completed.success) {
                          const marker = readMarker();
                          const observed = marker
                            ? inspectProcess(marker.pid)
                            : null;
                          samples.push({
                            turnId: completed.data.turn.id,
                            threadId: completed.data.threadId,
                            marker,
                            observed,
                            liveAtCompletion:
                              marker !== null &&
                              terminalIdentityMatches(marker, observed),
                          });
                        }
                      }
                      clientOptions.onNotification?.(message);
                    },
                  },
                  { host: child.host },
                );
                clients.push(client);
                return client;
              },
            });
          },
        },
      },
    });
  }
  const conversationId = randomUUID();
  const transcriptPath = await getTranscriptPath(conversationId);
  const sessionName = "terminal-probe";
  const now = new Date().toISOString();
  await createSessionRow(
    environment.projectPath,
    sessionStateSchema.parse({
      sessionName,
      worktreePath: environment.projectPath,
      branchName: "main",
      createdAt: now,
      lastActivityAt: now,
      conversations: [
        makeConversationState({
          id: conversationId,
          agentBackend: "codex",
          transcriptPath,
          status: "awaiting",
          createdAt: now,
          lastActivityAt: now,
        }),
      ],
    }),
  );
  let deadlineExceeded = false;
  let deadlineStop: Promise<void> | null = null;
  let turnOutcome: unknown = null;
  const cleanupErrors: string[] = [];
  const timer = setTimeout(() => {
    deadlineExceeded = true;
    deadlineStop = stopConversationActor(
      environment.projectPath,
      sessionName,
      conversationId,
      "terminal probe deadline",
    ).catch((error) => {
      cleanupErrors.push(String(error));
    });
  }, 60_000);
  try {
    budget.admit("ordinary", "running terminal completed-turn fixture");
    const admission = await submitConversationTurn({
      binding: {
        kind: "durable",
        address: {
          projectPath: environment.projectPath,
          target: {
            scope: "session",
            projectName: environment.projectName,
            sessionName,
            conversationId,
          },
        },
      },
      turn: {
        promptText: `This is an explicitly authorized isolated terminal-lifecycle test. Run exactly one ordinary shell command: python3 ${JSON.stringify(scriptPath)}. Use the ordinary exec_command tool with yield_time_ms 1000 and max_output_tokens 200 so it returns a running terminal/session handle while /bin/sleep 120 is still active. Do not use &, nohup, disown, subprocess background spawning, or delegation. Once the tool yields its running handle, immediately finish this agent turn with exactly TERMINAL-TURN-COMPLETE. Do not wait or poll: the external test harness already owns deterministic collection and will close the provider client and collect its terminal immediately after this turn completes. The script records the actual child PID/start identity before execing sleep. Do not start any other command or alter the script.`,
        images: [],
      },
    });
    if (admission.kind !== "accepted")
      throw new Error("terminal ordinary turn refused");
    turnOutcome = await admission.turn.completed;
  } catch (error) {
    cleanupErrors.push(String(error));
  } finally {
    clearTimeout(timer);
    if (deadlineStop) await deadlineStop;
    try {
      await stopConversationActor(
        environment.projectPath,
        sessionName,
        conversationId,
        "terminal probe finished",
      );
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    for (const client of clients)
      try {
        await client.close();
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    _resetBackendRegistryForTesting();
    for (const descriptor of descriptors)
      _registerBackendForTesting(descriptor);
  }
  const marker = readMarker();
  const afterClose = marker ? inspectProcess(marker.pid) : null;
  const terminalCollected =
    marker !== null &&
    (afterClose === null || afterClose.started !== marker.started);
  // Emergency collection is distinct from a successful production close claim.
  let emergencyCollected = false;
  if (marker && terminalIdentityMatches(marker, afterClose)) {
    process.kill(marker.pid, "SIGTERM");
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!terminalIdentityMatches(marker, inspectProcess(marker.pid))) {
        emergencyCollected = true;
        break;
      }
    }
  }
  const processEvidence = children.flatMap((child) => {
    const item = child.evidence();
    return item ? [item] : [];
  });
  const native = auditCodexRun(transcriptPath, environment.evidenceDir);
  const passed =
    samples.some((sample) => sample.liveAtCompletion) &&
    terminalCollected &&
    processEvidence.length > 0 &&
    processEvidence.every((item) => item.exitObserved) &&
    !deadlineExceeded &&
    cleanupErrors.length === 0;
  const publicResult = {
    status: passed ? "passed" : "failed",
    scope: "session",
    providerCompletedWithLiveTerminal: samples.some(
      (sample) => sample.liveAtCompletion,
    ),
    completedNotifications: samples.length,
    terminalCollectedByProductionClose: terminalCollected,
    emergencyCollected,
    appServerProcessCount: processEvidence.length,
    allAppServersExited:
      processEvidence.length > 0 &&
      processEvidence.every((item) => item.exitObserved),
    deadlineExceeded,
    cleanupErrors,
    native,
    accounting: budget.snapshot(),
    captureRequested: false,
  };
  writeFileSync(
    path.join(environment.evidenceDir, "terminal-protected.json"),
    JSON.stringify(
      {
        ...publicResult,
        samples,
        marker,
        afterClose,
        processEvidence,
        turnOutcome,
        transcriptPath,
        conversationId,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(environment.evidenceDir, "terminal-public.json"),
    JSON.stringify(publicResult, null, 2),
  );
  return publicResult;
}
