import { describe, expect, it } from "vitest";
import { getBackendCatalogEntry } from "@/lib/agent-backends/catalog";
import {
  commandAvailability,
  applyCommandAvailability,
} from "./command-availability";
import { BUILT_IN_COMMANDS } from "./built-in-commands";

describe("built-in command execution availability", () => {
  const cursor = getBackendCatalogEntry("cursor");
  it.each(["/ticket", "/collab"])(
    "refuses %s when its task dependency is absent",
    (command) => {
      expect(commandAvailability(cursor, command)).toMatchObject({
        status: "unavailable",
        refusal: { code: "backend-facet-unsupported" },
      });
    },
  );
  it.each(["/align", "/spec"])(
    "preserves ordinary conversation authoring through %s",
    (command) => {
      expect(commandAvailability(cursor, command)).toEqual({
        status: "available",
      });
    },
  );
  it.each(["/commit", "/merge", "/rebase"])(
    "preserves deterministic %s while disclosing unavailable stages",
    (command) => {
      expect(commandAvailability(cursor, command)).toMatchObject({
        status: "degraded",
      });
    },
  );
  it("distinguishes message fallback from governed automatic repair", () => {
    const entry = structuredClone(cursor);
    entry.facets.tasks = true;
    entry.execution.tasks = {
      classes: ["nongoverned-task"],
      instructionDelivery: "user-message",
      fsWriteRestriction: "unsupported",
      profiles: ["standard", "isolated-one-shot"],
    };
    expect(commandAvailability(entry, "/ticket")).toEqual({
      status: "available",
    });
    expect(commandAvailability(entry, "/commit")).toMatchObject({
      status: "degraded",
      stages: [
        {
          stage: "validation-repair",
          refusal: { code: "backend-role-unsupported" },
        },
      ],
    });
  });
  it("discloses unavailable isolated repair before offering message generation", () => {
    const entry = structuredClone(getBackendCatalogEntry("claude"));
    entry.execution.tasks!.profiles = ["standard"];
    for (const command of ["/commit", "/merge"]) {
      expect(commandAvailability(entry, command)).toMatchObject({
        status: "degraded",
        stages: [
          {
            stage: "message-generation",
            refusal: { code: "backend-task-profile-unsupported" },
          },
        ],
      });
    }
  });
  it("applies reserved-name admission after discovery and fails closed without a live entry", () => {
    const item = {
      ...BUILT_IN_COMMANDS.find((item) => item.name === "/ticket")!,
      source: "project" as const,
    };
    expect(
      applyCommandAvailability([item], [cursor], "cursor")[0]?.availability,
    ).toMatchObject({
      status: "unavailable",
      refusal: { code: "backend-facet-unsupported" },
    });
    expect(
      applyCommandAvailability([item], [], "claude")[0]?.availability,
    ).toMatchObject({
      status: "unavailable",
      refusal: { code: "backend-catalog-unavailable" },
    });
  });
  it.each(["claude", "codex"] as const)(
    "preserves the supported %s command matrix",
    (backend) => {
      for (const command of BUILT_IN_COMMANDS)
        expect(
          commandAvailability(getBackendCatalogEntry(backend), command.name),
        ).toEqual({ status: "available" });
    },
  );
});
