import { cliConfiguration, cliRegistry, registryState } from "../internal/registry.js";
import { invocationArgv } from "../internal/invocations.js";
import { assertFields, assertRecord, assertText } from "../internal/validation.js";
import { validateOutputBudget } from "../internal/artifacts.js";
import { expectBounded } from "./index.js";
function requireFact(condition, message) {
    if (!condition)
        throw new Error(message);
}
function same(left, right) {
    const ordered = (value) => Array.isArray(value) ? value.map(ordered)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
    return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}
function data(result) {
    requireFact(result.exitCode === 0 && result.envelope.ok && result.envelope.payload?.kind === "inline", "Expected inline successful data.");
    const value = result.envelope.payload.data;
    assertRecord(value);
    return value;
}
const measured = (text) => new TextEncoder().encode(text).byteLength;
/** Independently decode the renderer's shell-safe subset. Shell expansion,
 * operators and unquoted whitespace inside tokens cannot pass this grammar. */
function shellTokens(source) {
    const tokens = [];
    let token = "", active = false, quoted = false, wordQuoted = false;
    let assignmentPrefixQuoted;
    const finish = () => {
        if (tokens.length === 0) {
            const reserved = ["if", "then", "else", "elif", "fi", "do", "done", "case", "esac", "while", "until", "for", "in", "time", "function", "select", "coproc"];
            requireFact(assignmentPrefixQuoted !== false && (wordQuoted || !reserved.includes(token)), "Invocation executable requires shell quoting.");
        }
        tokens.push(token);
        token = "";
        active = false;
        wordQuoted = false;
        assignmentPrefixQuoted = undefined;
    };
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        // Freeze quoting at the first equals sign: quotes later in the value cannot
        // make an unquoted assignment prefix safe to use as an executable.
        if (char === "=" && assignmentPrefixQuoted === undefined)
            assignmentPrefixQuoted = wordQuoted;
        if (char === "'") {
            quoted = !quoted;
            active = true;
            wordQuoted = true;
        }
        else if (quoted) {
            token += char;
            active = true;
        }
        else if (char === " " && active) {
            finish();
        }
        else if (char === " ")
            continue;
        else if (char === "\\" && source[index + 1] === "'") {
            token += "'";
            active = true;
            index++;
        }
        else {
            requireFact(/^[a-zA-Z0-9_@%+=:,./-]$/.test(char), "Invocation reference contains shell syntax outside quotes.");
            token += char;
            active = true;
        }
    }
    requireFact(!quoted, "Invocation reference has an unterminated quote.");
    if (active)
        finish();
    return tokens;
}
export function inheritedCases(cli, fixtures) {
    const budget = validateOutputBudget(cliConfiguration(cli).output.maxBytes);
    function caseOf(name, check) {
        requireFact(typeof fixtures[name] === "function", `Missing contract fixture: ${name}.`);
        return Object.freeze({ name, run: async () => {
                const evidence = await fixtures[name]();
                try {
                    check(evidence);
                }
                catch (error) {
                    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
                }
            } });
    }
    const bounded = (result) => { expectBounded(result, budget); };
    return Object.freeze([
        caseOf("offline-paths", ({ runs }) => {
            requireFact(runs.length > 0, "Offline evidence is empty.");
            for (const result of runs) {
                bounded(result);
                requireFact(!result.events.some(event => event.type === "handler.load" || event.type === "context.acquire"), "Offline path evaluated a handler/context.");
                requireFact(result.exitCode === 0 || result.exitCode === 2, "Offline path failed outside usage classification.");
            }
        }),
        caseOf("schema-issue-survival", ({ json, text, expectedIssues }) => {
            bounded(json);
            bounded(text);
            requireFact(expectedIssues.length > 0, "Schema fixture must expect issues.");
            requireFact(json.exitCode === 2 && !json.envelope.ok && json.envelope.error.code === "KERNEL_INPUT", "Schema failure lost its input classification.");
            for (const expected of expectedIssues) {
                requireFact(json.envelope.error.issues?.some(issue => same(issue, expected)), "Schema issue/path lost before JSON delivery.");
                requireFact(text.stderr.includes(expected.message), "Schema issue lost before text delivery.");
            }
            requireFact(text.exitCode === 2 && !text.stdout, "Schema text has the wrong stream/classification.");
            requireFact(![json, text].some(result => result.events.some(event => event.type === "context.acquire")), "Schema failure acquired domain services.");
        }),
        caseOf("single-guidance-arbitration", ({ json, text }) => {
            for (const result of [json, text]) {
                bounded(result);
                requireFact(result.events.filter(event => event.type === "guidance.arbitrate").length === 1, "Guidance was arbitrated more or less than once.");
                const conflicts = result.events.filter(event => event.type === "guidance.conflict");
                requireFact(conflicts.length === 1 && conflicts[0]?.conflict.instructions.length === 2, "Expected one conflict retaining both instructions.");
                requireFact(result.events.some(event => event.type === "guidance.rule_fired"), "Rule firing evidence was lost.");
                requireFact(result.exitCode === 1, "Guidance conflict must fail.");
            }
            requireFact(!json.envelope.ok && json.envelope.error.code === "KERNEL_GUIDANCE" && typeof json.envelope.instruction === "string" && json.envelope.instruction.startsWith("Stop and report"), "Conflict instruction was replaced or lost.");
            requireFact(!json.envelope.hint && text.stderr.includes(json.envelope.instruction), "Conflict did not suppress hints or survive text delivery.");
        }),
        caseOf("unknown-totals", ({ json, continuation, returned }) => {
            bounded(json);
            const payload = data(json), omission = payload["omission"];
            assertRecord(omission);
            const total = omission["total"];
            assertRecord(total);
            requireFact(total["kind"] === "unknown" && !Object.hasOwn(total, "count"), "Unknown total was reported as known.");
            requireFact(Array.isArray(payload["items"]) && payload["items"].length === returned && omission["returned"] === returned, "Returned count does not describe this page.");
            requireFact(omission["truncated"] === true && same(omission["reveal"], continuation) && continuation.effects === "read", "Truncated page lost its exact read continuation.");
        }),
        caseOf("shell-safe-references", ({ json, rendered, reference, executable }) => {
            bounded(json);
            requireFact(same(shellTokens(rendered), [executable, ...invocationArgv(reference)]), "Shell reference changed invocation token boundaries.");
            requireFact(json.exitCode === 0 && json.envelope.hint?.includes(rendered), "Delivered hint lost its shell-safe reference.");
        }),
        caseOf("unicode-spill", ({ inline, spilled, budget: threshold, expectedSpill, artifactBytes }) => {
            bounded(inline);
            bounded(spilled);
            expectBounded(inline, threshold);
            expectBounded(spilled, threshold);
            requireFact(measured(inline.stdout) + measured(inline.stderr) === threshold && inline.envelope.payload?.kind === "inline", "Unicode exact-boundary response did not remain inline.");
            requireFact(expectedSpill.length <= threshold && measured(expectedSpill) > threshold, "Fixture does not distinguish UTF-8 bytes from code units.");
            const manifest = spilled.artifacts[0];
            requireFact(spilled.exitCode === 0 && spilled.envelope.payload?.kind === "artifact" && manifest?.reason === "stdout_budget_exceeded" && manifest.contains === "response", "Unicode overflow did not spill the full response.");
            requireFact(manifest.bytes === measured(expectedSpill) && artifactBytes.length === manifest.bytes, "Spill manifest miscounted UTF-8 bytes.");
            const spill = spilled.envelope.payload.spill;
            requireFact(spill?.format === "json" && spill.inlineBytes === measured(expectedSpill) && spill.maxBytes === threshold, "Spill metadata miscounted the attempted inline response.");
            requireFact(spilled.envelope.ok && !spilled.envelope.issues.some(issue => issue.code === "KERNEL_OUTPUT"), "Successful spill was reported as an output issue.");
            const expected = new TextEncoder().encode(expectedSpill);
            requireFact(expected.length === artifactBytes.length && expected.every((value, index) => value === artifactBytes[index]), "Spilled bytes differ from the original Unicode response.");
        }),
        caseOf("operation-recovery", ({ json, text, effect, recovery, instruction }) => {
            bounded(json);
            bounded(text);
            requireFact(!json.envelope.ok && json.envelope.error.code === "KERNEL_OUTPUT" && json.exitCode === 1, "Expected artifact delivery failure.");
            requireFact(json.envelope.effect === effect && same(json.envelope.recovery, recovery), "Known operation effect/recovery was dropped after delivery failure.");
            requireFact(json.envelope.instruction === instruction && text.stderr.includes(instruction), "Required operation guidance was dropped.");
            requireFact(text.exitCode === 1 && !text.stdout && text.stderr.includes(effect), "Text lost operation classification.");
            const facts = recovery.kind === "reported" ? recovery.references.map(reference => reference.id) : [recovery.commandPath, recovery.advice];
            requireFact(facts.every(fact => text.stderr.includes(fact)), "Text lost compact recovery facts.");
            requireFact([json, text].every(result => result.calls.some(call => call.kind === "write") && result.artifacts.length === 0), "Fixture did not fail artifact publication.");
        }),
    ]);
}
/** Checks caller-supplied field inventories and byte bounds, not the meaning of
 * arbitrary prose. Every mismatch is reported at once, by command path. */
