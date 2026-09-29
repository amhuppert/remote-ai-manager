import { describe, expect, it } from "vitest";
import { valueImportSpecifiers, shortestImportPath } from "./module-imports";

describe("module import evidence", () => {
  it("erases types and preserves used values, reexports, side effects and deferred literals", () => {
    expect(
      valueImportSpecifiers(
        "sample.ts",
        `
      import type { T } from './types';
      import { TypeUsedOnly } from './implicit-type';
      import { type Another, value } from './mixed';
      import './side-effect';
      export { thing } from './exported';
      export type { Result } from './result';
      const x: TypeUsedOnly = value;
      console.log(x);
      async function later() { return import('./lazy'); }
      function cjs() { return require('./required'); }
      // import { fake } from './comment';
    `,
      ),
    ).toEqual([
      "./exported",
      "./lazy",
      "./mixed",
      "./required",
      "./side-effect",
    ]);
  });
  it("reports a shortest concrete path and terminates on cycles", () => {
    const graph = new Map([
      ["a", ["b", "c"]],
      ["b", ["a", "c"]],
      ["c", ["d"]],
      ["d", []],
    ]);
    expect(shortestImportPath(graph, "a", "d")).toEqual(["a", "c", "d"]);
    expect(shortestImportPath(graph, "a", "missing")).toBeNull();
  });
});
