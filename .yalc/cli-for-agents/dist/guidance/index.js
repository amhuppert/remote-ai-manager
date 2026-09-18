import { captureArray, captureRecord, checkRule, makeReminderRule, makeSteering } from "../internal/guidance-rules.js";
import { commandData } from "../internal/declarations.js";
import { protocolLimits } from "../results.js";
import { assertFields, assertIdentifier, assertInvocation, assertSerializedLimit, assertText, frozenJson } from "../internal/validation.js";
export function hint(invocation, action) {
    const value = frozenJson({ invocation, action });
    assertInvocation(value.invocation);
    assertText(value.action);
    assertSerializedLimit(value.action, protocolLimits.diagnosticSummary);
    assertSerializedLimit({ invocation: value.invocation }, protocolLimits.references);
    return value;
}
export function instruction(ownerId, text) {
    assertIdentifier(ownerId);
    assertText(text);
    const value = { ownerId, text };
    assertSerializedLimit(value, protocolLimits.instruction);
    return frozenJson(value);
}
/** Defines a rule, not a reminder; handlers receive no constructor for emitted reminders. */
export function defineReminderRule(definition) {
    return makeReminderRule(definition);
}
export function defineSteering(definition) {
    return makeSteering(definition);
}
/** Evaluate rules in the CLI process; response assembly alone selects final tiers/conflicts. */
export async function evaluateGuidance(input) {
    const snapshot = captureRecord(input);
    assertFields(snapshot, ["command", "state"], ["rules", "eventSink"]);
    const command = snapshot["command"];
    if (command === null || typeof command !== "object")
        throw new TypeError("Expected a command token.");
    const family = commandData(command).family;
    const commandPath = command.spec.path;
    const rules = Object.hasOwn(snapshot, "rules") ? captureArray(snapshot["rules"]) : [];
    const eventSink = snapshot["eventSink"];
    if ((rules.length > 0 || Object.hasOwn(snapshot, "eventSink")) && typeof eventSink !== "function") {
        throw new TypeError("Rules require a firing sink.");
    }
    // Admit the whole source before executing any application callback.
    const admitted = [];
    const ids = new Set();
    for (const rule of rules) {
        checkRule(rule);
        if (ids.has(rule.id))
            throw new TypeError("Duplicate rule id.");
        ids.add(rule.id);
        if (rule.appliesTo.some(target => commandData(target).family !== family)) {
            throw new TypeError("Rule references a foreign command family.");
        }
        admitted.push(rule);
    }
    const candidates = [];
    const firings = [];
    // Finish synchronous state observation before awaiting sinks, which may change state.
    for (const rule of admitted) {
        if (!rule.appliesTo.includes(command))
            continue;
        const active = synchronousValue(() => rule.when(snapshot["state"]));
        if (typeof active !== "boolean")
            throw new TypeError("Rule predicates must return a boolean synchronously.");
        if (!active)
            continue;
        const provenance = { commandPath, ruleId: rule.id,
            ...(rule.tier === "reminder" && rule.evidence !== undefined ? { evidence: rule.evidence } : {}) };
        const rendered = synchronousValue(() => rule.tier === "reminder" ? rule.text(snapshot["state"]) : rule.render(snapshot["state"]));
        candidates.push(candidate(rule, rendered, provenance));
        firings.push(Object.freeze({ type: "guidance.rule_fired", commandPath, ruleId: rule.id, tier: rule.tier }));
    }
    const issues = [];
    for (const event of firings) {
        try {
            // Nonempty sources were checked above; inactive/empty sources never call a sink.
            if (typeof eventSink === "function")
                await eventSink(event);
        }
        catch {
            issues.push({ code: "KERNEL_GUIDANCE", message: "Guidance firing sink failed.", path: ["rules", event.ruleId] });
        }
    }
    const batch = { commandPath, candidates, firings, issues };
    return frozenJson(batch);
}
/** Rendered values are rebuilt through the bounded constructors before they are retained. */
function candidate(rule, rendered, provenance) {
    if (rule.tier === "reminder") {
        assertText(rendered);
        const value = { ruleId: rule.id, text: rendered };
        // A candidate must fit alone. Only assembly checks the selected aggregate.
        assertSerializedLimit([value], protocolLimits.reminders);
        return frozenJson({ tier: "reminder", value: value, provenance, priority: rule.priority });
    }
    const record = captureRecord(rendered);
    if (rule.tier === "instruction") {
        assertFields(record, ["ownerId", "text"]);
        return frozenJson({ tier: "instruction", value: instruction(record["ownerId"], record["text"]), provenance });
    }
    assertFields(record, ["action", "invocation"]);
    return frozenJson({ tier: "hint", value: hint(record["invocation"], record["action"]), provenance });
}
function synchronousValue(call) {
    try {
        const value = call();
        if (value instanceof Promise) {
            // Observe a rejected native promise without awaiting an invalid async callback.
            void Promise.prototype.then.call(value, undefined, () => { });
            throw new TypeError("Rule callbacks must return synchronously.");
        }
        return value;
    }
    catch {
        throw new TypeError("Guidance rule callback failed or returned asynchronously.");
    }
}
//# sourceMappingURL=index.js.map