export function expectDisclosureParity(cli, exceptions, observations, options = {}) {
    try {
        const budget = validateOutputBudget(cliConfiguration(cli).output.maxBytes);
        const nodes = registryState(cliRegistry(cli)).nodes;
        const quoted = (fields) => JSON.stringify([...fields].sort());
        const fields = (value, label, command) => {
            requireFact(Array.isArray(value), `Expected disclosure ${label} field inventory for ${JSON.stringify(command)}.`);
            value.forEach(assertText);
            const unique = new Set(value);
            requireFact(unique.size === value.length, `Duplicate disclosure ${label} fields for ${JSON.stringify(command)}: ${quoted(new Set(value.filter((field, index) => value.indexOf(field) !== index)))}.`);
            return unique;
        };
        const leaf = (command) => typeof command === "string" && ["command", "validation"].includes(nodes[command]?.kind ?? "");
        const inventory = new Map();
        for (const entry of exceptions) {
            assertRecord(entry);
            assertFields(entry, ["command", "extraFields", "rationale", "deleteWhen"]);
            assertText(entry.command);
            assertText(entry.rationale);
            assertText(entry.deleteWhen);
            const command = JSON.stringify(entry.command);
            requireFact(leaf(entry.command), `Stale disclosure exception target ${command}.`);
            requireFact(fields(entry.extraFields, "exception", entry.command).size > 0, `Disclosure exception for ${command} lists no extra fields.`);
            requireFact(!inventory.has(entry.command), `Duplicate disclosure exception for ${command}.`);
            requireFact(!options.satisfiedDeletionConditions?.includes(entry.deleteWhen), `Stale disclosure exception for ${command}: deletion condition ${JSON.stringify(entry.deleteWhen)} is satisfied.`);
            inventory.set(entry.command, entry);
        }
        const seen = new Set();
        const mismatches = [];
        for (const observation of observations) {
            const command = observation.command;
            requireFact(leaf(command), `Unknown disclosure observation command ${JSON.stringify(command)}.`);
            requireFact(!seen.has(command), `Duplicate disclosure observation for ${JSON.stringify(command)}.`);
            for (const [format, result] of [["text", observation.text], ["JSON", observation.json]]) {
                try {
                    expectBounded(result, budget);
                }
                catch (error) {
                    throw new Error(`${JSON.stringify(command)} ${format} output ${error instanceof Error ? error.message.replace(/^Output /, "") : "is unbounded."}`);
                }
            }
            seen.add(command);
            const text = fields(observation.textFields, "text", command), json = fields(observation.jsonFields, "JSON", command);
            const allowed = new Set(inventory.get(command)?.extraFields ?? []);
            const textOnly = [...text].filter(field => !json.has(field));
            const extras = [...json].filter(field => !text.has(field));
            const differences = [
                ...(textOnly.length ? [`text-only ${quoted(textOnly)}`] : []),
                ...(extras.some(field => !allowed.has(field)) ? [`unlisted JSON-only ${quoted(extras.filter(field => !allowed.has(field)))}`] : []),
                ...([...allowed].some(field => !extras.includes(field)) ? [`stale exception fields ${quoted([...allowed].filter(field => !extras.includes(field)))}`] : []),
            ];
            if (differences.length)
                mismatches.push([command, `${JSON.stringify(command)}: ${differences.join("; ")}`]);
        }
        mismatches.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
        requireFact(mismatches.length === 0, `parity differs for ${mismatches.length} command${mismatches.length === 1 ? "" : "s"}:\n${mismatches.map(([, line]) => line).join("\n")}`);
        const unobserved = [...inventory.keys()].filter(command => !seen.has(command));
        requireFact(unobserved.length === 0, `Disclosure exceptions have no current parity evidence: ${quoted(unobserved)}.`);
    }
    catch (error) {
        throw new Error(`disclosure: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
}
//# sourceMappingURL=contracts.js.map