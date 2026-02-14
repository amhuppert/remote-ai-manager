import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { readState, writeState } from "./state";
import type { HookEventData } from "./schemas";
import type { ManagerState, SessionState } from "@/types";

/** Find the session whose worktreePath matches the given cwd */
function findSessionByCwd(
  state: ManagerState,
  cwd: string,
): SessionState | null {
  for (const project of Object.values(state.projects)) {
    for (const session of Object.values(project.sessions)) {
      if (session.worktreePath === cwd) return session;
    }
  }
  return null;
}

/**
 * Process a hook event from Claude Code.
 *
 * 1. Parse the event data
 * 2. Match `cwd` to a session whose `worktreePath` matches
 * 3. Update the session's claudeSessionId and transcriptPath
 * 4. Save state
 *
 * Returns true if a matching session was found and updated.
 */
export async function processHookEvent(data: HookEventData): Promise<boolean> {
  const { session_id, transcript_path, cwd } = data;

  // cwd is required to match against managed sessions
  if (!cwd) return false;

  const state = await readState();
  const session = findSessionByCwd(state, cwd);

  if (!session) return false;

  if (session_id) session.claudeSessionId = session_id;
  if (transcript_path) session.transcriptPath = transcript_path;
  session.lastActivityAt = new Date().toISOString();

  await writeState(state);
  return true;
}

/**
 * Check whether Claude Code hooks are configured to forward events to CSM.
 *
 * Reads ~/.claude/settings.json and checks for UserPromptSubmit and Stop
 * hooks that reference "csm" in their command.
 */
export async function detectHooksStatus(): Promise<{
  installed: boolean;
  hasUserPromptSubmit: boolean;
  hasStop: boolean;
}> {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");

  if (!existsSync(settingsPath)) {
    return { installed: false, hasUserPromptSubmit: false, hasStop: false };
  }

  const claudeSettingsSchema = z.object({
    hooks: z
      .record(
        z.string(),
        z.array(
          z.object({
            hooks: z
              .array(
                z.object({
                  type: z.string().optional(),
                  command: z.string().optional(),
                }),
              )
              .optional(),
          }),
        ),
      )
      .optional(),
  });

  try {
    const raw = await readFile(settingsPath, "utf-8");
    const result = claudeSettingsSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      return { installed: false, hasUserPromptSubmit: false, hasStop: false };
    }

    const hooks = result.data.hooks;
    if (!hooks) {
      return { installed: false, hasUserPromptSubmit: false, hasStop: false };
    }

    const hasUserPromptSubmit = checkHookEvent(hooks, "UserPromptSubmit");
    const hasStop = checkHookEvent(hooks, "Stop");

    return {
      installed: hasUserPromptSubmit && hasStop,
      hasUserPromptSubmit,
      hasStop,
    };
  } catch {
    // Config file missing or unreadable — treat hooks as not installed
    return { installed: false, hasUserPromptSubmit: false, hasStop: false };
  }
}

/** Check if a specific hook event has a CSM-related command configured */
function checkHookEvent(
  hooks: Record<
    string,
    Array<{ hooks?: Array<{ type?: string; command?: string }> }>
  >,
  eventName: string,
): boolean {
  const eventHooks = hooks[eventName];
  if (!Array.isArray(eventHooks)) return false;

  return eventHooks.some((entry) =>
    entry.hooks?.some(
      (hook) =>
        hook.type === "command" &&
        typeof hook.command === "string" &&
        hook.command.includes("csm"),
    ),
  );
}
