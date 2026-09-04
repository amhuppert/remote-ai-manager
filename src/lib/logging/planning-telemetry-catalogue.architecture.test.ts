import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Architecture guardrail (#80 design 3.10, and the standing rule in
 * `.kiro/steering/logs.md` that an event is documented with the implementation
 * that emits it): the planning-telemetry events are a declare-or-fail
 * registry. Declaring one in a telemetry module is not enough — it must be
 * emitted somewhere, and both the event and every file that emits it must
 * appear in the Key events catalogue. Without this, the catalogue drifts the
 * moment an emitter moves, and the retrospective the events exist for reads a
 * vocabulary nothing documents.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const LIB_ROOT = path.join(REPO_ROOT, "src/lib");
const LOGS_STEERING = path.join(REPO_ROOT, ".kiro/steering/logs.md");

/** The modules that own a planning-telemetry event vocabulary. */
const TELEMETRY_MODULES = [
  "src/lib/workflow-graph/planning-telemetry.ts",
  "src/lib/specs/planning-telemetry.ts",
] as const;

interface DeclaredEvent {
  /** The exported constant an emitter references. */
  readonly constantName: string;
  /** The `module.event` name the log line carries. */
  readonly eventName: string;
  /** Repo-relative path of the module that declares it. */
  readonly declaringFile: string;
}

const EVENT_DECLARATION = /export const (\w+_EVENT)\s*=\s*\n?\s*"([^"]+)"/g;

function declaredEvents(relativeModule: string): DeclaredEvent[] {
  const source = readFileSync(path.join(REPO_ROOT, relativeModule), "utf8");
  const found: DeclaredEvent[] = [];
  for (const match of source.matchAll(EVENT_DECLARATION)) {
    const constantName = match[1];
    const eventName = match[2];
    if (constantName === undefined || eventName === undefined) continue;
    found.push({ constantName, eventName, declaringFile: relativeModule });
  }
  return found;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__fixtures__") continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

/**
 * The exported builders that return this event: the functions in the declaring
 * module whose OWN body names its constant. Emitters call a builder rather
 * than naming the event string, so the enumeration below follows the builder —
 * a scan for the raw event name would find only the declaration and report
 * every event as unemitted.
 *
 * Each function's text is cut at the next top-level `export`, because a module
 * may declare a constant after an unrelated function: without the cut that
 * function swallows the declaration, is counted a builder, and every file
 * merely sharing its name is reported an emitter.
 */
function buildersIn(source: string, constantName: string): string[] {
  const reference = new RegExp(`\\b${constantName}\\b`);
  return source
    .split(/\bexport function /)
    .slice(1)
    .map((chunk) => {
      const next = chunk.indexOf("\nexport ");
      return next === -1 ? chunk : chunk.slice(0, next);
    })
    .filter((chunk) => reference.test(chunk))
    .map((chunk) => chunk.slice(0, chunk.indexOf("(")))
    .filter((name) => /^\w+$/.test(name));
}

function buildersFor(event: DeclaredEvent): string[] {
  return buildersIn(
    readFileSync(path.join(REPO_ROOT, event.declaringFile), "utf8"),
    event.constantName,
  );
}

/**
 * Repo-relative files that call one of the event's builders — the emitters.
 * The declaring module is excluded: declaring a name is not emitting it.
 */
function emittingFiles(event: DeclaredEvent, files: readonly string[]) {
  const builders = buildersFor(event);
  const reference = new RegExp(`\\b(${builders.join("|")})\\b`);
  return builders.length === 0
    ? []
    : files
        .map((file) => path.relative(REPO_ROOT, file))
        .filter((relative) => relative !== event.declaringFile)
        .filter((relative) =>
          reference.test(readFileSync(path.join(REPO_ROOT, relative), "utf8")),
        );
}

/** Event names the catalogue markdown does not mention. Pure, so it can be red-proved. */
function eventsMissingFromCatalogue(
  eventNames: readonly string[],
  catalogue: string,
): string[] {
  return eventNames.filter((name) => !catalogue.includes(`\`${name}\``));
}

/** Emitter files the catalogue does not name beside their event's row. */
function emittersMissingFromCatalogue(
  eventName: string,
  emitters: readonly string[],
  catalogue: string,
): string[] {
  const row =
    catalogue.split("\n").find((line) => line.includes(`\`${eventName}\``)) ??
    "";
  return emitters.filter((emitter) => !row.includes(emitter));
}

const EVENTS = TELEMETRY_MODULES.flatMap(declaredEvents);
const SOURCE_FILES = listSourceFiles(LIB_ROOT);
const CATALOGUE = readFileSync(LOGS_STEERING, "utf8");

describe("planning-telemetry event catalogue", () => {
  it("discovers every declared planning-telemetry event", () => {
    // Guards against a scan that silently matches nothing, which would make
    // every assertion below vacuously green.
    expect(EVENTS.map((event) => event.eventName).sort()).toEqual([
      "spec.plan.attempt.transition",
      "spec.plan.preflight",
      "spec.plan.propose.accepted",
      "workflow.replace.server_fields_merged",
      "workflow.validate.refused",
    ]);
  });

  it("resolves a builder for every declared event", () => {
    // The emitter enumeration follows builder names; an event whose builder
    // cannot be resolved would report zero emitters for the wrong reason.
    expect(
      EVENTS.filter((event) => buildersFor(event).length === 0).map(
        (event) => event.eventName,
      ),
    ).toEqual([]);
  });

  it("counts only the function whose own body names the constant (red proof)", () => {
    const source = [
      "export function unrelated(request: Request): string | null {",
      "  return null;",
      "}",
      "",
      'export const SOME_EVENT = "some.event";',
      "",
      "export function someEventBuilder(input: Input) {",
      "  return { event: SOME_EVENT, fields: {} };",
      "}",
      "",
    ].join("\n");

    expect(buildersIn(source, "SOME_EVENT")).toEqual(["someEventBuilder"]);
  });

  it("reports an uncatalogued event name (red proof)", () => {
    // If the detector could not catch this, the catalogue assertion would
    // never guard anything.
    expect(
      eventsMissingFromCatalogue(
        ["workflow.validate.refused", "workflow.never.catalogued"],
        "| `workflow` | `workflow.validate.refused` | … |",
      ),
    ).toEqual(["workflow.never.catalogued"]);
  });

  it("reports an uncatalogued emitter file (red proof)", () => {
    expect(
      emittersMissingFromCatalogue(
        "workflow.validate.refused",
        ["src/lib/a.ts", "src/lib/b.ts"],
        "| `workflow` | `workflow.validate.refused` | emitted by `src/lib/a.ts` |",
      ),
    ).toEqual(["src/lib/b.ts"]);
  });

  it("catalogues every declared event in .kiro/steering/logs.md", () => {
    expect(
      eventsMissingFromCatalogue(
        EVENTS.map((event) => event.eventName),
        CATALOGUE,
      ),
    ).toEqual([]);
  });

  it("enumerates an emitter for every declared event", () => {
    const unemitted = EVENTS.filter(
      (event) => emittingFiles(event, SOURCE_FILES).length === 0,
    ).map((event) => event.eventName);
    expect(unemitted).toEqual([]);
  });

  it("names every emitting file in the event's catalogue row", () => {
    const undocumented = EVENTS.flatMap((event) =>
      emittersMissingFromCatalogue(
        event.eventName,
        emittingFiles(event, SOURCE_FILES),
        CATALOGUE,
      ).map((emitter) => `${event.eventName} → ${emitter}`),
    );
    expect(undocumented).toEqual([]);
  });
});
