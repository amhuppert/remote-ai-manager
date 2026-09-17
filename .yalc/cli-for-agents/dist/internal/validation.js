// Only an owning constructor marks an immutable token. Internal JSON snapshots
// retain that token's origin; serialization through a real wire never carries it.
const jsonOrigins = new WeakMap();
export function retainJsonIdentity(value) { jsonOrigins.set(value, value); }
export function jsonIdentity(value) { return jsonOrigins.get(value) ?? value; }
function copyJsonIdentity(source, copy) {
    const origin = jsonOrigins.get(source);
    if (origin)
        jsonOrigins.set(copy, origin);
}
/** Shared boundary checks stay free of host capabilities and package dependencies. */
export function assertNonnegativeInteger(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("Expected a nonnegative safe integer.");
    }
}
/** Reject terminal controls and lone surrogates without changing application text. */
export function assertText(value) {
    if (typeof value !== "string" || value.trim().length === 0
        || /[\p{Cc}\p{Cs}]/u.test(value)) {
        throw new TypeError("Expected nonempty text without control characters or lone surrogates.");
    }
}
export function assertIdentifier(value) {
    assertText(value);
    if (/\s/u.test(value))
        throw new TypeError("Identifiers cannot contain whitespace.");
}
/** Shared artifact request/wire syntax; MIME tokens permit bounded parameters. */
export function assertMediaType(value) {
    // Quoted parameters allow printable ASCII except unescaped quotes/backslashes.
    if (typeof value !== "string" || value.length > 127
        || !/^[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+(?:; *[\w!#$%&'*+.^`|~-]+=(?:[\w!#$%&'*+.^`|~-]+|"(?:[ !#-\[\]-~]|\\[ -~])*"))*$/.test(value))
        throw new TypeError("Invalid artifact media type.");
}
/** Writing and remote decoding admit the same artifact metadata combinations. */
export function assertArtifactMetadata({ mediaType, format, reason, contains }) {
    assertMediaType(mediaType);
    if (!["stdout_budget_exceeded", "explicit_out", "binary_request"].includes(reason)
        || (format === "binary" ? contains !== "binary"
            : format !== "json" && format !== "text"
                || contains !== "response" && contains !== "data"))
        throw new TypeError("Invalid artifact metadata.");
}
/** Capture only checked descriptor values; never read caller properties or toJSON. */
function materializeJson(value) {
    const active = new Set();
    const copies = new Map();
    let snapshot = null;
    const pending = [{ value, assign: copy => { snapshot = copy; } }];
    while (pending.length > 0) {
        const entry = pending.pop();
        if ("complete" in entry) {
            active.delete(entry.complete);
            continue;
        }
        const current = entry.value;
        if (current === null || typeof current === "string" || typeof current === "boolean"
            || typeof current === "number" && Number.isFinite(current)) {
            entry.assign(current);
            continue;
        }
        if (typeof current !== "object")
            throw new TypeError("Expected finite JSON data.");
        if (active.has(current))
            throw new TypeError("JSON data cannot contain cycles.");
        const existing = copies.get(current);
        if (existing !== undefined) {
            entry.assign(existing);
            continue;
        }
        const array = Array.isArray(current);
        const prototype = Object.getPrototypeOf(current);
        if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
            throw new TypeError("JSON data must contain only plain objects and arrays.");
        }
        const keys = Reflect.ownKeys(current);
        const length = array ? Object.getOwnPropertyDescriptor(current, "length")?.value : 0;
        assertNonnegativeInteger(length);
        if (array && (length > 0xffffffff || keys.length !== length + 1)) {
            throw new TypeError("JSON arrays must be dense and undecorated.");
        }
        // Null prototypes keep serialization independent of inherited hooks as well.
        const copy = array ? Object.setPrototypeOf([], null) : Object.create(null);
        copyJsonIdentity(current, copy);
        copies.set(current, copy);
        active.add(current);
        entry.assign(copy);
        pending.push({ complete: current });
        for (const key of keys) {
            if (array && key === "length")
                continue;
            if (typeof key !== "string")
                throw new TypeError("JSON keys must be strings.");
            if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) {
                throw new TypeError("JSON arrays cannot contain named properties.");
            }
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (!descriptor?.enumerable || !("value" in descriptor)) {
                throw new TypeError("JSON properties must be enumerable data properties.");
            }
            // Establish key order now; child visits replace only the captured value.
            Object.defineProperty(copy, key, { value: null, enumerable: true, writable: true, configurable: true });
            pending.push({ value: descriptor.value, assign: child => {
                    Object.defineProperty(copy, key, { value: child });
                } });
        }
    }
    return snapshot;
}
/** An observation only; constructors must retain a snapshot before checking shape/size. */
export function assertJsonValue(value) {
    materializeJson(value);
}
export function serializedJson(value) {
    return stringifyJson(materializeJson(value));
}
function stringifyJson(snapshot) {
    try {
        return JSON.stringify(snapshot);
    }
    catch {
        throw new TypeError("JSON data could not be serialized.");
    }
}
/** Count the actual JSON representation, including quotes, escapes and UTF-8 expansion. */
export function assertSerializedLimit(value, limit) {
    assertNonnegativeInteger(limit);
    if (new TextEncoder().encode(serializedJson(value)).byteLength > limit) {
        throw new TypeError("Serialized JSON exceeds its byte limit.");
    }
}
/** Capture once before domain/size checks; return the same snapshot after those checks. */
export function frozenJson(value) {
    const captured = materializeJson(value);
    const snapshot = JSON.parse(stringifyJson(captured));
    const pending = [[captured, snapshot]];
    while (pending.length > 0) {
        const [source, current] = pending.pop();
        if (current !== null && typeof current === "object") {
            // Both sides are already descriptor-checked JSON, never caller objects.
            const original = source;
            copyJsonIdentity(original, current);
            for (const [key, child] of Object.entries(current))
                pending.push([original[key], child]);
            Object.freeze(current);
        }
    }
    return snapshot;
}
export function assertRecord(value) {
    assertJsonValue(value);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("Expected a plain record.");
    }
}
export function assertFields(value, required, optional = []) {
    if (required.some(key => !Object.hasOwn(value, key))
        || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
        throw new TypeError("Record fields do not match the contract.");
    }
}
/** Shape only: registry/delivery still owns membership, runnable inputs and secret checks. */
export function assertInvocation(value, effect) {
    assertRecord(value);
    assertFields(value, ["path", "effects", "args", "flags"], ["passthrough"]);
    assertText(value["path"]);
    if (value["path"].split(" ").some(part => !part || /\s/u.test(part))) {
        throw new TypeError("Expected a space-separated command path.");
    }
    if ((value["effects"] !== "read" && value["effects"] !== "write")
        || (effect !== undefined && value["effects"] !== effect)) {
        throw new TypeError("Invalid invocation effect.");
    }
    for (const key of ["args", "passthrough"]) {
        if (key === "passthrough" && !Object.hasOwn(value, key))
            continue;
        const tokens = value[key];
        if (!Array.isArray(tokens) || tokens.some(token => typeof token !== "string" || /[\p{Cc}\p{Cs}]/u.test(token))) {
            throw new TypeError("Expected invocation string tokens without control characters.");
        }
    }
    const flags = value["flags"];
    assertRecord(flags);
    for (const [key, flag] of Object.entries(flags)) {
        assertIdentifier(key);
        const scalar = (item) => typeof item === "number" && Number.isFinite(item)
            || typeof item === "string" && !/[\p{Cc}\p{Cs}]/u.test(item);
        if (!(typeof flag === "boolean" || scalar(flag) || Array.isArray(flag) && flag.every(scalar))) {
            throw new TypeError("Invalid invocation flag value.");
        }
    }
}
//# sourceMappingURL=validation.js.map