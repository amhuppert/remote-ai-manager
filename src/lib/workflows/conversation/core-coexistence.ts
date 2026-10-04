/**
 * What the shared conversation core reuses from the conversation actor while
 * both engines run side by side (design r2 §15): the managed runtime handle,
 * the production collaborators a turn composes, and the checkpoint lifecycle
 * (owned maintenance, the restart rules and the queued-receipt repair) that
 * the core runs for its own conversations. The actor's own modules stay
 * private; this is the one surface the core reaches. Deleted with the actor at
 * cutover, when these move to the core.
 */
export {
  ManagedConversationRuntime,
  type BackendRuntimeIndex,
} from "./runtime-binding";
export { loadProductionActorDependencies as loadConversationTurnDependencies } from "./production";
export {
  captureCheckpointSourceForHost,
  runCheckpointMaintenance,
  type CheckpointMaintenanceHost,
  type CheckpointMaintenanceInfrastructure,
} from "./checkpoint-maintenance";
export { checkpointKeyLogFields, hydrateCheckpointAuthority } from "./checkpoint-restart";
export { repairQueuedAcceptanceFromCheckpoint } from "./checkpoint-queue-repair";
