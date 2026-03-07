/**
 * Typed helper for creating workflow machine setups with common defaults.
 *
 * Pre-wires base types and stub actions (onTerminal, persistSnapshot,
 * broadcastStatus) so every machine gets them without manual wiring.
 *
 * This is a convenience layer — machines can still use raw setup() if
 * they need full control.
 *
 * Usage:
 *   const s = createWorkflowSetup<MyContext, MyEvent, MyInput, MyOutput>({
 *     actors: { ... },
 *     guards: { ... },
 *     actions: { ... },
 *   });
 *   export const myMachine = s.createMachine({ ... });
 */

import { setup } from "xstate";
import type { EventObject } from "xstate";
import type { BaseWorkflowContext } from "./types";

/**
 * Configuration options for createWorkflowSetup.
 * All fields are optional — defaults are merged in.
 */
interface WorkflowSetupOptions {
  actors?: Record<string, unknown>;
  guards?: Record<string, unknown>;
  actions?: Record<string, unknown>;
}

/**
 * Create a typed XState `setup()` result with common workflow defaults.
 *
 * Default stub actions included:
 * - `onTerminal` — no-op, override via .provide() for notifications/cleanup
 * - `persistSnapshot` — no-op, override via .provide() for snapshot persistence
 * - `broadcastStatus` — no-op, override via .provide() for SSE broadcasting
 *
 * @typeParam TContext - Machine context extending BaseWorkflowContext
 * @typeParam TEvent - Machine events (should include BaseWorkflowEvent's ABORT)
 * @typeParam TInput - Machine input
 * @typeParam TOutput - Machine output
 */
export function createWorkflowSetup<
  TContext extends BaseWorkflowContext,
  TEvent extends EventObject,
  TInput,
  TOutput,
>(options: WorkflowSetupOptions = {}) {
  const defaultActions: Record<string, () => void> = {
    onTerminal: () => {},
    persistSnapshot: () => {},
    broadcastStatus: () => {},
  };

  return setup({
    types: {
      context: {} as TContext,
      events: {} as TEvent,
      input: {} as TInput,
      output: {} as TOutput,
    },
    actors: (options.actors ?? {}) as Record<string, never>,
    guards: (options.guards ?? {}) as Record<string, never>,
    actions: {
      ...defaultActions,
      ...((options.actions ?? {}) as Record<string, never>),
    },
  });
}
