import { assertArtifactMetadata, assertFields, assertIdentifier, assertInvocation, assertNonnegativeInteger, assertRecord, assertSerializedLimit, assertText, frozenJson } from "./internal/validation.js";
import { checkedSha256 } from "./values.js";
/** Canonical finite kernel catalog: every owner imports this table, never a sibling map. */
export const kernelErrors = frozenJson({
    KERNEL_USAGE: { exitClass: "usage", description: "The invocation does not match the declared CLI contract." },
    KERNEL_CONTRACT: { exitClass: "failed", description: "An application or protocol value violated its declared contract." },
    KERNEL_INPUT: { exitClass: "usage", description: "Local file, JSON or schema input could not be validated." },
    KERNEL_CANCELLED: { exitClass: "failed", description: "The operation was cancelled." },
    KERNEL_HANDLER: { exitClass: "failed", description: "The handler did not return an acknowledged outcome." },
    KERNEL_CONTEXT: { exitClass: "connection", description: "The required application context could not be acquired." },
    KERNEL_GUIDANCE: { exitClass: "failed", description: "Required guidance conflicted or could not be collected." },
    KERNEL_OUTPUT: { exitClass: "failed", description: "The bounded response could not be rendered or delivered." },
    KERNEL_RELEASE: { exitClass: "failed", description: "The application context could not be released." },
});
/** Serialized UTF-8 JSON limits. Constructors/ingress reject mandatory overflow. */
export const protocolLimits = Object.freeze({
    defaultOutput: 32768, minimumOutput: 8192, instruction: 1024,
    reminders: 1024, recovery: 1024, references: 1024, manifest: 2048,
    diagnosticSummary: 512,
});
export function defineErrors(definitions) {
    const snapshot = frozenJson(definitions);
    assertRecord(snapshot);
    for (const [code, definition] of Object.entries(snapshot)) {
        assertIdentifier(code);
        assertSummary(code);
        if (Object.hasOwn(kernelErrors, code))
            throw new TypeError("Domain catalogs cannot redefine kernel codes.");
        assertRecord(definition);
        assertFields(definition, ["exitClass", "description"]);
        if (!["failed", "usage", "connection", "version"].includes(definition.exitClass)) {
            throw new TypeError("Invalid catalog exit class.");
        }
        assertSummary(definition.description);
    }
    const error = (code, options) => {
        if (typeof code !== "string" || !Object.hasOwn(snapshot, code))
            throw new TypeError("Unknown domain error code.");
        return catalogError(snapshot, code, options);
    };
    return Object.freeze({ definitions: snapshot, error });
}
/** Private package seam: all kernel failures share the catalog constructor. */
export function kernelError(code, options) {
    return catalogError(kernelErrors, code, options);
}
function catalogError(definitions, code, options) {
    if (!Object.hasOwn(definitions, code))
        throw new TypeError("Unknown error code.");
    const checked = frozenJson(options);
    assertRecord(checked);
    assertFields(checked, ["message"], ["why", "issues", "details", "continuation"]);
    assertSummary(checked.message);
    if (Object.hasOwn(checked, "why"))
        assertSummary(checked.why);
    if (Object.hasOwn(checked, "issues"))
        assertIssues(checked.issues);
    if (Object.hasOwn(checked, "continuation")) {
        assertInvocation(checked.continuation, "read");
        assertSerializedLimit({ continuation: checked.continuation }, protocolLimits.references);
    }
    const definition = definitions[code];
    // The canonical checked owner establishes code/class correlation for both catalogs.
    return Object.freeze({ ...checked, code, exitClass: definition.exitClass,
        why: checked.why ?? definition.description });
}
/** Validate an erased report against its bound catalog before restoring an error brand. */
export function checkedError(value, catalog) {
    const snapshot = frozenJson(value);
    assertRecord(snapshot);
    assertFields(snapshot, ["code", "exitClass", "message"], ["why", "issues", "details", "continuation"]);
    const code = snapshot["code"];
    if (typeof code !== "string")
        throw new TypeError("Expected an error code.");
    const definitions = Object.hasOwn(kernelErrors, code) ? kernelErrors : catalog.definitions;
    if (!Object.hasOwn(definitions, code) || definitions[code]?.exitClass !== snapshot["exitClass"])
        throw new TypeError("Foreign code or mismatched exit class.");
    const { code: _code, exitClass: _class, ...options } = snapshot;
    // Shape and all option values are checked by the sole catalog constructor.
    return catalogError(definitions, code, options);
}
/** Private constructor: execution supplies only a provenance-checked registered path. */
export function unknownAcknowledgmentFact(commandPath, payloadHash) {
    assertText(commandPath);
    if (commandPath.split(" ").some(part => !part || /\s/u.test(part)))
        throw new TypeError("Invalid command path.");
    if (payloadHash !== undefined)
        checkedSha256(payloadHash);
    const fact = frozenJson({ kind: "unknown_acknowledgment", commandPath,
        ...(payloadHash === undefined ? {} : { payloadHash }), advice: "inspect_before_retry" });
    assertSerializedLimit(fact, protocolLimits.recovery);
    return fact;
}
function assertSummary(value) {
    assertText(value);
    assertSerializedLimit(value, protocolLimits.diagnosticSummary);
}
function assertIssues(value) {
    if (!Array.isArray(value))
        throw new TypeError("Expected an issue list.");
    for (const issue of value) {
        assertRecord(issue);
        assertFields(issue, ["code", "message"], ["path"]);
        assertIdentifier(issue["code"]);
        assertSummary(issue["code"]);
        assertSummary(issue["message"]);
        if (Object.hasOwn(issue, "path")) {
            const path = issue["path"];
            if (!Array.isArray(path))
                throw new TypeError("Expected an issue path.");
            for (const part of path) {
                if (typeof part !== "string")
                    assertNonnegativeInteger(part);
            }
        }
    }
}
/** Validate serialized size <= protocolLimits.recovery before branding. */
export function recoveryFacts(references) {
    const facts = frozenJson({ kind: "reported", references });
    if (!Array.isArray(facts.references) || facts.references.length === 0)
        throw new TypeError("Recovery requires reported references.");
    for (const reference of facts.references) {
        assertRecord(reference);
        assertFields(reference, ["kind", "id"]);
        assertIdentifier(reference["kind"]);
        assertIdentifier(reference["id"]);
    }
    assertSerializedLimit(facts, protocolLimits.recovery);
    return facts;
}
/** Wire admission validates shape and bounds, not registry or filesystem authority. */
export function decodeWireEnvelope(value) {
    const envelope = frozenJson(value);
    assertRecord(envelope);
    const ok = envelope["ok"];
    if (typeof ok !== "boolean")
        throw new TypeError("Expected envelope status.");
    assertFields(envelope, ["ok", "effect", "reminders", ...(ok ? ["payload", "issues"] : ["error"])], ["recovery", "hint", "instruction", ...(!ok ? ["payload"] : [])]);
    const effect = envelope["effect"];
    if (effect === "read" || effect === "not_applied") {
        if (Object.hasOwn(envelope, "recovery") || ok && effect !== "read")
            throw new TypeError("Invalid effect recovery.");
    }
    else if (effect === "applied" || effect === "unknown") {
        if (ok && effect === "unknown")
            throw new TypeError("Success requires an acknowledged effect.");
        const recovery = envelope["recovery"];
        assertRecord(recovery);
        if (recovery["kind"] === "reported") {
            assertFields(recovery, ["kind", "references"]);
            const references = recovery["references"];
            if (!Array.isArray(references) || references.length === 0)
                throw new TypeError("Expected reported references.");
            const checked = references.map((reference) => {
                assertRecord(reference);
                assertFields(reference, ["kind", "id"]);
                const kind = reference["kind"], id = reference["id"];
                assertIdentifier(kind);
                assertIdentifier(id);
                return { kind, id };
            });
            const [first, ...rest] = checked;
            if (!first)
                throw new TypeError("Expected reported references.");
            recoveryFacts([first, ...rest]);
        }
        else if (recovery["kind"] === "unknown_acknowledgment" && effect === "unknown") {
            assertFields(recovery, ["kind", "commandPath", "advice"], ["payloadHash"]);
            const path = recovery["commandPath"];
            assertText(path);
            if (path.split(" ").some(part => !part || /\s/u.test(part))
                || recovery["advice"] !== "inspect_before_retry")
                throw new TypeError("Invalid acknowledgment recovery.");
            if (Object.hasOwn(recovery, "payloadHash"))
                assertWireHash(recovery["payloadHash"]);
        }
        else
            throw new TypeError("Invalid recovery kind.");
        assertSerializedLimit(recovery, protocolLimits.recovery);
    }
    else
        throw new TypeError("Invalid operation effect.");
    const reminders = envelope["reminders"];
    if (!Array.isArray(reminders) || reminders.length > 2 || new Set(reminders).size !== reminders.length) {
        throw new TypeError("Expected at most two distinct reminders.");
    }
    for (const reminder of reminders)
        assertText(reminder);
    assertSerializedLimit(reminders, protocolLimits.reminders);
    if (Object.hasOwn(envelope, "instruction")) {
        if (Object.hasOwn(envelope, "hint"))
            throw new TypeError("Instruction suppresses hint.");
        assertText(envelope["instruction"]);
        assertSerializedLimit(envelope["instruction"], protocolLimits.instruction);
    }
    if (Object.hasOwn(envelope, "hint"))
        assertText(envelope["hint"]);
    if (Object.hasOwn(envelope, "payload")) {
        const payload = envelope["payload"];
        assertRecord(payload);
        if (payload["kind"] === "inline")
            assertFields(payload, ["kind", "data"]);
        else if (payload["kind"] === "artifact") {
            assertFields(payload, ["kind", "summary", "artifact"]);
            const artifact = payload["artifact"];
            assertRecord(artifact);
            assertFields(artifact, ["path", "format", "mediaType", "bytes", "sha256", "reason", "contains"]);
            const path = artifact["path"];
            assertText(path);
            if (!path.startsWith("/") || path.split("/").some(part => part === "." || part === ".."))
                throw new TypeError("Expected an absolute artifact path.");
            assertArtifactMetadata(artifact);
            assertNonnegativeInteger(artifact["bytes"]);
            assertWireHash(artifact["sha256"]);
            assertSerializedLimit(artifact, protocolLimits.manifest);
        }
        else
            throw new TypeError("Invalid payload kind.");
    }
    if (ok)
        assertIssues(envelope["issues"]);
    else {
        const error = envelope["error"];
        assertRecord(error);
        assertFields(error, ["code", "exitClass", "message", "why", "secondary"], ["issues", "details", "doctor", "continuation"]);
        const code = error["code"];
        assertIdentifier(code);
        assertSummary(code);
        assertSummary(error["message"]);
        assertSummary(error["why"]);
        assertWireEnum(error["exitClass"], ["failed", "usage", "connection", "version"]);
        if (Object.hasOwn(kernelErrors, code) && kernelErrors[code].exitClass !== error["exitClass"])
            throw new TypeError("Kernel classification mismatch.");
        if (Object.hasOwn(error, "issues"))
            assertIssues(error["issues"]);
        const secondary = error["secondary"];
        if (!Array.isArray(secondary))
            throw new TypeError("Expected secondary failures.");
        for (const failure of secondary) {
            assertRecord(failure);
            assertFields(failure, ["code", "message"]);
            if (typeof failure["code"] !== "string" || !Object.hasOwn(kernelErrors, failure["code"]))
                throw new TypeError("Expected secondary kernel code.");
            assertSummary(failure["message"]);
        }
        if (error["exitClass"] === "connection")
            assertInvocation(error["doctor"], "read");
        else if (Object.hasOwn(error, "doctor"))
            throw new TypeError("Doctor belongs to connection failures.");
        if (Object.hasOwn(error, "continuation"))
            assertInvocation(error["continuation"], "read");
        assertSerializedLimit({ ...(Object.hasOwn(error, "doctor") ? { doctor: error["doctor"] } : {}),
            ...(Object.hasOwn(error, "continuation") ? { continuation: error["continuation"] } : {}) }, protocolLimits.references);
    }
    // Only this complete check establishes the wire brand; references remain unbound.
    return envelope;
}
function assertWireHash(value) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
        throw new TypeError("Expected a SHA256 digest.");
}
function assertWireEnum(value, choices) {
    if (typeof value !== "string" || !choices.includes(value))
        throw new TypeError("Invalid wire discriminant.");
}
//# sourceMappingURL=results.js.map