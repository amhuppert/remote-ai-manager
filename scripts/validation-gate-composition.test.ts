import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repoValidationConfigSchema } from "../src/lib/validation/schemas";

/**
 * command-center#68 split the production build and the seam ratchet out of the
 * in-loop `typecheck` command into dedicated `build` and `seams` commands, and
 * deliberately excludes `build` from every merge gate (the `preMerge` and
 * `laneMerge` lists and the `pre-merge` composite) — the build runs at
 * checkpoints on explicit request instead. This ratchet pins that composition
 * so a later edit cannot fold the heavy phases back into the implementation
 * loop or silently drop the seam ratchet from a merge gate.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function read(relativePath: string): string {
  return readFileSync(path.resolve(REPO_ROOT, relativePath), "utf8");
}

const registration = repoValidationConfigSchema.parse(
  (JSON.parse(read("CommandCenter.json")) as { validation: unknown })
    .validation,
);

describe("validation gate composition", () => {
  it("registers dedicated typecheck, seams, and build commands", () => {
    expect(Object.keys(registration.commands)).toEqual(
      expect.arrayContaining(["typecheck", "seams", "build"]),
    );
  });

  it("keeps the in-loop typecheck free of the build and the seam ratchet", () => {
    const script = read("scripts/validate/typecheck.sh");
    expect(script).toMatch(/tsc --noEmit/);
    expect(script).not.toMatch(/bun run build(?!:info)/);
    expect(script).not.toMatch(/seams:check/);
  });

  it("keeps typecheck, seams, and test on every merge gate", () => {
    const gates = {
      preMerge: registration.preMerge,
      laneMerge: registration.laneMerge ?? [],
    };
    for (const [name, gate] of Object.entries(gates)) {
      expect(gate, `${name} must keep the static merge gate`).toEqual(
        expect.arrayContaining(["typecheck", "seams", "test"]),
      );
    }
  });

  it("keeps the seam ratchet, and no build, inside the pre-merge composite", () => {
    for (const composite of [
      "scripts/pre-merge-validate.sh",
      "scripts/pre-merge-validate-full.sh",
    ]) {
      const body = read(composite);
      expect(body, `${composite} must run the seam ratchet`).toMatch(
        /validate\/seams\.sh/,
      );
      expect(
        body,
        `${composite} must not run the production build`,
      ).not.toMatch(/validate\/build\.sh/);
    }
  });
});
