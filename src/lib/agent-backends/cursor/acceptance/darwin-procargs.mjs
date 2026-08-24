// Dumps a same-uid process's raw KERN_PROCARGS2 buffer to stdout — darwin's
// equivalent of /proc/<pid>/cmdline + /proc/<pid>/environ, with the exact
// NUL-delimited records the credential scan needs (`ps -E` flattens them).
//
// Runs under `bun` only: `bun:ffi` is how the sysctl syscall is reachable
// without a native module. Plain JavaScript on purpose, so neither tsc nor
// vitest ever loads it — `credential-scan.ts` executes it as a child process
// and parses the bytes with `parseDarwinProcargs2`.
//
// Exit codes: 2 usage, 3 the process is gone or its arguments are protected.
import { dlopen, FFIType, ptr } from "bun:ffi";

const pid = Number(process.argv[2]);
if (!Number.isInteger(pid) || pid <= 0) process.exit(2);

const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  sysctl: {
    args: [
      FFIType.ptr,
      FFIType.u32,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.u64,
    ],
    returns: FFIType.i32,
  },
});

const CTL_KERN = 1;
const KERN_PROCARGS2 = 49;
const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);

const size = new BigUint64Array([0n]);
if (libc.symbols.sysctl(ptr(mib), 3, null, ptr(size), null, 0n) !== 0) {
  process.exit(3);
}
const buffer = new Uint8Array(Number(size[0]));
if (libc.symbols.sysctl(ptr(mib), 3, ptr(buffer), ptr(size), null, 0n) !== 0) {
  process.exit(3);
}
process.stdout.write(Buffer.from(buffer.subarray(0, Number(size[0]))));
