import { describe, expect, it } from "vitest";

import {
  SPEC_ACTIONS,
  SPEC_PROJECT_ACTIONS,
  specMutationPaths,
} from "./mutations";
import { specQueries } from "./queries";
import { specKeys } from "./query-keys";

describe("spec query factories", () => {
  it("nests project lists and spec reads under stable hierarchical keys", () => {
    expect(specKeys.list("demo")).toEqual(["specs", "list", "demo"]);
    expect(specKeys.detail("demo", "native-sdd")).toEqual([
      "specs",
      "detail",
      "demo",
      "native-sdd",
    ]);
    expect(specKeys.status("demo", "native-sdd")).toEqual([
      "specs",
      "detail",
      "demo",
      "native-sdd",
      "status",
    ]);
    expect(specKeys.ticketReadThrough("demo", 12)).toEqual([
      "specs",
      "ticket-read-through",
      "demo",
      12,
    ]);
  });

  it("includes every response-varying parameter in element and search keys", () => {
    expect(specKeys.element("demo", "native-sdd", "R1.2")).not.toEqual(
      specKeys.element("demo", "native-sdd", "R1.3"),
    );
    expect(specKeys.element("demo", "native-sdd", "R1.2", 1)).not.toEqual(
      specKeys.element("demo", "native-sdd", "R1.2", 2),
    );
    expect(specKeys.search("demo", "native-sdd", "route")).not.toEqual(
      specKeys.search("demo", "native-sdd", "identity"),
    );
  });

  it("builds query options from the same key factory", () => {
    expect(specQueries.status("demo", "native-sdd").queryKey).toEqual(
      specKeys.status("demo", "native-sdd"),
    );
    expect(specQueries.search("demo", "native-sdd", "route").queryKey).toEqual(
      specKeys.search("demo", "native-sdd", "route"),
    );
    expect(specQueries.element("demo", "native-sdd", "R1", 3).queryKey).toEqual(
      specKeys.element("demo", "native-sdd", "R1", 3),
    );
    expect(specQueries.ticketReadThrough("demo", 12).queryKey).toEqual(
      specKeys.ticketReadThrough("demo", 12),
    );
  });

  it("exposes project and spec mutation paths for the complete write surface", () => {
    expect(specMutationPaths.projectAction("demo name", "create")).toBe(
      "/api/specs/demo%20name/actions/create",
    );
    expect(
      specMutationPaths.specAction("demo name", "native/sdd", "verify"),
    ).toBe("/api/specs/demo%20name/native%2Fsdd/actions/verify");
    expect(SPEC_PROJECT_ACTIONS).toEqual([
      "create",
      "promote-conversation",
      "graduate-ticket",
    ]);
    expect(SPEC_ACTIONS).toContain("change-policy");
    expect(SPEC_ACTIONS).toContain("grant-waiver");
    expect(SPEC_ACTIONS).toContain("start-execution");
    expect(SPEC_ACTIONS).toContain("materialize-tasks");
  });
});
