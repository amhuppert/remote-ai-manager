import type { ContextFacts, LedgerTask } from "./schemas";

/** Task commands an implementer may issue during its work. */
export type TaskCommand =
  | { kind: "complete"; taskId: string }
  | { kind: "reopen"; taskId: string }
  | { kind: "add"; taskId: string; title: string; instructions?: string };

export type TaskCommandResult =
  | { kind: "applied"; facts: ContextFacts }
  | { kind: "refused"; reason: string };

export function openTasks(facts: ContextFacts): LedgerTask[] {
  return facts.ledger.tasks.filter((task) => task.status === "open");
}

export function applyTaskCommand(
  facts: ContextFacts,
  command: TaskCommand,
): TaskCommandResult {
  const tasks = facts.ledger.tasks;
  if (command.kind === "add") {
    if (!facts.contract.current.allowTaskAddition) {
      return { kind: "refused", reason: "This context does not allow adding tasks" };
    }
    if (tasks.some((task) => task.id === command.taskId)) {
      return { kind: "refused", reason: `Task ${command.taskId} already exists` };
    }
    const added: LedgerTask = {
      id: command.taskId,
      title: command.title,
      ...(command.instructions !== undefined
        ? { instructions: command.instructions }
        : {}),
      source: "agent",
      status: "open",
    };
    return { kind: "applied", facts: withTasks(facts, [...tasks, added]) };
  }
  const target = tasks.find((task) => task.id === command.taskId);
  if (target === undefined) {
    return { kind: "refused", reason: `Unknown task ${command.taskId}` };
  }
  const status = command.kind === "complete" ? "done" : "open";
  if (target.status === status) return { kind: "applied", facts };
  return {
    kind: "applied",
    facts: withTasks(
      facts,
      tasks.map((task) => (task.id === target.id ? { ...task, status } : task)),
    ),
  };
}

function withTasks(facts: ContextFacts, tasks: LedgerTask[]): ContextFacts {
  return {
    ...facts,
    ledger: { ...facts.ledger, tasks, revision: facts.ledger.revision + 1 },
  };
}
