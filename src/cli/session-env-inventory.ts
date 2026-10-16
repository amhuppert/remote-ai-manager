/**
 * The classification of every `cctl` command that reads the session identity
 * from the agent environment (R2.4, D3).
 *
 * A project conversation's agent receives `CC_CONVERSATION_SCOPE=project` and a
 * neutralized `CC_SESSION=""`, so any command that still demands a session name
 * stops working at project scope. That is only safe when it is a DECISION: this
 * table records, per command, whether the command routes at project scope or is
 * deliberately session-only, and `session-env-inventory.arch.test.ts` fails when
 * a new session-env reader appears without an entry here.
 *
 * "session-only" is a statement about the SERVER surface, not about the CLI: the
 * capability needs a session branch, worktree, or run owner to mean
 * anything, so there is no project-scoped route for the command to select. Those
 * commands fail with the ordinary `no session — pass --session or set
 * CC_SESSION` usage error, which is exactly the loud failure the neutralized
 * env is designed to produce.
 *
 * Entries are keyed by command path and resolved longest-prefix-first. A group
 * and its leaves can differ, so a leaf with a different scope gets its own
 * entry rather than inheriting a capability the server cannot serve.
 */

export type CliScopeSupport = "project-supported" | "session-only";

export interface CliSessionEnvClassification {
  support: CliScopeSupport;
  /** Why — the reason a validator or future author needs, not a restatement. */
  reason: string;
}

export const CLI_SESSION_ENV_INVENTORY: Readonly<
  Record<string, CliSessionEnvClassification>
> = {
  ask: {
    support: "project-supported",
    reason:
      "The custom asynchronous question protocol is the single cross-backend path for both scopes; a project agent must be able to ask.",
  },
  doctor: {
    support: "project-supported",
    reason:
      "Diagnosing the server connection must work at both scopes. The handshake endpoint is scope-agnostic and echoes whatever identity it is given, so a project agent gets a working diagnosis reporting `session=-` rather than losing the command.",
  },
  conversation: {
    support: "project-supported",
    reason:
      "Transcript reads, compaction, and context artifacts are conversation-level and already have project-scoped routes.",
  },
  subscription: {
    support: "project-supported",
    reason:
      "Follows and explicit terminal waits belong to conversations of either scope; both route trees provide registration, inspection and remembered opt-outs.",
  },
  inbox: {
    support: "project-supported",
    reason:
      "Explicit inbox inspection addresses an ordinary session or project conversation without starting a turn.",
  },
  notify: {
    support: "project-supported",
    reason:
      "A push notification identifies the conversation that raised it; the project conversation notifications route serves project scope.",
  },
  ticket: {
    support: "project-supported",
    reason:
      "Tickets are project-level. The session env is read only as attachment provenance, which is absent (null) at project scope rather than empty.",
  },
  validate: {
    support: "project-supported",
    reason:
      "Every validate verb addresses the invoking conversation and has matching session/project route adapters; project conversations validate the canonical project root without inventing a session worktree.",
  },
  run: {
    support: "session-only",
    reason:
      "Launching and steering a supervised run require its session worktree and owner. Read leaves resolve a run globally by id; the context task verbs come from that run's seat conversations.",
  },
  "run show": {
    support: "project-supported",
    reason:
      "A bare run id resolves globally for reads; explicit scope constrains the target.",
  },
  "run definition": {
    support: "project-supported",
    reason:
      "Reading a run's definition does not require its owner's session identity.",
  },
  "run audit": {
    support: "project-supported",
    reason:
      "An auditor reads historical run evidence by id across projects and sessions.",
  },
  "run template": {
    support: "project-supported",
    reason:
      "Saving, listing, reading and deleting run templates address the project's template library (its own tier and the global one) through the project route tree; no session, worktree or run is involved, so a project conversation can author templates.",
  },
  "run template launch": {
    support: "session-only",
    reason:
      "A leaf that differs from its project-supported group: launching starts a run, which places its contexts in a session worktree and belongs to the session conversation that launched it. No project-root run route exists.",
  },
  "run template launch-check": {
    support: "session-only",
    reason:
      "The launch's check twin resolves the same session identity the launch needs, so it fails without a session as the launch does.",
  },
  charter: {
    support: "session-only",
    reason:
      "Alignment governs a bounded session objective and already rejects project conversations (spec non-goal).",
  },
  decisions: {
    support: "session-only",
    reason:
      "Alignment decisions belong to a session charter (spec non-goal, same boundary as `charter`).",
  },
  dev: {
    support: "session-only",
    reason:
      "Managed dev servers are per-session worktree processes; a project conversation must not pretend to own one (spec non-goal).",
  },
  docs: {
    support: "session-only",
    reason:
      "Session reference documents; a project-root document model is a separate approval (spec non-goal).",
  },
  fixture: {
    support: "session-only",
    reason:
      "Drives a session's managed dev server, so it inherits the dev-server boundary.",
  },
};

/**
 * The classification governing a command path, resolved longest-prefix-first so a
 * leaf entry overrides its group. Null when nothing in the inventory covers it —
 * which the arch test turns into a build failure rather than a default.
 */
export function classifyCliCommand(
  commandPath: string,
): CliSessionEnvClassification | null {
  const segments = commandPath.split(" ");
  for (let length = segments.length; length > 0; length--) {
    const entry =
      CLI_SESSION_ENV_INVENTORY[segments.slice(0, length).join(" ")];
    if (entry !== undefined) return entry;
  }
  return null;
}

function commandsWith(support: CliScopeSupport): readonly string[] {
  return Object.entries(CLI_SESSION_ENV_INVENTORY)
    .filter(([, entry]) => entry.support === support)
    .map(([command]) => command)
    .sort();
}

export const PROJECT_SUPPORTED_CLI_COMMANDS: readonly string[] =
  commandsWith("project-supported");

export const SESSION_ONLY_CLI_COMMANDS: readonly string[] =
  commandsWith("session-only");
