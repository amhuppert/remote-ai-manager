/**
 * True when keyboard input directed at `target` is text entry the user expects
 * to keep — a form control or a contentEditable surface. Callers use this to
 * suppress page/canvas keyboard shortcuts while the user is typing.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable === true;
}
