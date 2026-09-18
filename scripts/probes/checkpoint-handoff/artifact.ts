import { getConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/service-factory";
import { getCompactionService } from "@/lib/context-artifacts/route-handlers";
import {
  getConversation,
  getProjectConversation,
  getStateDb,
} from "@/lib/state-store";
import { checkpointScopeKeyForStoreIdentity } from "@/lib/workflows/conversation/actor-input-loader";
import { assertIsolated } from "../checkpoint-continuation/environment";
import type { loadArtifactEnvironment } from "./artifact-environment";
import { digest } from "./evidence";

export async function runArtifactIndependence(
  input: ReturnType<typeof loadArtifactEnvironment>,
) {
  const { environment, prior } = input;
  assertIsolated(getStateDb().name, environment);
  const sessionName =
    prior.args.scope === "session" ? "checkpoint-probe" : null;
  const conversationId = prior.result.conversationId;
  const scopeKey = checkpointScopeKeyForStoreIdentity({
    projectPath: environment.projectPath,
    sessionName: sessionName ?? "__project__",
    conversationId,
  });
  const repo = getConversationCheckpointsRepo();
  const readRow = () =>
    sessionName === null
      ? getProjectConversation(environment.projectPath, conversationId)
      : getConversation(environment.projectPath, sessionName, conversationId);
  const before = await readRow();
  if (!before) throw new Error("saved artifact source conversation is missing");
  const saved = await Promise.all(
    prior.result.cycles.map(async (cycle) => {
      const payload = await repo.getPayload(scopeKey, cycle.operationId);
      if (
        !payload ||
        payload.seedSha256 !== cycle.seedSha256 ||
        digest(payload.seedText) !== cycle.seedSha256
      )
        throw new Error("saved cycle seed does not match original evidence");
      return payload;
    }),
  );
  const operationsBefore = await repo.listReceipts(scopeKey, { limit: 100 });
  const started = await getCompactionService().trigger({
    kind: "conversation_compaction",
    scope: prior.args.scope,
    projectPath: environment.projectPath,
    projectName: environment.projectName,
    sessionName,
    conversationId,
    transcriptPath: prior.result.transcriptPath,
    createdBy: "user",
    trigger: "checkpoint_handoff_artifact_probe",
  });
  if (started.outcome !== "started")
    throw new Error(`artifact generation refused: ${started.outcome}`);
  const artifact = await started.completion;
  const after = await readRow();
  const operationsAfter = await repo.listReceipts(scopeKey, { limit: 100 });
  const reloaded = await Promise.all(
    saved.map((payload) => repo.getPayload(scopeKey, payload.id)),
  );
  const checks = {
    artifactCompleted: artifact.status === "complete",
    seedBytesUnchanged: saved.every(
      (payload, index) =>
        payload.seedText === reloaded[index]?.seedText &&
        payload.seedSha256 === reloaded[index]?.seedSha256,
    ),
    providerReferenceUnchanged:
      JSON.stringify(before.backendRef) === JSON.stringify(after?.backendRef),
    checkpointReceiptsUnchanged:
      JSON.stringify(operationsBefore) === JSON.stringify(operationsAfter),
    identityUnchanged:
      after?.id === before.id && after.transcriptPath === before.transcriptPath,
  };
  return {
    status: Object.values(checks).every(Boolean)
      ? ("passed" as const)
      : ("failed" as const),
    checks,
    conversationId,
    seedHashes: saved.map((payload) => payload.seedSha256),
    priorBackendRef: before.backendRef,
    followingBackendRef: after?.backendRef ?? null,
    artifact,
  };
}
