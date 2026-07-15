/**
 * Universal types for the workflow visualization specs.
 *
 * Kept separate from machine-specs.ts so that client components and Storybook
 * stories can import the type definitions without dragging in the actual
 * XState machine modules (which depend on Node-only logging/SSE primitives).
 *
 * State ids are dot-qualified for nested states (e.g. "executing.running") to
 * match XState's convention.
 */

export type MachineId = "conversation" | "smart-merge" | "smart-commit";

export type StateNodeKind =
  | "atomic"
  | "compound"
  | "final"
  | "transient"
  | "history";

export type StateStatus =
  | "neutral"
  | "initial"
  | "success"
  | "failure"
  | "warning";

export interface EventInfo {
  /** Event type (e.g. "SUBMIT_PROMPT") or "always" / "onDone" / "onError". */
  event: string;
  /** Dot-qualified target state id, or undefined for internal/self events. */
  target?: string;
  /** Guard expression label, e.g. "isDebugAnalyzing" or "hasRetriesLeft". */
  guard?: string;
  /** Short description of when this event fires. */
  description?: string;
}

export interface StateInfo {
  /** Dot-qualified id, e.g. "executing.running". */
  id: string;
  /** Display label, last segment of id by default. */
  label: string;
  kind: StateNodeKind;
  status?: StateStatus;
  /** Parent compound state id (omit for top-level). */
  parentId?: string;
  description?: string;
  /** Names of `invoke.src` actors active in this state. */
  invokes?: string[];
  /** Entry action names. */
  entryActions?: string[];
  /** Outgoing transitions from this state. */
  events?: EventInfo[];
}

export interface ActorInfo {
  name: string;
  description: string;
}

export interface GuardInfo {
  name: string;
  description: string;
}

export interface ActionInfo {
  name: string;
  description: string;
}

export interface MachineSpec {
  id: MachineId;
  /** Display name, e.g. "Conversation". */
  name: string;
  /** Short XState id from `setup({...}).createMachine({ id })`. */
  machineId: string;
  /** One-word character classification, e.g. "hierarchical". */
  character: string;
  /** Short tagline shown on cards. */
  tagline: string;
  /** Long-form description shown on detail page. */
  description: string;
  /** Path of the machine source file, relative to repo root. */
  filePath: string;
  /** Initial state id at top level. */
  initialState: string;
  states: StateInfo[];
  actors: ActorInfo[];
  guards: GuardInfo[];
  actions: ActionInfo[];
}

export interface MachineStats {
  states: number;
  events: number;
  actors: number;
  guards: number;
  actions: number;
}

const machineIds: ReadonlySet<MachineId> = new Set([
  "conversation",
  "smart-merge",
  "smart-commit",
]);

export function isMachineId(value: string): value is MachineId {
  return (machineIds as ReadonlySet<string>).has(value);
}

export function getMachineStats(spec: MachineSpec): MachineStats {
  const eventTypes = new Set<string>();
  for (const state of spec.states) {
    for (const evt of state.events ?? []) {
      if (
        evt.event !== "always" &&
        evt.event !== "onDone" &&
        evt.event !== "onError"
      ) {
        eventTypes.add(evt.event);
      }
    }
  }
  return {
    states: spec.states.length,
    events: eventTypes.size,
    actors: spec.actors.length,
    guards: spec.guards.length,
    actions: spec.actions.length,
  };
}
