import { hint, instruction } from "../guidance/index.js";
import { decodeWireEnvelope, kernelError, protocolLimits } from "../results.js";
import { assertFields, assertInvocation, assertRecord, assertSerializedLimit, assertText, frozenJson } from "./validation.js";
import { referenceTokens, renderReference } from "./invocations.js";
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function byRule(a, b) {
    return compare(a.provenance.ruleId, b.provenance.ruleId) || compare(JSON.stringify(a.value), JSON.stringify(b.value));
}
/** The only arbiter: handler guidance and rule candidates enter once. */
export async function arbitrate(input) {
    const issues = [];
    const failures = [];
    const invalid = (message) => { failures.push({ code: "KERNEL_CONTRACT", message }); };
    const instructions = [];
    let handlerHint;
    try {
        const handler = frozenJson(input.handler);
        assertRecord(handler);
        assertFields(handler, [], ["hint", "instruction"]);
        if (handler.hint && handler.instruction)
            throw new TypeError("Mixed handler guidance.");
        if (handler.instruction !== undefined) {
            assertFields(handler.instruction, ["ownerId", "text"]);
            const value = instruction(handler.instruction.ownerId, handler.instruction.text);
            instructions.push({ instruction: value, provenance: { kind: "handler", ownerId: value.ownerId } });
        }
        if (handler.hint !== undefined) {
            assertFields(handler.hint, ["action", "invocation"]);
            handlerHint = hint(handler.hint.invocation, handler.hint.action);
        }
    }
    catch {
        invalid("Invalid handler guidance.");
    }
    const candidates = [];
    if (input.evaluated) {
        if (input.evaluated.commandPath !== input.commandPath)
            invalid("Wrong guidance command.");
        else {
            candidates.push(...input.evaluated.candidates);
            issues.push(...input.evaluated.issues.map(issue => ({ ...issue, path: ["guidance", ...issue.path ?? []] })));
        }
    }
    candidates.sort(byRule);
    for (const candidate of candidates) {
        if (candidate.tier === "instruction")
            instructions.push({ instruction: candidate.value, provenance: { kind: "rule", ...candidate.provenance } });
    }
    // Equality is required action text, not owner ID. Preserve all competing owners
    // when texts differ; repeated identical source entries do not duplicate events.
    const unique = instructions.filter((entry, index) => instructions.findIndex(other => JSON.stringify(other) === JSON.stringify(entry)) === index);
    let conflict;
    let selectedInstruction = unique[0]?.instruction;
    if (new Set(unique.map(entry => entry.instruction.text)).size > 1) {
        const [first, second, ...rest] = unique;
        if (!first || !second)
            throw new TypeError("Conflict requires competing instructions.");
        conflict = frozenJson({ instructions: [first, second, ...rest] });
        selectedInstruction = instruction("kernel.guidance-conflict", "Stop and report conflicting required instructions before continuing.");
        if (typeof input.conflictSink === "function") {
            try {
                await input.conflictSink(frozenJson({ type: "guidance.conflict", commandPath: input.commandPath, conflict }));
            }
            catch {
                issues.push({ code: "KERNEL_GUIDANCE", message: "Guidance conflict sink failed.", path: ["guidance", "conflictSink"] });
            }
        }
    }
    if (typeof input.conflictSink !== "function")
        invalid("Response arbitration requires a conflict sink.");
    const reminders = [];
    const texts = new Set();
    const ranked = candidates.filter(candidate => candidate.tier === "reminder")
        .sort((a, b) => b.priority - a.priority || byRule(a, b));
    for (const candidate of ranked) {
        if (texts.has(candidate.value.text))
            continue;
        texts.add(candidate.value.text);
        reminders.push(candidate.value);
        if (reminders.length === 2)
            break;
    }
    try {
        assertSerializedLimit(reminders, protocolLimits.reminders);
    }
    catch {
        invalid("Selected reminders exceed their combined protocol limit.");
        reminders.length = 0;
    }
    const selectedHint = handlerHint ?? candidates.find(candidate => candidate.tier === "hint")?.value;
    const selectedReminders = reminders[0] ? reminders[1] ? [reminders[0], reminders[1]] : [reminders[0]] : [];
    const guidance = { reminders: selectedReminders,
        ...(selectedInstruction ? { instruction: selectedInstruction } : selectedHint ? { hint: selectedHint } : {}) };
    // Complete selection and checks establish the private arbitration brand.
    const selected = { guidance, ...(conflict ? { conflict } : {}), issues, failures };
    return frozenJson(selected);
}
/** Runtime calls this after release; artifact-delivery consumes the result as-is. */
export async function assembleResponse(execution, options) {
    const { result, operation } = execution;
    const { guidance, conflict } = options.guidance;
    const failures = [
        ...(conflict ? [{ code: "KERNEL_GUIDANCE", message: "Required instructions conflict." }] : []),
        ...options.guidance.failures ?? [], ...options.secondary,
    ];
    const issues = [...(result.ok ? result.issues : result.error.issues) ?? [], ...options.guidance.issues];
    let data;
    let invalidData = false;
    try {
        const value = result.binary ? result.binary.summary : result.data;
        if (result.ok || value !== undefined)
            data = frozenJson(value);
    }
    catch {
        invalidData = true;
        failures.push({ code: "KERNEL_CONTRACT", message: "Invalid JSON response data." });
    }
    let primaryText = "";
    if (!invalidData) {
        try {
            const rendered = execution.renderPrimary();
            // Observe invalid native promises without accepting asynchronous renderers.
            if (rendered instanceof Promise)
                void rendered.catch(() => { });
            if (execution.offline) {
                // Help/version/catalog text is framework output from accepted metadata,
                // not a handler primary. Keep its labels and Unicode separators intact.
                if (typeof rendered !== "string")
                    throw new TypeError("Expected offline text.");
                assertText(rendered.replaceAll("\n", ""));
                primaryText = rendered.replace(/\n+$/, "");
            }
            else {
                assertPrimaryText(rendered);
                primaryText = rendered.trimEnd();
            }
        }
        catch {
            failures.push({ code: "KERNEL_OUTPUT", message: "Primary rendering failed." });
        }
    }
    const texts = guidance.reminders.map(value => value.text);
    const wire = { reminders: texts[0] ? texts[1] ? [texts[0], texts[1]] : [texts[0]] : [],
        ...(guidance.instruction ? { instruction: guidance.instruction.text } : guidance.hint
            ? { hint: `${guidance.hint.action}: ${renderReference(guidance.hint.invocation, options.executable)}` } : {}) };
    const payload = data !== undefined ? { payload: { kind: "inline", data } } : {};
    const first = failures[0];
    const error = !result.ok ? result.error : first ? kernelError(first.code, { message: first.message,
        ...(conflict ? { details: { conflict } } : {}) }) : undefined;
    let envelope;
    if (error) {
        const { continuation, ...primaryError } = error;
        const references = error.exitClass === "connection" ? { doctor: options.doctor } : {};
        // Registration guarantees the mandatory doctor fits on its own. A later
        // continuation cannot displace it or prevent an operation report returning.
        if (references.doctor)
            assertInvocation(references.doctor, "read");
        assertSerializedLimit(references, protocolLimits.references);
        if (continuation) {
            try {
                assertInvocation(continuation, "read");
                assertSerializedLimit({ ...references, continuation }, protocolLimits.references);
                references.continuation = continuation;
            }
            catch {
                failures.push({ code: "KERNEL_CONTRACT", message: "Continuation omitted: response references violate the combined protocol limit or shape." });
            }
        }
        assertText(error.why);
        const detail = conflict ? { details: { ...(error.details !== undefined && !result.ok ? { domain: error.details } : {}), conflict } } : {};
        const responseError = primaryError.exitClass === "connection"
            ? { ...primaryError, ...detail, ...references, doctor: options.doctor, why: error.why, issues, secondary: result.ok ? failures.slice(1) : failures }
            : { ...primaryError, ...detail, ...(references.continuation ? { continuation: references.continuation } : {}), why: error.why, issues, secondary: result.ok ? failures.slice(1) : failures };
        envelope = frozenJson({ ok: false, ...operation, ...payload, ...wire, error: responseError });
    }
    else {
        if (operation.effect !== "read" && operation.effect !== "applied" || data === undefined)
            throw new TypeError("Invalid successful operation.");
        envelope = frozenJson({ ok: true, ...operation, payload: { kind: "inline", data }, ...wire, issues });
    }
    return Object.freeze({ envelope: decodeWireEnvelope(envelope), guidance, primaryText, executable: options.executable,
        ...(result.binary ? { binary: result.binary } : {}) });
}
/** Unbounded pure projection. Only artifact delivery can turn this into RunResult. */
export function renderResponse(response, format, compactReferences = false) {
    const { envelope, executable } = response;
    const exitCode = envelope.ok ? 0 : { failed: 1, usage: 2, connection: 3, version: 4 }[envelope.error.exitClass];
    if (format === "json")
        return { stdout: `${JSON.stringify(envelope)}\n`, stderr: "", exitCode };
    const lines = [];
    if (!envelope.ok) {
        const error = envelope.error;
        lines.push(`error: ${error.code}: ${lineText(error.message)}`, `why: ${lineText(error.why)}`);
        // Shell-quoted references already preserve token boundaries. Prose escaping
        // after quoting would change allowed Unicode characters inside the tokens.
        for (const [label, reference] of [["doctor", error.doctor], ["continuation", error.continuation]]) {
            if (reference)
                lines.push(compactReferences
                    ? `${label} argv: ${JSON.stringify(referenceTokens(reference, reference.passthrough !== undefined))}`
                    : `${label}: ${renderReference(reference, executable)}`);
        }
        lines.push(`effect: ${envelope.effect}`);
        if (envelope.recovery)
            lines.push(`recovery: ${compactText(envelope.recovery)}`);
    }
    if (envelope.ok && envelope.effect === "applied") {
        lines.push(`effect: ${envelope.effect}`, `recovery: ${compactText(envelope.recovery)}`);
    }
    if (response.primaryText)
        lines.push(response.primaryText);
    const issues = envelope.ok ? envelope.issues : envelope.error.issues ?? [];
    for (const issue of issues)
        lines.push(`issue: ${issue.code}: ${lineText(issue.message)}${issue.path ? ` (${compactText(issue.path)})` : ""}`);
    if (!envelope.ok) {
        if (envelope.error.details !== undefined)
            lines.push(`details: ${compactText(envelope.error.details)}`);
        for (const secondary of envelope.error.secondary)
            lines.push(`secondary: ${secondary.code}: ${lineText(secondary.message)}`);
    }
    for (const reminder of envelope.reminders)
        lines.push(`reminder: ${lineText(reminder)}`);
    if (envelope.instruction)
        lines.push(`instruction: ${lineText(envelope.instruction)}`);
    else if (envelope.hint)
        lines.push(`hint: ${envelope.hint}`);
    const text = lines.length ? `${lines.join("\n")}\n` : "";
    return envelope.ok ? { stdout: text, stderr: "", exitCode } : { stdout: "", stderr: text, exitCode };
}
function assertPrimaryText(value) {
    if (typeof value !== "string" || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value.replaceAll("\n", ""))
        || /(?:^|\n)\s*(?:hint|reminder|instruction|error|issue|why|doctor(?: argv)?|continuation(?: argv)?|secondary|effect|recovery|details|artifact):/i.test(value)) {
        throw new TypeError("Primary text contains reserved protocol or controls.");
    }
}
/** Escape prose/JSON display fields only; never rewrite a shell invocation. */
function lineText(value) { return value.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029"); }
function compactText(value) { return lineText(JSON.stringify(value)); }
/** Deterministic fallback over already validated JSON DTOs. */
export function renderStructural(data) {
    const sorted = (value) => {
        if (Array.isArray(value))
            return value.map(sorted);
        if (value !== null && typeof value === "object") {
            return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, child]) => [key, sorted(child)]));
        }
        return value;
    };
    return lineText(JSON.stringify(sorted(frozenJson(data)), null, 2));
}
//# sourceMappingURL=response.js.map