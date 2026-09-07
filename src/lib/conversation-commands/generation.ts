import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";
import { commitMessageOutputSchema } from "./schemas";

export interface GenerationContext {
  command: "commit" | "merge";
  hint: string;
  sessionName: string;
  branchName: string;
  /** Merge only; null for standalone commits. */
  targetBranch: string | null;
  /** `git status --porcelain` + `diff --stat`, collected deterministically. */
  changeSummary: string;
}

export type ResolvedGeneratedMessage =
  | { ok: true; message: string; resolutionContext?: string }
  | { ok: false; reason: string };

export function buildGenerationPrompt(ctx: GenerationContext): string {
  const operation =
    ctx.command === "merge"
      ? `a squash merge of branch \`${ctx.branchName}\` into \`${ctx.targetBranch}\``
      : `a commit of all changes on branch \`${ctx.branchName}\` (session \`${ctx.sessionName}\`)`;

  const lines = [
    `Your only task right now is to write the commit message for ${operation}.`,
    "Do not run tools, edit files, or perform any git operations — Command Center handles the git work deterministically.",
    "Use the conversation context and the change summary below to describe the intent of the changes.",
    "",
    "Current changes in the session worktree:",
    "```",
    ctx.changeSummary,
    "```",
  ];

  if (ctx.hint !== "") {
    lines.push("", `User guidance for the message: ${ctx.hint}`);
  }

  lines.push(
    "",
    "Respond with the structured output containing the commit message: a concise summary line, optionally followed by a blank line and a short body.",
  );

  if (ctx.command === "merge") {
    lines.push(
      "",
      `Also fill the \`resolutionContext\` field: notes for an agent that may later resolve merge conflicts between this branch and the target. From the conversation context, summarize what changed and why, the key design decisions, and any invariants a conflict resolver must preserve when reconciling these changes with other work. Refer to the branch by name (\`${ctx.branchName}\`), not "this branch" — the notes are also quoted to future merges as the intent behind an already-merged commit, where "this branch" would misread as the reader's own branch.`,
    );
  }

  return lines.join("\n");
}

export function resolveGeneratedMessage(
  result: TaskRunResult,
): ResolvedGeneratedMessage {
  if (result.kind === "error") {
    const suffix = result.aborted ? " (aborted)" : "";
    return {
      ok: false,
      reason: `generation turn failed${suffix}: ${result.error}`,
    };
  }
  if (result.kind === "text") {
    return {
      ok: false,
      reason: "generation turn returned text instead of structured output",
    };
  }
  const parsed = commitMessageOutputSchema.safeParse(result.structuredOutput);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `structured output did not match the message schema: ${parsed.error.message}`,
    };
  }
  const message = parsed.data.message.trim();
  if (message === "") {
    return { ok: false, reason: "structured output message is empty" };
  }
  const resolutionContext = parsed.data.resolutionContext?.trim();
  return resolutionContext
    ? { ok: true, message, resolutionContext }
    : { ok: true, message };
}

export function defaultMessage(ctx: GenerationContext): string {
  if (ctx.command === "merge") {
    return `Merge ${ctx.branchName} into ${ctx.targetBranch}`;
  }
  return `Changes from session ${ctx.sessionName}`;
}
