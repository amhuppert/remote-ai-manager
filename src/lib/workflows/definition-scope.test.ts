import { describe, expect, it } from "vitest";
import {
  workflowDefinitionKeys,
  globalWorkflowTemplateKeys,
} from "./query-keys";
import { workflowDefinitionScopeApi } from "./definition-scope";

describe("workflowDefinitionScopeApi", () => {
  it("maps a project scope to the per-project workflows endpoints and keys", () => {
    const api = workflowDefinitionScopeApi({
      kind: "project",
      projectName: "my-repo",
    });

    expect(api.collectionUrl).toBe("/api/projects/my-repo/workflows");
    expect(api.itemUrl("wf-1")).toBe("/api/projects/my-repo/workflows/wf-1");
    // The project scope reuses the existing definition keys so a builder save
    // invalidates the same cache entries other project surfaces read.
    expect(api.listKey).toEqual(workflowDefinitionKeys.list("my-repo"));
    expect(api.detailKey("wf-1")).toEqual(
      workflowDefinitionKeys.detail("my-repo", "wf-1"),
    );
  });

  it("maps a global scope to the global template endpoints and keys", () => {
    const api = workflowDefinitionScopeApi({ kind: "global" });

    expect(api.collectionUrl).toBe("/api/workflow-templates");
    expect(api.itemUrl("wf-2")).toBe("/api/workflow-templates/wf-2");
    expect(api.listKey).toEqual(globalWorkflowTemplateKeys.list());
    expect(api.detailKey("wf-2")).toEqual(
      globalWorkflowTemplateKeys.detail("wf-2"),
    );
  });

  it("URL-encodes the project name and workflow id", () => {
    const api = workflowDefinitionScopeApi({
      kind: "project",
      projectName: "a/b c",
    });

    expect(api.collectionUrl).toBe("/api/projects/a%2Fb%20c/workflows");
    expect(api.itemUrl("id/with space")).toBe(
      "/api/projects/a%2Fb%20c/workflows/id%2Fwith%20space",
    );
    expect(workflowDefinitionScopeApi({ kind: "global" }).itemUrl("a/b")).toBe(
      "/api/workflow-templates/a%2Fb",
    );
  });
});
