import { describe, expect, it } from "vitest";

import { GET as projectSearchGET } from "@/app/api/specs/[name]/-/search/route";
import { GET as inventoryGET } from "@/app/api/specs/[name]/route";
import { GET as editContextGET } from "@/app/api/specs/[name]/[slug]/edit-context/route";
import {
  specEditContextGET,
  specProjectSearchGET,
  specsInventoryGET,
} from "@/lib/specs/route-handlers";

/**
 * A handler that is exported, tested and reachable through a hand-built router
 * is still dead in the running app until a route file mounts it. These pin the
 * mount itself: a missing file fails at import, and a mount wired to the wrong
 * handler fails on identity.
 */
describe("spec API route mounting", () => {
  // Project-scoped reads live under the `-` segment because a bare static
  // sibling of [slug] would shadow a spec whose slug is that same word, and
  // `-` cannot be a slug (CANONICAL_SLUG requires alphanumeric edges).
  it("mounts project-wide search, which the CLI reaches at /api/specs/<project>/-/search", () => {
    expect(projectSearchGET).toBe(specProjectSearchGET);
  });

  it("mounts the project inventory", () => {
    expect(inventoryGET).toBe(specsInventoryGET);
  });

  it("mounts the edit-context read the CLI write path uses instead of a full detail fetch", () => {
    expect(editContextGET).toBe(specEditContextGET);
  });
});
