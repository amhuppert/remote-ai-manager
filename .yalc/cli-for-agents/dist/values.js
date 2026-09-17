import { assertIdentifier, assertNonnegativeInteger } from "./internal/validation.js";
/** Validate a nonnegative safe integer; these units cannot substitute for each other. */
export function bytes(value) {
    assertNonnegativeInteger(value);
    return (value === 0 ? 0 : value);
}
export function count(value) {
    assertNonnegativeInteger(value);
    return (value === 0 ? 0 : value);
}
export function milliseconds(value) {
    assertNonnegativeInteger(value);
    return (value === 0 ? 0 : value);
}
/** Nonempty domain/text without whitespace or controls; application syntax is caller-owned. */
export function id(domain, value) {
    assertIdentifier(domain);
    assertIdentifier(value);
    return value;
}
/** Source-private ingress for host digests; no caller cast can mint a valid hash. */
export function checkedSha256(value) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
        throw new TypeError("Expected a SHA-256 hex digest.");
    return value;
}
//# sourceMappingURL=values.js.map