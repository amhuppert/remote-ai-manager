import {
  bareElementHandleSchema,
  formatBareElementHandle,
  type BareElementHandle,
} from "./handles";
import type { SpecRevisionSnapshot } from "./schemas";

/**
 * Renders through the handle module's formatter, so a number the grammar does
 * not admit yields no handle rather than a string the handle parser rejects.
 */
function bareHandle(handle: BareElementHandle): string | null {
  const parsed = bareElementHandleSchema.safeParse(handle);
  return parsed.success ? formatBareElementHandle(parsed.data) : null;
}

/**
 * The one derivation of an element's handle from a revision snapshot — which
 * element gets which number. Returns null when the element has no addressable
 * handle: sections, and rows whose own number (or whose parent requirement's
 * number) was never allocated. Such elements are addressed by their element id
 * instead.
 */
export function elementHandleInSnapshot(
  snapshot: SpecRevisionSnapshot,
  elementId: string,
): string | null {
  const row = snapshot.elements.find(({ element }) => element.id === elementId);
  if (row === undefined) return null;
  const { element } = row;
  if (element.kind === "section" || element.number === null) return null;
  if (element.kind === "criterion") {
    const parent = snapshot.elements.find(
      ({ element: candidate }) => candidate.id === element.parentElementId,
    )?.element;
    return parent === undefined || parent.number === null
      ? null
      : bareHandle({
          kind: "criterion",
          requirementNumber: parent.number,
          criterionNumber: element.number,
        });
  }
  if (element.kind === "requirement") {
    return bareHandle({
      kind: "requirement",
      requirementNumber: element.number,
    });
  }
  if (element.kind === "decision") {
    return bareHandle({ kind: "decision", number: element.number });
  }
  return bareHandle({ kind: "task", number: element.number });
}
