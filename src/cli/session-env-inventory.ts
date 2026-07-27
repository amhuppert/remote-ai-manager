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
 * capability needs a session branch, worktree, or graph execution to mean
 * anything, so there is no project-scoped route for the command to select. Those
 * commands fail with the ordinary `no session — pass --session or set
 * CC_SESSION` usage error, which is exactly the loud failure the neutralized
 * env is designed to produce.
 *
 * Entries are keyed by COMMAND PATH and resolved longest-prefix-first, because a
 * group and its leaves can differ: `spec` authoring is project-scoped, but
 * `spec start` pins a graph execution to a session and must be refused. A
 * group-level classification that swallowed such a leaf would advertise a
 * capability that dead-ends server-side, which is the failure mode R2.4 exists to
 * prevent — so a leaf that differs from its group gets its own entry.
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
  notify: {
    support: "project-supported",
    reason:
      "A push notification identifies the conversation that raised it; the project conversation notifications route serves project scope.",
  },
  spec: {
    support: "project-supported",
    reason:
      "Spec authoring endpoints are project-scoped already — the session identity was incidental coupling, and a PLC agent authors specs today.",
  },
  "spec start": {
    support: "session-only",
    reason:
      "Starting an execution pins it to a session; approveExecutionStart refuses an execution whose session is null, so a project-scope start would persist an unapprovable execution. Graph workflow execution is session-only by decision.",
  },
  ticket: {
    support: "project-supported",
    reason:
      "Tickets are project-level. The session env is read only as attachment provenance, which is absent (null) at project scope rather than empty.",
  },
  agent: {
    support: "session-only",
    reason:
      "Agent runs are recorded against a session and execute in its worktree; no project-root agent-run route exists. Revisit if project-scoped sub-agents are approved.",
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
  // The `workflow` group splits: DEFINITION authoring resolves project context
  // only and works at project scope today, while EXECUTION and lane operations
  // pin to a session. Classifying the whole group session-only would have taken
  // working commands away from project agents, which is exactly what R2.4's
  // "migrate in the same change" clause exists to prevent. The group default is
  // session-only so a NEW subcommand fails loudly rather than being silently
  // advertised; each project-supported verb is listed explicitly.
  workflow: {
    support: "session-only",
    reason:
      "Group default. Graph workflow execution, approvals, and lane operations at project scope are explicitly out of scope (spec non-goal); the definition-authoring verbs below opt back in.",
  },
  "workflow create": {
    support: "project-supported",
    reason:
      "Authors a workflow definition against project context only (resolveProjectContext); no session, worktree, or execution is involved.",
  },
  "workflow replace": {
    support: "project-supported",
    reason:
      "Replaces a stored workflow definition through project context only — the same project-scoped definition store `create` writes.",
  },
  "workflow list": {
    support: "project-supported",
    reason:
      "Lists the project's workflow definitions through project context only; a session identity was never consulted.",
  },
  "workflow get": {
    support: "project-supported",
    reason:
      "Reads a stored workflow definition (and its context/task/charter/config/params views) through project context only.",
  },
  "workflow edit": {
    support: "project-supported",
    reason:
      "Edits a stored workflow definition through project context only; live execution editing is `workflow live edit`, which stays session-only.",
  },
  "workflow delete": {
    support: "project-supported",
    reason:
      "Deletes a stored workflow definition through project context only; it removes a definition, not a running execution.",
  },
  "workflow templates": {
    support: "project-supported",
    reason:
      "Lists the project's workflow templates through project context only; templates are project-level assets.",
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
