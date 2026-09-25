import { describe, expect, it } from "vitest";
import { deliveryPlanNextAct } from "@/lib/specs/delivery-plan-next-act";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

describe("server-authored spec start continuations", () => {
  it.each(["approved", "parked"] as const)(
    "executes the %s continuation through native input preparation",
    async (status) => {
      const next = deliveryPlanNextAct({
        status,
        specSlug: "native-sdd",
        workflowDefinitionId: "workflow-one",
        builderHref: "/projects/project-one/workflows?definition=workflow-one",
        signOffRequiresHuman: true,
        draftReady: true,
      });
      const fixture = createCcRuntimeFixture({
        files: { ".cc/temp/inputs.json": "{}" },
        respond: () =>
          jsonReply(
            {
              error: "Admission reached",
              code: "gate_blocked",
              instruction: "Review the current candidate.",
            },
            409,
          ),
      });
      const result = await fixture.run(
        next.command.split(" ").slice(1),
        "text",
      );
      expect(result.exitCode).toBe(1);
      expect(fixture.requests).toHaveLength(1);
      expect(new URL(fixture.requests[0]?.url ?? "").pathname).toBe(
        "/api/specs/project-one/native-sdd/edit-context",
      );
      expect(result.stderr).toContain("Admission reached");
    },
  );
});
