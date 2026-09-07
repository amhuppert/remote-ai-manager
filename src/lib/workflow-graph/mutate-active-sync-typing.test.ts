import type { GraphWorkflowExecution } from "./schemas";
import { changed } from "@/lib/workflow-graph/execution-mutation";
/**
 * Compile-time contract for `mutateActive`'s reducer (Design 3.1,
 * `no-slow-work-in-critical-section`). The reducer runs inside the global write
 * queue, so it MUST be synchronous and pure — no I/O, no awaits, nothing that
 * can block. The type system makes "await an LLM / git / registry while holding
 * the global lock" unrepresentable at this seam: a Promise-returning (async)
 * reducer must fail to compile.
 *
 * The `@ts-expect-error` below is the ratchet. If the reducer type ever
 * re-widens to accept `Promise<...>`, the async reducer becomes valid, the
 * directive turns into an unused `@ts-expect-error`, and `bun run typecheck`
 * fails — catching the regression. Slow callers use the caller-specific staged
 * reserve/finalize protocols, never an async reducer.
 */

import { it, expect } from "vitest";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";

type ExecutionRepository = ReturnType<
  typeof createGraphWorkflowExecutionRepository
>;

// Never invoked — its body exists only to be typechecked. Invoking it would
// dereference the `declare`d repo at runtime; keeping it uncalled lets the type
// fixture assert on the signature without executing anything.
function __mutateActiveReducerTypeFixture__(repo: ExecutionRepository): void {
  // A synchronous reducer that returns the next execution compiles.
  void repo
    .mutateActive("/project", "session", (execution) => changed(execution))
    .then((mutation) => mutation.execution);

  // A synchronous reducer may pair changed state with inert delivery data.
  void repo
    .mutateActive("/project", "session", (execution) =>
      changed(execution, undefined, { events: [], pushes: [] }),
    )
    .then((mutation) => mutation.execution);

  const asyncReducer = async (execution: GraphWorkflowExecution) =>
    changed(execution);
  // The reducer cannot await external work under the lock.
  // @ts-expect-error — Promise-returning reducers are rejected.
  void repo.mutateActive("p", "s", asyncReducer);

  const deliveryOnNoop = () => ({
    kind: "unchanged" as const,
    value: undefined,
    delivery: { events: [], pushes: [] },
  });
  // @ts-expect-error — no-commit decisions cannot carry delivery.
  void repo.mutateActive("p", "s", deliveryOnNoop);

  const bareExecution = (execution: GraphWorkflowExecution) => execution;
  // @ts-expect-error — every reducer must decide whether to commit.
  void repo.mutateActive("p", "s", bareExecution);
}

it("mutateActive's reducer is typed synchronous (compile-time fixture)", () => {
  // The assertion is the successful compile above; this keeps vitest happy and
  // pins the fixture module in the type-checked graph without running its body.
  expect(typeof __mutateActiveReducerTypeFixture__).toBe("function");
});
