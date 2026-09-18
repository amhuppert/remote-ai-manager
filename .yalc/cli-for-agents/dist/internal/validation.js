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
/** JSON is the only data the kernel carries across a boundary: plain objects and
 * arrays holding finite numbers, strings, booleans and null. Values that
 * JSON.stringify would drop or rewrite silently (undefined, functions, NaN,
 * holes, class instances) are caller bugs and fail here instead. */
function replacer(key, value) {
    const raw = this[key];
    if (raw === undefined || typeof raw === "function" || typeof raw === "symbol" || typeof raw === "bigint"
        || typeof raw === "number" && !Number.isFinite(raw))
        throw new TypeError("Expected finite JSON data.");
    if (raw !== null && typeof raw === "object") {
        if (Array.isArray(raw)) {
            if (Object.keys(raw).length !== raw.length)
                throw new TypeError("JSON arrays must be dense and undecorated.");
        }
        else {
            const prototype = Object.getPrototypeOf(raw);
            if (prototype !== Object.prototype && prototype !== null)
                throw new TypeError("JSON data must contain only plain objects and arrays.");
        }
    }
    return value;
}
export function serializedJson(value) {
    let text;
    try {
        text = JSON.stringify(value, replacer);
    }
    catch (error) {
        throw error instanceof TypeError ? error : new TypeError("JSON data could not be serialized.");
    }
    if (text === undefined)
        throw new TypeError("Expected finite JSON data.");
    return text;
}
/** An observation only; constructors must retain a snapshot before checking shape/size. */
export function assertJsonValue(value) {
    serializedJson(value);
}
/** Count the actual JSON representation, including quotes, escapes and UTF-8 expansion. */
export function assertSerializedLimit(value, limit) {
    assertNonnegativeInteger(limit);
    if (new TextEncoder().encode(serializedJson(value)).byteLength > limit) {
        throw new TypeError("Serialized JSON exceeds its byte limit.");
    }
}
/** Detach and deep-freeze: the caller keeps its object, the kernel keeps a JSON copy. */
export function frozenJson(value) {
    const snapshot = JSON.parse(serializedJson(value));
    const pending = [snapshot];
    while (pending.length > 0) {
        const current = pending.pop();
        if (current !== null && typeof current === "object") {
            Object.freeze(current);
            for (const key of Object.keys(current))
                pending.push(current[key]);
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