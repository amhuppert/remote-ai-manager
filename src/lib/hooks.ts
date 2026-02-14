import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { readState, writeState } from "./state";

/**
 * Shape of the hook event data received from Claude Code hooks.
 * Hooks fire with JSON on stdin, which the hook command can forward
 * to our HTTP endpoint as a POST body.
 */
export interface HookEventData {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
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
  let updated = false;

  // Find the session whose worktreePath matches the hook's cwd
  for (const project of Object.values(state.projects)) {
    for (const session of Object.values(project.sessions)) {
      if (session.worktreePath === cwd) {
        if (session_id) {
          session.claudeSessionId = session_id;
        }
        if (transcript_path) {
          session.transcriptPath = transcript_path;
        }
        session.lastActivityAt = new Date().toISOString();
        updated = true;
        break;
      }
    }
    if (updated) break;
  }

  if (updated) {
    await writeState(state);
  }

  return updated;
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

  try {
    const raw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as {
      hooks?: Record<
        string,
        Array<{ hooks?: Array<{ type?: string; command?: string }> }>
      >;
    };

    const hooks = settings.hooks;
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
