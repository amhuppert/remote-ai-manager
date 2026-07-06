/**
 * Minimal declaration for Bun's built-in sqlite driver, used only by the
 * workflow-audit CLI entry point. The repo does not depend on bun-types;
 * this covers the tiny surface `run.ts` touches.
 */
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean });
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  }
}
