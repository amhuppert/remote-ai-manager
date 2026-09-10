// @vitest-inputs src/**/*.{ts,tsx}
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * No checkpoint diagnostic may carry free text (R9.2).
 *
 * The behavioural tests beside this one cover the failure paths that exist
 * today. This covers the one that does not exist yet: the checkpoint lifecycle
 * is written from a dozen modules, and every one of them has an exception
 * handler where `getErrorMessage(error)` is the obvious field to add. That
 * single line is enough to put a rejected row's value, a quoted prompt, or a
 * resume token into a log, and no assertion about today's code would catch it.
 *
 * Three rules, because a checkpoint event reaches the log by three routes:
 *
 * 1. directly, as the first argument of a log call — its field object is
 *    scanned for free-text channels;
 * 2. through shared publication, where the event name is a `failureEvent` and
 *    the helper's own default field is the exception message — the caller must
 *    supply a `describeError` projection instead;
 * 3. through anything else, which must be declared below with the reason it is
 *    safe. A new indirect emitter fails this test until someone argues for it,
 *    which is the property rules 1 and 2 alone did not have.
 */

const SRC_ROOT = path.join(process.cwd(), "src");

/**
 * Free-text channels. Each names a value produced elsewhere — an exception, a
 * model refusal, an envelope statement — whose content nothing in the
 * checkpoint domain constrains. Structural fields (`code`, `phase`, byte
 * counts, hashes, ids) are the intended vocabulary and are not listed.
 */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  {
    pattern: /getErrorMessage\(/,
    why: "exception text; use checkpointErrorFields(error) from @/lib/conversation-checkpoints/diagnostics",
  },
  { pattern: /\.message(?![A-Za-z0-9_])/, why: "a failure message body" },
  {
    pattern: /\.statement(?![A-Za-z0-9_])/,
    why: "an envelope decision statement",
  },
  { pattern: /String\(err/, why: "a stringified exception" },
  { pattern: /\.prompt(?![A-Za-z0-9_])/, why: "model input" },
  { pattern: /\bseedText\b|\bseed:/, why: "seed body" },
];

/**
 * Checkpoint event names that reach a logger by neither route above, with the
 * reason each is safe. Keyed by module, because the reason is a property of
 * the module's own emitter rather than of the individual name.
 */
const DECLARED_INDIRECT: { module: string; why: string }[] = [
  {
    // `checkpoint.admitOperation` and friends label a write-queue critical
    // section. The queue logs them under `state-store.write_queue.*` with
    // timings only, and never with an error.
    module: "conversation-checkpoints/repo.ts",
    why: "write-queue operation labels, not log events",
  },
  {
    // Passed to the local `logRefusal`, whose field object is the refusal's
    // code, phase and operation id — no channel an error can reach.
    module: "conversation-checkpoints/route-handlers.ts",
    why: "refusal names emitted through logRefusal, which logs codes only",
  },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (
      (full.endsWith(".ts") || full.endsWith(".tsx")) &&
      !full.includes(".test.") &&
      !full.includes(".stories.")
    )
      out.push(full);
  }
  return out;
}

/** The balanced `{…}` starting at `open`. */
function balancedObject(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

interface LogCall {
  /** Source span of the event expression, before the fields argument. */
  eventArg: string;
  eventArgStart: number;
  eventArgEnd: number;
  /** The fields argument as written: an object literal, or a bound name. */
  body: string;
}

/**
 * Every `logger.<level>(<event>, <fields>)` call, with the event expression and
 * the fields argument separated. The event is a span rather than a literal so a
 * call that picks its name with a ternary is still matched, and the fields
 * argument is taken as written so a call that passes a prepared record instead
 * of a literal is still recognised as a direct emitter.
 */
function logCalls(source: string): LogCall[] {
  const calls: LogCall[] = [];
  const pattern = /\.(?:info|warn|error|debug)\(/g;
  for (
    let match = pattern.exec(source);
    match !== null;
    match = pattern.exec(source)
  ) {
    const argStart = match.index + match[0].length;
    let depth = 1;
    let objStart = -1;
    let callEnd = -1;
    for (let i = argStart; i < source.length && depth > 0; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) callEnd = i;
      } else if (ch === "{" && depth === 1) {
        objStart = i;
        break;
      }
    }
    if (objStart !== -1) {
      calls.push({
        eventArg: source.slice(argStart, objStart),
        eventArgStart: argStart,
        eventArgEnd: objStart,
        body: balancedObject(source, objStart),
      });
      continue;
    }
    if (callEnd === -1) continue;
    const args = source.slice(argStart, callEnd);
    const split = args.lastIndexOf(",");
    if (split === -1) continue;
    calls.push({
      eventArg: args.slice(0, split),
      eventArgStart: argStart,
      eventArgEnd: argStart + split,
      body: args.slice(split + 1),
    });
  }
  return calls;
}

interface Leak {
  where: string;
  event: string;
  why: string;
}

function at(file: string, source: string, index: number): string {
  return `${path.relative(SRC_ROOT, file)}:${source.slice(0, index).split("\n").length}`;
}

const CHECKPOINT_LITERAL = /(?:"(checkpoint\.[^"]*)"|`(checkpoint\.[^`]*)`)/g;

