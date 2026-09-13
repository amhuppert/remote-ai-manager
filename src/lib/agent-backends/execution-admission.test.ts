import { describe, expect, it } from "vitest";
import {
  backendExecutionRefusal,
  backendExecutionRefusalIn,
  backendExecutionSchema,
  type ExecutionCatalogEntry,
  type ExecutionRequirements,
} from "./execution-admission";

function limitedEntry(): ExecutionCatalogEntry {
  return {
    id: "cursor",
    label: "Cursor",
    facets: { conversation: true, tasks: true },
    execution: {
      conversation: {
        classes: ["ordinary-conversation"],
        instructionDelivery: "user-message",
        fsWriteRestriction: "unsupported",
      },
      tasks: {
        classes: ["nongoverned-task"],
        instructionDelivery: "user-message",
        fsWriteRestriction: "unsupported",
        profiles: ["isolated-one-shot"],
      },
    },
  };
}

const auxiliary: ExecutionRequirements = {
  facet: "tasks",
  operation: "ticket-enrichment",
  executionClass: "nongoverned-task",
  executionProfile: "isolated-one-shot",
};

describe("backend execution admission", () => {
  it("rejects duplicate and wrong-facet execution classes", () => {
    const execution = limitedEntry().execution;
    execution.conversation!.classes = ["nongoverned-task"];
    expect(backendExecutionSchema.safeParse(execution).success).toBe(false);
    execution.conversation!.classes = [
      "ordinary-conversation",
      "ordinary-conversation",
    ];
    expect(backendExecutionSchema.safeParse(execution).success).toBe(false);
  });

  it("accepts governed tasks with instruction-only filesystem restrictions", () => {
    const execution = limitedEntry().execution;
    const tasks = execution.tasks;
    if (tasks === null) throw new Error("fixture requires a task facet");
    tasks.classes.push("governed-execution");
    const refused = backendExecutionSchema.safeParse(execution);
    expect(refused.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["tasks", "classes"],
        message: expect.stringContaining("filesystem restrictions"),
      }),
    );
    tasks.fsWriteRestriction = "instruction-only";
    expect(backendExecutionSchema.safeParse(execution).success).toBe(true);
  });

  it("admits an instruction-only write policy without claiming mechanical enforcement", () => {
    const entry = limitedEntry();
    const tasks = entry.execution.tasks;
    if (tasks === null) throw new Error("fixture requires a task facet");
    tasks.classes.push("governed-execution");
    tasks.fsWriteRestriction = "instruction-only";
    expect(
      backendExecutionRefusal(entry, {
        ...auxiliary,
        executionClass: "governed-execution",
        requiresFsWriteRestriction: true,
      }),
    ).toBeNull();
    expect(tasks.fsWriteRestriction).not.toBe("enforced");
  });

  it("admits the explicitly supported auxiliary profile", () => {
    expect(backendExecutionRefusal(limitedEntry(), auxiliary)).toBeNull();
  });

  it("does not turn a registered task runner into governed eligibility", () => {
    expect(
      backendExecutionRefusal(limitedEntry(), {
        ...auxiliary,
        operation: "validator",
        executionClass: "governed-execution",
      })?.code,
    ).toBe("backend-role-unsupported");
  });

  it("refuses a profile independently of role admission", () => {
    expect(
      backendExecutionRefusal(limitedEntry(), {
        ...auxiliary,
        executionProfile: "standard",
      })?.code,
    ).toBe("backend-task-profile-unsupported");
  });

  it("refuses the absent facet before inspecting role or profile", () => {
    const entry = limitedEntry();
    entry.facets.tasks = false;
    entry.execution.tasks = null;
    expect(backendExecutionRefusal(entry, auxiliary)).toMatchObject({
      code: "backend-facet-unsupported",
      message: "Cursor does not support task execution.",
    });
  });

  it("does not admit a facet whose execution declaration is missing", () => {
    const entry = limitedEntry();
    entry.execution.tasks = null;
    expect(backendExecutionRefusal(entry, auxiliary)?.code).toBe(
      "backend-facet-unsupported",
    );
  });

  it("checks the actual facet's privileged instruction guarantee", () => {
    const entry = limitedEntry();
    entry.execution.conversation!.classes.push("governed-execution");
    expect(
      backendExecutionRefusal(entry, {
        facet: "conversation",
        operation: "governed-turn",
        executionClass: "governed-execution",
        requiresPrivilegedInstructions: true,
      })?.code,
    ).toBe("backend-instructions-unsupported");
  });

  it("refuses filesystem requirements when the backend cannot deliver the policy", () => {
    expect(
      backendExecutionRefusal(limitedEntry(), {
        ...auxiliary,
        requiresFsWriteRestriction: true,
      })?.code,
    ).toBe("backend-fs-policy-unsupported");
  });

  it("does not infer a governed grant from technical capabilities", () => {
    const entry = limitedEntry();
    entry.execution.tasks!.instructionDelivery = "privileged";
    entry.execution.tasks!.fsWriteRestriction = "enforced";
    expect(
      backendExecutionRefusal(entry, {
        ...auxiliary,
        executionClass: "governed-execution",
      })?.code,
    ).toBe("backend-role-unsupported");
  });

  it("makes the same decision after changing only the provider identity", () => {
    const entry = limitedEntry();
    entry.id = "claude";
    entry.label = "Claude";
    expect(
      backendExecutionRefusal(entry, {
        ...auxiliary,
        executionClass: "governed-execution",
      })?.code,
    ).toBe("backend-role-unsupported");
  });

  it("does not fall back to static availability when the live catalog omits a backend", () => {
    expect(backendExecutionRefusalIn([], "claude", auxiliary)?.code).toBe(
      "backend-catalog-unavailable",
    );
  });
});
