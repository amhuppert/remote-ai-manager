import type {
  ContextProgress,
  ContractInput,
} from "@/lib/execution-context/schemas";
import type { RunFacts, RunProgress } from "./schemas";

/** What the Run last observed of each started context, keyed by definition key. */
export type ObservedContexts = ReadonlyMap<
  string,
  {
    progress: ContextProgress | null;
    output?: unknown;
    /** An effect of the context is admitted and running: it drains through a pause. */
    active: boolean;
  }
>;

/** A context to start now, with the accepted results it builds on. */
export interface ScheduledStart {
  key: string;
  inputs: ContractInput[];
}

function isTerminal(progress: ContextProgress | null): boolean {
  return progress?.kind === "succeeded" || progress?.kind === "cancelled";
}

function succeeded(observed: ObservedContexts, key: string): boolean {
  return observed.get(key)?.progress?.kind === "succeeded";
}

/**
 * The contexts to start now: every unstarted one whose dependencies have all
 * succeeded, each with their accepted outputs in dependency order. Accepted
 * results are visible at once because every context shares the session
 * workspace. Nothing new starts while the run is paused, cancelled or
 * faulted. Pure.
 */
export function decideNext(
  facts: RunFacts,
  observed: ObservedContexts,
): ScheduledStart[] {
  const { paused, cancelled, fault } = facts.control;
  if (paused || cancelled || fault !== null) return [];
  const started = new Set(facts.invocations.map((i) => i.key));
  const titles = new Map(
    facts.definition.contexts.map((c) => [c.key, c.request.contract.title]),
  );
  return facts.definition.contexts
    .filter(
      (context) =>
        !started.has(context.key) &&
        context.dependsOn.every((key) => succeeded(observed, key)),
    )
    .map((context) => ({
      key: context.key,
      inputs: context.dependsOn.map((key) => ({
        key,
        title: titles.get(key) ?? key,
        output: observed.get(key)?.output ?? null,
      })),
    }));
}

/** Why each started context needs its owner, in start order. */
function ownerReasons(facts: RunFacts, observed: ObservedContexts): string[] {
  return facts.invocations.flatMap((invocation) => {
    const progress = observed.get(invocation.key)?.progress ?? null;
    if (progress === null) return [];
    if (progress.kind === "halted")
      return [`${invocation.key}: halted (${progress.halt})`];
    if (progress.kind !== "waiting") return [];
    if (progress.obligation.kind === "await_answer")
      return [`${invocation.key}: question`];
    if (progress.obligation.kind === "await_approval")
      return [`${invocation.key}: approval`];
    return [];
  });
}

/**
 * Run progress from control and the observed contexts. Pure. The run succeeds
 * once every defined context succeeded; it needs its owner only when a
 * context waits on them and no other context can still move.
 */
export function deriveRunProgress(
  facts: RunFacts,
  observed: ObservedContexts,
): RunProgress {
  const started = facts.invocations.map(
    (invocation) => observed.get(invocation.key)?.progress ?? null,
  );
  const active = facts.invocations.some(
    (invocation) => observed.get(invocation.key)?.active === true,
  );
  // Cancellation revokes the permit, so a start no Context took up never will.
  if (facts.control.cancelled)
    return started.every((p) => p === null || isTerminal(p))
      ? { kind: "cancelled" }
      : { kind: "stopping" };
  // Success outranks pause: work that drained during a pause and finished the run is done.
  if (facts.definition.contexts.every((c) => succeeded(observed, c.key)))
    return { kind: "succeeded" };
  if (facts.control.fault !== null)
    return { kind: "needs_owner", reasons: [`run: ${facts.control.fault.detail}`] };
  // The Run's permit stops new effects; the ones already admitted drain.
  if (facts.control.paused) return { kind: "paused", draining: active };
  const reasons = ownerReasons(facts, observed);
  // A started context its host has not created yet is still on its way.
  const moving =
    started.some((p) => p === null || p.kind === "running") ||
    decideNext(facts, observed).length > 0;
  if (reasons.length > 0 && !moving) return { kind: "needs_owner", reasons };
  return { kind: "running" };
}
