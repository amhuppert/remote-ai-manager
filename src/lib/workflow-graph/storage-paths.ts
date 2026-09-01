import path from "node:path";
import type { WorkflowScope } from "./storage";

export const GLOBAL_WORKFLOW_SCOPE_KEY = "global.shared";

export function workflowScopeKey(scope: WorkflowScope): string {
  return scope.kind === "global"
    ? GLOBAL_WORKFLOW_SCOPE_KEY
    : Buffer.from(scope.projectPath).toString("base64url");
}

export function workflowScopeStorageDir(
  configDir: string,
  scope: WorkflowScope,
): string {
  return path.join(configDir, "workflows", workflowScopeKey(scope));
}

export function workflowDefinitionFilePath(
  configDir: string,
  scope: WorkflowScope,
  workflowId: string,
): string {
  return path.join(
    workflowScopeStorageDir(configDir, scope),
    `${workflowId}.json`,
  );
}

export function workflowScopeFromDirName(name: string): WorkflowScope | null {
  if (name === GLOBAL_WORKFLOW_SCOPE_KEY) return { kind: "global" };
  const projectPath = Buffer.from(name, "base64url").toString();
  if (Buffer.from(projectPath).toString("base64url") !== name) return null;
  return { kind: "project", projectPath };
}
