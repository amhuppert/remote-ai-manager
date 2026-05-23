/**
 * XState v5 machine introspection — auto-derives the structural fields a
 * visualization needs (states, transitions, invokes, action names) from the
 * actual `setup({...}).createMachine({...})` definition. Pairs with hand-typed
 * metadata (descriptions, status hints, character) in `machine-specs.ts` so
 * those don't drift from the live machine.
 *
 * Walks `machine.config` (the raw createMachine config) and
 * `machine.implementations` (the registered actor/guard/action names). Pure;
 * no Node deps.
 */

import type { AnyStateMachine } from "xstate";
import type { StateNodeKind } from "./machine-spec-types";

// ============================================================
// Output types
// ============================================================

interface IntrospectedEvent {
  event: string;
  target?: string;
  guard?: string;
}

export interface IntrospectedState {
  id: string;
  label: string;
  kind: StateNodeKind;
  parentId?: string;
  invokes: string[];
  entryActions: string[];
  events: IntrospectedEvent[];
}

export interface IntrospectedMachine {
  machineId: string;
  initialState: string;
  states: IntrospectedState[];
  actors: string[];
  guards: string[];
  actions: string[];
}

// ============================================================
// Public API
// ============================================================

export function introspectMachine(
  machine: AnyStateMachine,
): IntrospectedMachine {
  const config = (machine as unknown as { config: RawStateConfig }).config;
  const impl = (machine as unknown as { implementations: Implementations })
    .implementations;

  const machineId = typeof config.id === "string" ? config.id : "";
  const initialState = extractInitial(config);
  const states: IntrospectedState[] = [];
  walk(states, "", config.states ?? {}, undefined);

  return {
    machineId,
    initialState,
    states,
    actors: Object.keys(impl?.actors ?? {}).sort(),
    guards: Object.keys(impl?.guards ?? {}).sort(),
    actions: Object.keys(impl?.actions ?? {}).sort(),
  };
}

// ============================================================
// Internals
// ============================================================

interface Implementations {
  actors?: Record<string, unknown>;
  guards?: Record<string, unknown>;
  actions?: Record<string, unknown>;
}

interface RawTransition {
  target?: string | string[];
  guard?: unknown;
  actions?: unknown;
}

interface RawInvoke {
  src?: unknown;
  onDone?: RawTransition | RawTransition[] | string;
  onError?: RawTransition | RawTransition[] | string;
}

interface RawStateConfig {
  id?: string;
  type?: "atomic" | "compound" | "parallel" | "final" | "history";
  initial?: string | { target: string };
  states?: Record<string, RawStateConfig>;
  invoke?: RawInvoke | RawInvoke[];
  on?: Record<string, RawTransition | RawTransition[] | string>;
  always?: RawTransition | RawTransition[] | string;
  entry?: unknown;
  exit?: unknown;
}

function extractInitial(config: RawStateConfig): string {
  if (typeof config.initial === "string") return config.initial;
  if (
    config.initial != null &&
    typeof config.initial === "object" &&
    "target" in config.initial
  ) {
    return (config.initial as { target: string }).target;
  }
  return "";
}

function walk(
  out: IntrospectedState[],
  prefix: string,
  states: Record<string, RawStateConfig>,
  parentId: string | undefined,
): void {
  for (const [key, node] of Object.entries(states)) {
    const id = prefix ? `${prefix}.${key}` : key;
    const kind = classifyState(node);

    out.push({
      id,
      label: key,
      kind,
      parentId,
      invokes: extractInvokes(node),
      entryActions: extractActionNames(node.entry),
      events: extractEvents(node, parentId),
    });

    if (node.states) {
      walk(out, id, node.states, id);
    }
  }
}

function classifyState(node: RawStateConfig): StateNodeKind {
  if (node.type === "final") return "final";
  if (node.type === "history") return "history";
  if (node.states && Object.keys(node.states).length > 0) return "compound";
  // A transient state has only `always` transitions and no other event handlers.
  const hasAlways = node.always !== undefined;
  const hasOn = node.on && Object.keys(node.on).length > 0;
  const hasInvoke = node.invoke !== undefined;
  if (hasAlways && !hasOn && !hasInvoke) return "transient";
  return "atomic";
}

