import { createHash } from "node:crypto";
import {
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  checkpointSeedBytesAgree,
  type CheckpointPayload,
} from "./schemas";

export function isValidCheckpointForkPayload(
  payload: CheckpointPayload,
): boolean {
  return (
    payload.schemaVersion === CHECKPOINT_PAYLOAD_SCHEMA_VERSION &&
    checkpointSeedBytesAgree(payload) &&
    payload.sectionBytes.total <= 32_768 &&
    createHash("sha256").update(payload.seedText).digest("hex") ===
      payload.seedSha256
  );
}
