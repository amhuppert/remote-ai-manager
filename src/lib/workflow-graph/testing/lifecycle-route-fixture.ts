import {
  createGraphWorkflowExecutionRouteHandlers,
  type GraphWorkflowExecutionRouteDeps,
} from "../execution-route-handlers";

export function createLifecycleRouteFixture(input: {
  projectName: string;
  sessionName: string;
  deps: GraphWorkflowExecutionRouteDeps;
}) {
  const workflowHandlers = createGraphWorkflowExecutionRouteHandlers(
    input.deps,
  );

  async function postWorkflowRoute(
    handler:
      | "START"
      | "APPROVE_DEFINITION"
      | "STATUS"
      | "EXECUTION"
      | "PAUSE"
      | "ABORT",
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const suffix =
      handler === "APPROVE_DEFINITION"
        ? "/approve-definition"
        : handler === "EXECUTION"
          ? "/execution"
          : handler === "PAUSE"
            ? "/pause"
            : handler === "ABORT"
              ? "/abort"
              : "";
    const isGet = handler === "STATUS" || handler === "EXECUTION";
    const request = new Request(
      `http://cc.test/api/projects/${input.projectName}/sessions/${input.sessionName}/graph-workflow${suffix}`,
      isGet
        ? { method: "GET", headers }
        : {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body ?? {}),
          },
    );
    const context = {
      params: Promise.resolve({
        name: input.projectName,
        session: input.sessionName,
      }),
    };
    return workflowHandlers[handler](request, context);
  }
  return postWorkflowRoute;
}