function extractInvokes(node: RawStateConfig): string[] {
  if (!node.invoke) return [];
  const invokes = Array.isArray(node.invoke) ? node.invoke : [node.invoke];
  const names: string[] = [];
  for (const inv of invokes) {
    if (typeof inv.src === "string") names.push(inv.src);
  }
  return names;
}

function extractEvents(
  node: RawStateConfig,
  parentId: string | undefined,
): IntrospectedEvent[] {
  const events: IntrospectedEvent[] = [];

  // always: [...] — eventless transitions
  if (node.always !== undefined) {
    for (const tr of normalizeTransitions(node.always)) {
      events.push(buildEvent("always", tr, parentId));
    }
  }

  // invoke.onDone / invoke.onError
  if (node.invoke) {
    const invokes = Array.isArray(node.invoke) ? node.invoke : [node.invoke];
    for (const inv of invokes) {
      for (const evt of ["onDone", "onError"] as const) {
        const transitions = inv[evt];
        if (transitions === undefined) continue;
        for (const tr of normalizeTransitions(transitions)) {
          events.push(buildEvent(evt, tr, parentId));
        }
      }
    }
  }

  // on: { EVENT: ... }
  if (node.on) {
    for (const [eventName, raw] of Object.entries(node.on)) {
      for (const tr of normalizeTransitions(raw)) {
        events.push(buildEvent(eventName, tr, parentId));
      }
    }
  }

  return events;
}

function normalizeTransitions(
  raw: RawTransition | RawTransition[] | string,
): RawTransition[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") return [{ target: raw }];
  if (Array.isArray(raw)) {
    return raw.map((t) => (typeof t === "string" ? { target: t } : t));
  }
  return [raw];
}

function buildEvent(
  eventName: string,
  tr: RawTransition,
  parentId: string | undefined,
): IntrospectedEvent {
  const target = resolveTarget(tr.target, parentId);
  const guard = extractGuardLabel(tr.guard);
  const event: IntrospectedEvent = { event: eventName };
  if (target !== undefined) event.target = target;
  if (guard !== undefined) event.guard = guard;
  return event;
}

function resolveTarget(
  target: string | string[] | undefined,
  parentId: string | undefined,
): string | undefined {
  if (target === undefined) return undefined;
  const single = Array.isArray(target) ? target[0] : target;
  if (typeof single !== "string" || single.length === 0) return undefined;

  // Absolute target: "#machineId.path.to.state" — strip the machine id.
  if (single.startsWith("#")) {
    const parts = single.slice(1).split(".");
    return parts.slice(1).join(".");
  }

  // Sibling target: resolves against the current state's parent compound.
  if (parentId) return `${parentId}.${single}`;
  return single;
}

function extractGuardLabel(guard: unknown): string | undefined {
  if (guard === undefined || guard === null) return undefined;
  if (typeof guard === "string") return guard;

  if (typeof guard === "function") {
    const fn = guard as { name?: string; guards?: unknown[] };
    if (Array.isArray(fn.guards)) {
      const children = fn.guards
        .map((g) => extractGuardLabel(g))
        .filter((s): s is string => typeof s === "string");
      if (fn.name === "and") return children.join(" && ");
      if (fn.name === "or") return children.join(" || ");
      if (fn.name === "not") return `!${children[0] ?? ""}`;
    }
    if (fn.name && fn.name.length > 0) return fn.name;
    return "<inline>";
  }

  if (typeof guard === "object" && guard !== null) {
    const obj = guard as { type?: unknown };
    if (typeof obj.type === "string") return obj.type;
  }

  return undefined;
}

function extractActionNames(actions: unknown): string[] {
  if (actions === undefined || actions === null) return [];
  const arr = Array.isArray(actions) ? actions : [actions];
  const names: string[] = [];
  for (const a of arr) {
    const name = extractActionName(a);
    if (name !== undefined) names.push(name);
  }
  return names;
}

function extractActionName(action: unknown): string | undefined {
  if (typeof action === "string") return action;
  if (typeof action === "object" && action !== null) {
    const obj = action as { type?: unknown };
    if (typeof obj.type === "string") {
      // Skip framework-internal actions like "xstate.assign".
      if (obj.type.startsWith("xstate.")) return undefined;
      return obj.type;
    }
  }
  return undefined;
}
