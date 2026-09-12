import { z } from "zod";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import { ccTaskSessionScopeSchema } from "../task";
import { assertRefOwnedBy } from "../continuity";
import { CursorLocalFailure } from "./failure-classifier";

export const cursorTaskRefSchema = z.object({
  taskId: z.uuid(),
  agentId: z.string().min(1).nullable(),
  cwd: z.string().min(1),
  scope: ccTaskSessionScopeSchema.nullable(),
});

export function decodeCursorTaskRef(ref: AgentSessionRef) {
  assertRefOwnedBy("cursor", ref);
  try {
    const decoded = cursorTaskRefSchema.parse(JSON.parse(ref.ref));
    if (decoded.agentId === null) throw new Error("missing agent id");
    return decoded;
  } catch {
    throw new CursorLocalFailure(
      "invalid_ref",
      "The Cursor task continuation is corrupt",
    );
  }
}

export function encodeCursorTaskRef(
  value: z.infer<typeof cursorTaskRefSchema>,
): AgentSessionRef {
  return {
    backend: "cursor",
    ref: JSON.stringify(cursorTaskRefSchema.parse(value)),
  };
}
