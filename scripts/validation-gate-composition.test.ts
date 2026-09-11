// @vitest-inputs CommandCenter.json scripts/pre-merge-validate.sh
// @vitest-inputs scripts/pre-merge-validate-full.sh
// @vitest-inputs scripts/validate/typecheck.sh
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repoValidationConfigSchema } from "../src/lib/validation/schemas";

/**
 * command-center#68 split the production build and the seam ratchet out of the
 * in-loop `typecheck` command into dedicated commands, and 37cb2166 then
 * removed the `build` registration altogether (the build script remains for
 * explicit checkpoint use). This ratchet pins that composition so a later edit
 * cannot fold the heavy phases back into the implementation loop, register the
 * build into a merge gate, or silently drop the seam ratchet from one.
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
  it("registers dedicated typecheck and seams commands and no build command", () => {
    expect(Object.keys(registration.commands)).toEqual(
      expect.arrayContaining(["typecheck", "seams"]),
    );
    expect(Object.keys(registration.commands)).not.toContain("build");
  });

  it("keeps the in-loop typecheck free of the build and the seam ratchet", () => {
    const script = read("scripts/validate/typecheck.sh");
    expect(script).toMatch(/--noEmit --pretty false/);
    expect(script).not.toMatch(/bun run build(?!:info)/);
    expect(script).not.toMatch(/seams:check/);
  });

  it("runs the native checker installed in the checkout under validation, on its own build-info file", () => {
    const script = read("scripts/validate/typecheck.sh");
    // The `typescript` package stays on 5.x for the JS API the architecture
    // scanners use; the native compiler is the `typescript-native` alias, and
    // its build info must not share a file with tsc's incompatible format.
    expect(script).toMatch(/\$PWD\/node_modules\/typescript-native\/bin\/tsc/);
    expect(script).toMatch(/--tsBuildInfoFile/);
    expect(script).not.toMatch(/npx tsc/);
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
