import type { MemoryArtifactRef } from "./schemas";

/**
 * The artifact handle vocabulary — one string form per artifact kind, and its
 * inverse. Pure and dependency-free so every surface that prints or accepts a
 * handle shares it, including client components: the recall service that used
 * to own these reaches the repository and the server logger, which a browser
 * bundle cannot carry.
 */

/**
 * A native artifact as a command argument. Kept to one obvious form per kind
 * so the handle in a rendered narrowing command is the handle the recall verb
 * accepts back.
 */
export function renderMemoryArtifactHandle(
  artifact: MemoryArtifactRef,
): string {
  switch (artifact.kind) {
    case "ticket":
      return `ticket:${artifact.ticketId}`;
    case "spec":
      return `spec:${artifact.specId}`;
    case "workflow_execution":
      return `execution:${artifact.executionId}`;
    case "workflow_context":
      return `context:${artifact.executionId}/${artifact.contextId}`;
    case "session":
      return `session:${artifact.sessionName}@${artifact.sessionCreatedAt}`;
  }
}

/**
 * A ticket handle names its ticket in one of two id spaces: the immutable
 * `tickets.id` a link is stored against, or the per-project display number
 * every human-facing surface prints — including this CLI's own help. Which id
 * space a caller wrote is decidable from the form; WHICH ticket it names is
 * not, because only the repository knows. So the parse stops at the form and
 * the boundary that can reach the repository resolves it.
 *
 * The two live in the type rather than collapsing into one string for a
 * reason: a display number stored as a ticket id is accepted silently and then
 * matches nothing, because the index composer builds its active-artifact ref
 * from `tickets.id`. Making the unresolved form unassignable to
 * `MemoryArtifactRef` is what stops a caller skipping the resolution.
 */
export type MemoryTicketHandleReference =
  | { readonly form: "id"; readonly ticketId: string }
  | {
      readonly form: "number";
      /** The project of `<project>#<number>`; null means the caller's own. */
      readonly projectName: string | null;
      readonly number: number;
    };

/**
 * A parsed handle: settled for every kind whose identity is entirely in the
 * string, and an unresolved reference for the one kind whose is not.
 */
export type ParsedMemoryArtifactHandle =
  | { readonly kind: "artifact"; readonly artifact: MemoryArtifactRef }
  | { readonly kind: "ticket"; readonly ticket: MemoryTicketHandleReference };

/** `<project>#<number>`, a bare display number, or anything else as an id. */
function parseTicketReference(
  rest: string,
): MemoryTicketHandleReference | null {
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    const projectName = rest.slice(0, hash);
    const number = Number(rest.slice(hash + 1));
    if (projectName === "" || !Number.isInteger(number) || number <= 0) {
      return null;
    }
    return { form: "number", projectName, number };
  }
  if (/^[0-9]+$/.test(rest)) {
    const number = Number(rest);
    return number <= 0 ? null : { form: "number", projectName: null, number };
  }
  return { form: "id", ticketId: rest };
}

/**
 * The inverse of `renderMemoryArtifactHandle`: the handle a rendered narrowing
 * command carries, read back into the artifact it names. It lives beside the
 * renderer because the two are one contract — a handle form the reader cannot
 * take back is a command the pack promised but cannot honour.
 *
 * A session incarnation is identified within its project, so `projectPath` is
 * the caller's own scope; without one there is no session a handle could
 * safely name, and the parse fails rather than binding to another project's.
 * Returns null for anything unparseable, so the boundary that received the
 * string authors the refusal in its own vocabulary.
 */
export function parseMemoryArtifactHandle(
  handle: string,
  projectPath: string | null,
): ParsedMemoryArtifactHandle | null {
  const separator = handle.indexOf(":");
  if (separator <= 0) return null;
  const kind = handle.slice(0, separator);
  const rest = handle.slice(separator + 1);
  if (rest === "") return null;

  switch (kind) {
    case "ticket": {
      const ticket = parseTicketReference(rest);
      return ticket === null ? null : { kind: "ticket", ticket };
    }
    case "spec":
      return settled({ kind: "spec", specId: rest });
    case "execution":
      return settled({ kind: "workflow_execution", executionId: rest });
    case "context": {
      const slash = rest.indexOf("/");
      if (slash <= 0 || slash === rest.length - 1) return null;
      return settled({
        kind: "workflow_context",
        executionId: rest.slice(0, slash),
        contextId: rest.slice(slash + 1),
      });
    }
    case "session": {
      if (projectPath === null) return null;
      // An ISO timestamp carries no `@`, so the LAST one is the separator and a
      // session name may contain its own.
      const at = rest.lastIndexOf("@");
      if (at <= 0 || at === rest.length - 1) return null;
      return settled({
        kind: "session",
        projectPath,
        sessionName: rest.slice(0, at),
        sessionCreatedAt: rest.slice(at + 1),
      });
    }
    default:
      return null;
  }
}

function settled(artifact: MemoryArtifactRef): ParsedMemoryArtifactHandle {
  return { kind: "artifact", artifact };
}
