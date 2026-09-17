import { retainEvaluationRules, evaluatedRules, captureArray, captureRecord, checkEvidence, checkGuidanceId, checkPriority, checkRule, makeReminderRule, makeSteering } from "../internal/guidance-rules.js";
import { commandData } from "../internal/declarations.js";
import { checkPath } from "../internal/input-model.js";
import { protocolLimits } from "../results.js";
import { assertFields, assertIdentifier, assertInvocation, assertNonnegativeInteger, assertRecord, assertSerializedLimit, assertText, frozenJson } from "../internal/validation.js";
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
/** Evaluate at the state authority; response assembly alone selects final tiers/conflicts. */
export async function evaluateGuidance(input) {
    const snapshot = captureRecord(input);
    assertFields(snapshot, ["command", "authority", "state"], ["rules", "eventSink"]);
    const command = snapshot["command"];
    if (command === null || typeof command !== "object")
        throw new TypeError("Expected a command token.");
    const family = commandData(command).family;
    const commandPath = command.spec.path;
    const authority = snapshot["authority"];
    checkGuidanceId(authority);
    const rules = Object.hasOwn(snapshot, "rules") ? captureArray(snapshot["rules"]) : [];
    const eventSink = snapshot["eventSink"];
    if ((rules.length > 0 || Object.hasOwn(snapshot, "eventSink")) && typeof eventSink !== "function") {
        throw new TypeError("Rules require a firing sink at their authority.");
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
        const provenance = { authority, commandPath, ruleId: rule.id,
            ...(rule.tier === "reminder" && rule.evidence !== undefined ? { evidence: rule.evidence } : {}) };
        const value = rule.tier === "reminder"
            ? { ruleId: rule.id, text: synchronousValue(() => rule.text(snapshot["state"])) }
            : synchronousValue(() => rule.render(snapshot["state"]));
        candidates.push(frozenJson({ tier: rule.tier, value, provenance,
            ...(rule.tier === "reminder" ? { priority: rule.priority } : {}) }));
        firings.push({ type: "guidance.rule_fired", commandPath, ruleId: rule.id, tier: rule.tier });
    }
    const batch = decodeEvaluatedGuidance({ authority, commandPath, candidates, firings, issues: [] });
    const issues = [];
    for (const event of batch.firings) {
        try {
            // Nonempty sources were checked above; inactive/empty sources never call a sink.
            if (typeof eventSink === "function")
                await eventSink(event);
        }
        catch {
            issues.push({ code: "KERNEL_GUIDANCE", message: "Guidance firing sink failed.", path: ["rules", event.ruleId] });
        }
    }
    const evaluated = frozenJson({ ...batch, issues });
    retainEvaluationRules(evaluated, admitted);
    return evaluated;
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
/** Validate remote candidate provenance and protocol bounds; transport owns authenticity. */
export function decodeEvaluatedGuidance(value) {
    const snapshot = frozenJson(value);
    assertRecord(snapshot);
    assertFields(snapshot, ["authority", "commandPath", "candidates", "firings", "issues"]);
    checkGuidanceId(snapshot["authority"]);
    assertText(snapshot["commandPath"]);
    checkPath(snapshot["commandPath"]);
    const candidates = snapshot["candidates"];
    const firings = snapshot["firings"];
    const issues = snapshot["issues"];
    if (!Array.isArray(candidates) || !Array.isArray(firings) || !Array.isArray(issues))
        throw new TypeError("Expected guidance batch arrays.");
    const tiers = new Map();
    for (const candidate of candidates) {
        assertRecord(candidate);
        const tier = candidate["tier"];
        if (tier !== "hint" && tier !== "instruction" && tier !== "reminder")
            throw new TypeError("Unsupported guidance tier.");
        assertFields(candidate, tier === "reminder" ? ["tier", "value", "provenance", "priority"] : ["tier", "value", "provenance"]);
        const provenance = candidate["provenance"];
        assertRecord(provenance);
        assertFields(provenance, ["authority", "commandPath", "ruleId"], ["evidence"]);
        checkGuidanceId(provenance["ruleId"]);
        if (provenance["authority"] !== snapshot["authority"] || provenance["commandPath"] !== snapshot["commandPath"]) {
            throw new TypeError("Candidate provenance does not match its batch.");
        }
        if (Object.hasOwn(provenance, "evidence"))
            checkEvidence(provenance["evidence"]);
        const ruleId = provenance["ruleId"];
        if (tiers.has(ruleId))
            throw new TypeError("Duplicate candidate rule id.");
        tiers.set(ruleId, tier);
        const guidance = candidate["value"];
        assertRecord(guidance);
        if (tier === "instruction") {
            assertFields(guidance, ["ownerId", "text"]);
            assertIdentifier(guidance["ownerId"]);
            assertText(guidance["text"]);
            instruction(guidance["ownerId"], guidance["text"]);
        }
        else if (tier === "hint") {
            assertFields(guidance, ["action", "invocation"]);
            assertText(guidance["action"]);
            assertInvocation(guidance["invocation"]);
            // Transport validates structure only. Current-registry rebinding remains required.
            hint(guidance["invocation"], guidance["action"]);
        }
        else {
            assertFields(guidance, ["ruleId", "text"]);
            if (guidance["ruleId"] !== ruleId)
                throw new TypeError("Reminder rule id does not match its provenance.");
            assertText(guidance["text"]);
            checkPriority(candidate["priority"]);
            // A candidate must fit alone. Only assembly checks the selected aggregate.
            assertSerializedLimit([guidance], protocolLimits.reminders);
        }
    }
    const fired = new Set();
    for (const event of firings) {
        assertRecord(event);
        assertFields(event, ["type", "commandPath", "ruleId", "tier"]);
        checkGuidanceId(event["ruleId"]);
        if (event["type"] !== "guidance.rule_fired" || event["commandPath"] !== snapshot["commandPath"]
            || !tiers.has(event["ruleId"]) || tiers.get(event["ruleId"]) !== event["tier"] || fired.has(event["ruleId"])) {
            throw new TypeError("Firing does not match a unique candidate.");
        }
        fired.add(event["ruleId"]);
    }
    if (fired.size !== tiers.size)
        throw new TypeError("Every candidate requires a firing event.");
    for (const issue of issues) {
        assertRecord(issue);
        assertFields(issue, ["code", "message"], ["path"]);
        checkGuidanceId(issue["code"]);
        assertText(issue["message"]);
        assertSerializedLimit(issue["message"], protocolLimits.diagnosticSummary);
        if (Object.hasOwn(issue, "path")) {
            if (!Array.isArray(issue["path"]))
                throw new TypeError("Expected an issue path.");
            for (const part of issue["path"])
                if (typeof part !== "string")
                    assertNonnegativeInteger(part);
        }
    }
    // Complete ingress checks establish this brand; authenticity is transport-owned.
    retainEvaluationRules(snapshot, evaluatedRules(value));
    return snapshot;
}
//# sourceMappingURL=index.js.map