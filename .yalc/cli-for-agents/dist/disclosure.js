import { makeBinaryRequest } from "./internal/binary.js";
import { assertFields, assertInvocation, assertRecord, frozenJson } from "./internal/validation.js";
import { count } from "./values.js";
/** Accepts an already-paged source; it never loads an entire dataset to slice it. */
export function page(source) {
    const snapshot = frozenJson(source);
    assertRecord(snapshot);
    if (typeof snapshot.more !== "boolean")
        throw new TypeError("Page more must be boolean.");
    assertFields(snapshot, ["items", "total", "more", ...(snapshot.more ? ["reveal"] : [])]);
    if (!Array.isArray(snapshot.items))
        throw new TypeError("Page items must be an already-paged array.");
    const returned = count(snapshot.items.length);
    assertRecord(snapshot.total);
    if (snapshot.total.kind === "known") {
        assertFields(snapshot.total, ["kind", "count"]);
        const total = count(snapshot.total.count);
        if (total < returned || snapshot.more && total === returned) {
            throw new TypeError("Page total contradicts the returned count or more marker.");
        }
    }
    else if (snapshot.total.kind === "unknown") {
        assertFields(snapshot.total, ["kind"]);
    }
    else {
        throw new TypeError("Invalid page total kind.");
    }
    let omission;
    if (snapshot.more) {
        assertInvocation(snapshot.reveal, "read");
        omission = { truncated: true, returned, total: snapshot.total, reveal: snapshot.reveal };
    }
    else {
        omission = { truncated: false, returned, total: snapshot.total };
    }
    return Object.freeze({ items: snapshot.items, omission: Object.freeze(omission) });
}
export function binaryArtifact(request) { return makeBinaryRequest(request); }
//# sourceMappingURL=disclosure.js.map