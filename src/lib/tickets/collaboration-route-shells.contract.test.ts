import { describe, expect, it } from "vitest";
import * as relationshipCollection from "@/app/api/projects/[name]/tickets/[number]/relationships/route";
import * as relationshipItem from "@/app/api/projects/[name]/tickets/[number]/relationships/[relationshipId]/route";
import * as statusUpdateCollection from "@/app/api/projects/[name]/tickets/[number]/status-updates/route";
import * as statusUpdateItem from "@/app/api/projects/[name]/tickets/[number]/status-updates/[updateId]/route";

describe("ticket collaboration route shells", () => {
  it.each([
    ["relationship collection", relationshipCollection, ["GET", "POST"]],
    ["relationship item", relationshipItem, ["DELETE", "GET", "PATCH"]],
    ["status-update collection", statusUpdateCollection, ["GET", "POST"]],
    ["status-update item", statusUpdateItem, ["GET"]],
  ] as const)(
    "exports exactly the supported %s methods",
    (_label, shell, methods) => {
      const exported = shell as Record<string, unknown>;
      expect(Object.keys(exported).sort()).toEqual(methods);
      for (const method of methods) {
        expect(exported[method]).toBeTypeOf("function");
      }
    },
  );
});
