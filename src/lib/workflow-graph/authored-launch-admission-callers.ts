export const AUTHORED_WORKFLOW_LAUNCH_ADMISSION_CALLERS = {
  "project-validate": { documentScopes: ["project"], persists: false },
  "global-template-validate": {
    documentScopes: ["global"],
    persists: false,
  },
  "project-create": { documentScopes: ["project"], persists: true },
  "project-replace": { documentScopes: ["project"], persists: true },
  "project-edit": { documentScopes: ["project"], persists: true },
  "global-template-create": { documentScopes: ["global"], persists: true },
  "global-template-replace": { documentScopes: ["global"], persists: true },
  "global-template-edit": { documentScopes: ["global"], persists: true },
  "spec-proposal": { documentScopes: ["project"], persists: true },
} as const;

export type AuthoredWorkflowLaunchAdmissionCaller =
  keyof typeof AUTHORED_WORKFLOW_LAUNCH_ADMISSION_CALLERS;

/**
 * The only source modules allowed to persist an authored launch draft. The
 * architecture contract derives the actual draft-bearing create/update sites
 * from production source and rejects a source absent from this declaration.
 * Every source listed here must admit the launch through the shared service
 * before writing it.
 */
export const AUTHORED_WORKFLOW_LAUNCH_PERSISTENCE_SOURCES = {
  "src/lib/workflow-graph/template-library-route-handlers.ts": {
    callers: [
      "global-template-create",
      "global-template-replace",
      "global-template-edit",
    ],
    admission: "active",
  },
  "src/lib/workflows/definition-route-handlers.ts": {
    callers: ["project-create", "project-replace", "project-edit"],
    admission: "active",
  },
  "src/lib/specs/delivery-plan-service.ts": {
    callers: ["spec-proposal"],
    admission: "active",
  },
} as const satisfies Record<
  string,
  {
    callers: readonly AuthoredWorkflowLaunchAdmissionCaller[];
    admission: "active" | "reserved";
  }
>;
