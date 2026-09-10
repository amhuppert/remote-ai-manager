import type { ReferenceType } from "@/lib/prompt-editor";

/**
 * One schema-valid XML fixture per registered reference kind, shared by the
 * notepad editor and preview tests. The Record key makes a newly registered
 * kind a compile failure here, and the enumeration tests walk the registry
 * itself — a kind cannot silently fall out of parity.
 */
export const REFERENCE_XML_FIXTURES: Record<ReferenceType, string> = {
  execution:
    '<execution-ref project-name="cc" session-name="capture" execution-id="run-1" title="Delivery" read-command="cctl workflow status run-1 --project cc --session capture" />',
  conversation:
    '<conversation-ref project-name="my-app" project-path="/repos/my-app" scope="session" session-name="main" worktree-path="/repos/my-app/.worktrees/main" conversation-id="conv-123" conversation-name="Refactor parser" backend="claude" backend-ref="claude-sess-abc" debug-log-path="" status="running" last-activity-at="2024-06-01T12:00:00Z" compact-status="none" read-command="cctl conversation read conv-123 --outline" />',
  message:
    '<message-ref project-name="my-app" session-name="main" conversation-id="conv-123" conversation-name="Refactor parser" message-index="5" role="assistant" timestamp="2026-07-06T12:00:00Z" model="opus" compacted="true" compact-artifact-id="art-1" compact-created-at="2026-07-05T10:30:00Z" compaction-command="cctl conversation compaction get conv-123 --message 5 --json" read-command="cctl conversation read conv-123 --message 5" />',
  ticket:
    '<ticket-ref project-name="command-center" ticket-number="12" identifier="command-center#12" title="Add durable ticket context" read-command="cctl ticket get &apos;command-center#12&apos;" />',
  spec: '<spec-ref project-name="command-center" slug="native-sdd" name="Native SDD" revision="3" read-command="cctl spec show &apos;native-sdd&apos; --project &apos;command-center&apos;" />',
  requirement:
    '<requirement-ref project-name="command-center" slug="native-sdd" handle="R5" name="Unified references" revision="3" read-command="cctl spec get &apos;native-sdd/R5&apos; --project &apos;command-center&apos;" />',
  decision:
    '<decision-ref project-name="command-center" slug="native-sdd" handle="D2" name="Immutable revisions" revision="3" read-command="cctl spec get &apos;native-sdd/D2&apos; --project &apos;command-center&apos;" />',
  task: '<task-ref project-name="command-center" slug="native-sdd" handle="T15" name="Unified picker" revision="3" read-command="cctl spec get &apos;native-sdd/T15&apos; --project &apos;command-center&apos;" />',
  question:
    '<question-ref project-name="command-center" slug="native-sdd" handle="Q2" name="Which retention period applies?" revision="3" read-command="cctl spec get &apos;native-sdd/Q2&apos; --project &apos;command-center&apos;" />',
  assumption:
    '<assumption-ref project-name="command-center" slug="native-sdd" handle="A1" name="SQLite remains authoritative" revision="3" read-command="cctl spec get &apos;native-sdd/A1&apos; --project &apos;command-center&apos;" />',
  section:
    '<section-ref project-name="command-center" slug="native-sdd" element-id="sec-intent" name="Intent" revision="3" read-command="cctl spec section get &apos;native-sdd&apos; --id &apos;sec-intent&apos; --project &apos;command-center&apos;" />',
  notepad:
    '<notepad-ref notepad-id="np-7f3a" name="Release checklist" scope="project" project-name="command-center" read-command="cctl notepad get &apos;np-7f3a&apos;" />',
};
