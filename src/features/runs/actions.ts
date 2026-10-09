import type { HaltDisposition } from "@/lib/execution-context/schemas";
import type { RemedyChoice } from "./components/HaltCard";
import type { RunDetail } from "./model";

/**
 * The disposition a chosen remedy asks the run to apply. A grant, a rereview
 * and a confirmed effect carry the person's note as their reason or evidence;
 * the form requires it, and the run refuses a disposition without one.
 */
export function dispositionOf(choice: RemedyChoice): HaltDisposition {
  const note = choice.note ?? "";
  const { remedy } = choice;
  switch (remedy.kind) {
    case "grant":
      return {
        kind: "grant",
        allowance: remedy.allowance,
        count: choice.count ?? 1,
        reason: note,
      };
    case "rereview":
      return { kind: "rereview", reason: note };
    case "confirm_effect":
      return { kind: "confirm_effect", evidence: note };
    default:
      return { kind: remedy.kind };
  }
}

/** The started Context a context key names now: what a decision or disposition is addressed to. */
export function invocationIdOf(run: RunDetail, key: string): string {
  const invocationId =
    run.contexts.find((context) => context.key === key)?.invocationId ?? null;
  if (invocationId === null)
    throw new Error(`Context "${key}" has not started`);
  return invocationId;
}
