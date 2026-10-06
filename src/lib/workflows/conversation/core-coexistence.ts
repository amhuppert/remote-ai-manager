/**
 * Pure actor primitives the shared conversation core reuses while both
 * engines run side by side (design r2 §15): the managed runtime handle and the
 * checkpoint lifecycle (owned maintenance, the restart rules and the
 * queued-receipt repair). Importing this loads none of the actor's container,
 * which the core's composition modules take from `./core-composition`.
 * At cutover these move to their owning domains (conversation-core, the
 * checkpoint domain) rather than being deleted with the actor.
 */
export {
  ManagedConversationRuntime,
  type BackendRuntimeIndex,
} from "./runtime-binding";
export {
  captureCheckpointSourceForHost,
  runCheckpointMaintenance,
  type CheckpointMaintenanceHost,
  type CheckpointMaintenanceInfrastructure,
} from "./checkpoint-maintenance";
export { checkpointKeyLogFields, hydrateCheckpointAuthority } from "./checkpoint-restart";
export { repairQueuedAcceptanceFromCheckpoint } from "./checkpoint-queue-repair";
