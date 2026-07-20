import { conversationReadCommands } from "./attachment-commands";
import type { QuickTicketBundleKey, QuickTicketDiagnostics } from "./schemas";

export interface QuickTicketDiagnosticEnvironment {
  sha: string;
  buildTime: string;
  appVersion: string;
  platform: string;
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "ˋ").replaceAll("\n", " ")}\``;
}

function appendSection(
  sections: string[],
  heading: string,
  lines: readonly string[],
): void {
  sections.push(`## ${heading}\n\n${lines.join("\n")}`);
}

function hasRemoved(
  removed: ReadonlySet<QuickTicketBundleKey>,
  key: QuickTicketBundleKey,
): boolean {
  return removed.has(key);
}

export function composeQuickTicketDiagnosticReport(
  diagnostics: QuickTicketDiagnostics,
  environment: QuickTicketDiagnosticEnvironment,
): string | null {
  const removed = new Set(diagnostics.removed);
  const sections: string[] = [];

  if (!hasRemoved(removed, "route")) {
    appendSection(sections, "Route + view state", [
      `- Captured at: ${inlineCode(diagnostics.capturedAt)}`,
      `- URL: ${inlineCode(diagnostics.route.url)}`,
      `- View state: ${inlineCode(diagnostics.route.viewState)}`,
    ]);
  }

  if (!hasRemoved(removed, "identities")) {
    const identityLines: string[] = [];
    const identities = diagnostics.identities;
    if (identities.projectName !== undefined) {
      identityLines.push(`- Project: ${inlineCode(identities.projectName)}`);
    }
    if (identities.sessionName !== undefined) {
      identityLines.push(`- Session: ${inlineCode(identities.sessionName)}`);
    }
    if (identities.conversationId !== undefined) {
      identityLines.push(
        `- Conversation: ${inlineCode(identities.conversationId)}`,
      );
    }
    if (identities.workflowExecutionId !== undefined) {
      identityLines.push(
        `- Workflow execution: ${inlineCode(identities.workflowExecutionId)}`,
      );
    }
    for (const link of identities.deepLinks) {
      identityLines.push(`- ${link.label}: ${inlineCode(link.href)}`);
    }
    if (identityLines.length > 0) {
      appendSection(
        sections,
        "Observed identities + deep links",
        identityLines,
      );
    }
  }

  if (!hasRemoved(removed, "build")) {
    appendSection(sections, "Server build + environment", [
      `- Git SHA: ${inlineCode(environment.sha)}`,
      `- Build time: ${inlineCode(environment.buildTime)}`,
      `- App version: ${inlineCode(environment.appVersion)}`,
      `- Platform: ${inlineCode(environment.platform)}`,
    ]);
  }

  const conversationId = diagnostics.identities.conversationId;
  const projectName = diagnostics.identities.projectName;
  if (
    !hasRemoved(removed, "cctl") &&
    conversationId !== undefined &&
    projectName !== undefined
  ) {
    const [compactionCommand, outlineCommand] = conversationReadCommands(
      conversationId,
      {
        projectName,
        sessionName: diagnostics.identities.sessionName ?? null,
      },
    );
    if (compactionCommand !== undefined && outlineCommand !== undefined) {
      appendSection(sections, "cctl crib", [
        "```sh",
        outlineCommand,
        `${compactionCommand} --format markdown`,
        "```",
        "For request and runtime traces, load the `debug-logs` skill and follow its scoped-log guidance.",
      ]);
    }
  }

  if (
    !hasRemoved(removed, "clientErrors") &&
    diagnostics.clientErrors.length > 0
  ) {
    const errorLines = diagnostics.clientErrors.flatMap((error) => [
      `- ${inlineCode(error.ts)} ${inlineCode(error.kind)} — ${error.message}`,
      ...error.stackHead.map((frame) => `  - ${inlineCode(frame)}`),
    ]);
    appendSection(sections, "Recent client errors", errorLines);
  }

  if (sections.length === 0) return null;
  return `# Command Center diagnostic report\n\n${sections.join("\n\n")}`;
}