function leaks(file: string, source: string): Leak[] {
  const found: Leak[] = [];
  const calls = logCalls(source);

  // 1. Direct log calls naming a checkpoint event.
  for (const call of calls) {
    if (!call.eventArg.includes("checkpoint.")) continue;
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(call.body))
        found.push({
          where: at(file, source, call.eventArgStart),
          event: (call.eventArg.match(/checkpoint\.[^"`]*/) ?? [""])[0],
          why,
        });
    }
  }

  // 2. Shared publication: the helper's default failure field is the exception
  //    message, so a checkpoint failureEvent must project the error itself.
  const failure = /failureEvent:\s*"(checkpoint\.[^"]*)"/g;
  for (
    let match = failure.exec(source);
    match !== null;
    match = failure.exec(source)
  ) {
    let open = source.lastIndexOf("{", match.index);
    for (; open > 0; open = source.lastIndexOf("{", open - 1)) {
      const body = balancedObject(source, open);
      if (!body.includes(match[0])) continue;
      if (!/describeError\s*:/.test(body))
        found.push({
          where: at(file, source, match.index),
          event: match[1] ?? "",
          why: "publication failure logged through the shared helper without a describeError projection",
        });
      break;
    }
  }

  // 3. Anything else naming a checkpoint event must be declared.
  const declared = DECLARED_INDIRECT.some(({ module }) =>
    file.endsWith(module),
  );
  if (declared) return found;
  CHECKPOINT_LITERAL.lastIndex = 0;
  for (
    let match = CHECKPOINT_LITERAL.exec(source);
    match !== null;
    match = CHECKPOINT_LITERAL.exec(source)
  ) {
    const inLogCall = calls.some(
      (call) =>
        match.index >= call.eventArgStart && match.index < call.eventArgEnd,
    );
    if (inLogCall) continue;
    if (/failureEvent:\s*$/.test(source.slice(0, match.index).trimEnd() + " "))
      continue;
    if (source.slice(0, match.index).trimEnd().endsWith("failureEvent:"))
      continue;
    // A comment naming an event is documentation, not an emitter.
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    if (/^\s*(?:\*|\/\/)/.test(source.slice(lineStart, match.index))) continue;
    found.push({
      where: at(file, source, match.index),
      event: match[1] ?? match[2] ?? "",
      why: "checkpoint event reaches a logger indirectly; declare it in DECLARED_INDIRECT with why it is safe",
    });
  }
  return found;
}

describe("checkpoint lifecycle diagnostics", () => {
  it("emit no free text from any production call site", () => {
    const found = sourceFiles(SRC_ROOT).flatMap((file) =>
      leaks(file, readFileSync(file, "utf-8")),
    );

    expect(
      found,
      found.map((l) => `${l.where} ${l.event}: ${l.why}`).join("\n"),
    ).toEqual([]);
  });

  it("detects a direct exception sink", () => {
    const fixture = `
      log.error("checkpoint.readiness_commit_failed", {
        ...fields,
        error: getErrorMessage(error),
      });
      log.info("checkpoint.queue_repair.confirmed", {
        ...fields,
        messageIds: repair.messageIds,
      });
      log.info(
        recover === null ? "checkpoint.admitted" : "checkpoint.recovery_admitted",
        { ...fields, ordinal: operation.ordinal },
      );
    `;

    expect(leaks("fixture.ts", fixture)).toEqual([
      {
        where: expect.stringContaining("fixture.ts:2"),
        event: "checkpoint.readiness_commit_failed",
        why: expect.stringContaining("exception text"),
      },
    ]);
  });

  it("sees through a fields argument that is not a literal", () => {
    const fixture = `
      log.info("checkpoint.runtime_closed", fields);
      log.error("checkpoint.reconcile.failed", buildFields(getErrorMessage(e)));
    `;

    expect(leaks("fixture.ts", fixture)).toEqual([
      {
        where: expect.stringContaining("fixture.ts:3"),
        event: "checkpoint.reconcile.failed",
        why: expect.stringContaining("exception text"),
      },
    ]);
  });

  it("detects publication that leaves the helper's default error field in place", () => {
    const leaking = `
      publishEventBestEffort({
        build: () => frame,
        logger: log,
        failureEvent: "checkpoint.event.publish_failed",
        context: fields,
      });
    `;
    const projected = `
      publishEventBestEffort({
        build: () => frame,
        logger: log,
        failureEvent: "checkpoint.event.publish_failed",
        context: fields,
        describeError: checkpointErrorFields,
      });
    `;

    expect(leaks("fixture.ts", leaking)).toEqual([
      {
        where: expect.stringContaining("fixture.ts:5"),
        event: "checkpoint.event.publish_failed",
        why: expect.stringContaining("describeError"),
      },
    ]);
    expect(leaks("fixture.ts", projected)).toEqual([]);
  });

  it("detects an undeclared indirect emitter", () => {
    const fixture = `
      reportLifecycle("checkpoint.route.cancel_refused", refusal);
    `;

    expect(leaks("fixture.ts", fixture)).toEqual([
      {
        where: expect.stringContaining("fixture.ts:2"),
        event: "checkpoint.route.cancel_refused",
        why: expect.stringContaining("declare it"),
      },
    ]);
  });
});
