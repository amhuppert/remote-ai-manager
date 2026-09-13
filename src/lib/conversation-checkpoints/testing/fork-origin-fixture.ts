import type { CheckpointForkOrigin } from "../fork-schemas";

export function checkpointForkOriginFixture(
  overrides: Partial<CheckpointForkOrigin> = {},
): CheckpointForkOrigin {
  const source = {
    scope: "session",
    projectName: "test",
    sessionName: "session",
    conversationId: "source",
  } as const;
  return {
    source,
    evidenceSource: source,
    sourceOperationId: "source-checkpoint",
    ordinal: 2,
    schemaVersion: 1,
    seedSha256: "saved-seed-hash",
    capturedThroughSeq: 42,
    operationId: "fork",
    requestHash: "request-hash",
    relatedWork: { kind: "ticket", ticketNumber: 131 },
    initialSelection: {
      backend: "codex",
      modelSelection: { modelId: "gpt-6-astra", parameters: {} },
    },
    ...overrides,
  };
}
