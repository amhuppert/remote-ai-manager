/**
 * Putting the call ledger in front of every provider call the probe causes
 * indirectly.
 *
 * Ordinary turns are the probe's own calls, so it admits them itself. The
 * compaction calls are not: a checkpoint's envelope fold, its working-state
 * pass and any repair are made inside production code, and how many of them a
 * given checkpoint needs is a property of the conversation rather than of the
 * probe. Counting them afterwards from a receipt cannot stop a run from
 * spending past its ceiling.
 *
 * Every one of those calls reaches the provider through the registered
 * backend's task runner, so wrapping that runner is the one place where a
 * guard sees them all — folds, repairs and seed passes alike — before the
 * money is spent, and where each pass's own measured cost is available rather
 * than an aggregate attributed to the first pass.
 */

import {
  _registerBackendForTesting,
  _resetBackendRegistryForTesting,
  listBackends,
} from "@/lib/agent-backends/registry-core";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";

import type { ProbeCallLedger } from "./budget";

/**
 * The same runner, with the probe's budget enforced ahead of each run.
 *
 * A run that throws stays counted: the call was made, so the ceiling has to
 * treat it as spent.
 */
export function guardTaskRunner(
  runner: AgentTaskRunner,
  ledger: ProbeCallLedger,
): AgentTaskRunner {
  return {
    backend: runner.backend,
    async run(input) {
      const token = ledger.admit(
        "compaction",
        `task_run:${runner.backend}`,
        runner.backend,
      );
      const result = await runner.run(input);
      ledger.settle(token, { costUsd: result.usage?.costUsd ?? null });
      return result;
    },
  };
}

/**
 * Re-register every backend that declares a task facet behind the guard.
 *
 * Registration is how the probe reaches the real adapters in its isolated
 * harness; the descriptor is otherwise untouched, so the provider path this
 * run certifies is the shipped one.
 */
export function instrumentTaskRunnersForProbe(ledger: ProbeCallLedger): void {
  // The registry refuses to re-register a backend, so the whole set is
  // re-registered in its existing order: a descriptor without a task facet is
  // put back untouched, and the rest come back with the guard in front of the
  // runner. Only the top level is copied, so the conversation facet each
  // descriptor exposes stays the same object the catalog hands out.
  const descriptors = [...listBackends()];
  _resetBackendRegistryForTesting();
  for (const descriptor of descriptors) {
    const tasks = descriptor.tasks;
    _registerBackendForTesting(
      tasks
        ? {
            ...descriptor,
            tasks: { ...tasks, runner: guardTaskRunner(tasks.runner, ledger) },
          }
        : descriptor,
    );
  }
}
