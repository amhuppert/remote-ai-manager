import path from "node:path";
import picomatch from "picomatch";

/**
 * A repository path a test touched outside its import graph. `path` is POSIX
 * and relative to the repository root; the root itself is the empty string.
 */
export interface RecordedRead {
  readonly path: string;
  readonly kind: "file" | "directory";
  /** The API that performed the read, e.g. `readFileSync` or `spawn:bash`. */
  readonly via: string;
  /** A directory listing that enumerated every descendant (`readdir` with `recursive`). */
  readonly recursive?: boolean;
}

const DIRECTIVE_PATTERN = /^\/\/ @vitest-inputs(.*)$/gm;
const MATCH_OPTIONS = { dot: true } as const;

/** Filesystem APIs that reveal an entry's existence or type, never its content. */
const PROBE_READ_APIS: ReadonlySet<string> = new Set([
  "statSync",
  "lstatSync",
  "existsSync",
  "accessSync",
  "stat",
  "lstat",
  "access",
]);

export function isProbeRead(via: string): boolean {
  return PROBE_READ_APIS.has(via);
}

/**
 * The globs a test declares with `// @vitest-inputs <glob> [<glob>...]`, one
 * or more lines. Every glob is relative to the repository root; changed
 * validation selects the test whenever a changed path matches one of them.
 */
export function parseDeclaredInputs(source: string): string[] {
  const globs = new Set<string>();
  for (const match of source.matchAll(DIRECTIVE_PATTERN)) {
    const tokens = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      throw new Error("`// @vitest-inputs` directive declares no paths");
    }
    for (const glob of tokens) {
      const reason = rejectGlob(glob);
      if (reason !== undefined) {
        throw new Error(`\`// @vitest-inputs ${glob}\` ${reason}`);
      }
      globs.add(glob);
    }
  }
  return [...globs].sort();
}

function rejectGlob(glob: string): string | undefined {
  if (glob.startsWith("/")) return "must be relative to the repository root";
  if (glob.includes("\\")) return "must use forward slashes";
  if (glob.endsWith("/")) {
    return "must not end with a slash; declare a directory's contents as `dir/**`";
  }
  if (glob.split("/").some((segment) => segment === "." || segment === "..")) {
    return "must not contain `.` or `..` segments";
  }
  return undefined;
}

function fileMatcher(globs: readonly string[]): (filePath: string) => boolean {
  if (globs.length === 0) return () => false;
  return picomatch([...globs], MATCH_OPTIONS);
}

/**
 * A directory listing is an input of whatever the test finds under it, so it
 * is covered when a declared glob's literal base lies on the walk through that
 * directory: the glob is anchored inside it, or the directory sits inside the
 * glob's base. A glob with no literal base (`**‌/*.ts`) covers every directory.
 */
function directoryCovered(
  directory: string,
  globs: readonly string[],
): boolean {
  if (directory === "") return globs.length > 0;
  return globs.some((glob) => {
    const { base } = picomatch.scan(glob);
    return (
      base === "" ||
      base === directory ||
      base.startsWith(`${directory}/`) ||
      directory.startsWith(`${base}/`)
    );
  });
}

/**
 * A content read must match a declared glob. A directory listing is covered by
 * the directory rule, and so is a type probe of an entry inside a directory the
 * test listed itself: a walker that stats each entry to find subdirectories
 * learns nothing more from that entry than the listing already revealed. A
 * probe of a path whose directory the test never listed is a targeted
 * existence check and must match a glob like any other file read.
 */
export function findUndeclaredReads(
  reads: readonly RecordedRead[],
  declared: readonly string[],
): RecordedRead[] {
  const matchesFile = fileMatcher(declared);
  const listings = reads.filter((read) => read.kind === "directory");
  const listedParentOf = (filePath: string): string | undefined => {
    const parent = path.posix.dirname(filePath);
    const directory = parent === "." ? "" : parent;
    return listings.find(
      (listing) =>
        listing.path === directory ||
        (listing.recursive === true &&
          (listing.path === "" || directory.startsWith(`${listing.path}/`))),
    )?.path;
  };
  const isCovered = (read: RecordedRead): boolean => {
    if (read.kind === "directory") return directoryCovered(read.path, declared);
    if (matchesFile(read.path)) return true;
    if (!isProbeRead(read.via)) return false;
    const listedParent = listedParentOf(read.path);
    return (
      listedParent !== undefined && directoryCovered(listedParent, declared)
    );
  };
  return reads.filter((read) => !isCovered(read));
}

interface ReadGroup {
  readonly key: string;
  count: number;
  readonly example: RecordedRead;
}

const MAX_DESCRIBED_GROUPS = 40;

/**
 * Groups deep file reads by their first two path segments and extension so a
 * scanner that read a thousand files shows up as one glob-shaped line an author
 * can declare, while shallow paths and directories stay exact.
 */
function groupKey(read: RecordedRead): string {
  if (read.kind === "directory") return read.path === "" ? "." : read.path;
  const segments = read.path.split("/");
  if (segments.length < 3) return read.path;
  return `${segments[0]}/${segments[1]}/**/*${path.posix.extname(read.path)}`;
}

export function describeUndeclaredReads(
  testFile: string,
  reads: readonly RecordedRead[],
  declared: readonly string[],
): string {
  const groups = new Map<string, ReadGroup>();
  for (const read of reads) {
    const key = groupKey(read);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { key, count: 1, example: read });
  }
  const ranked = [...groups.values()].sort(
    (left, right) =>
      right.count - left.count || left.key.localeCompare(right.key),
  );
  const lines = ranked.slice(0, MAX_DESCRIBED_GROUPS).map((group) => {
    const { example } = group;
    if (example.kind === "directory") {
      return `  ${group.key} (directory; via ${example.via})`;
    }
    const detail =
      group.count > 1
        ? `${group.count} files, e.g. ${example.path}; via ${example.via}`
        : group.key === example.path
          ? `via ${example.via}`
          : `e.g. ${example.path}; via ${example.via}`;
    return `  ${group.key} (${detail})`;
  });
  if (ranked.length > MAX_DESCRIBED_GROUPS) {
    lines.push(`  … and ${ranked.length - MAX_DESCRIBED_GROUPS} more groups`);
  }
  return [
    `${testFile} read ${reads.length} repository path(s) outside its import graph that no \`// @vitest-inputs\` directive declares.`,
    "Declare them as globs relative to the repository root so changed validation selects this test when they change:",
    ...lines,
    `Declared: ${declared.length > 0 ? declared.join(" ") : "(none)"}`,
  ].join("\n");
}

/**
 * The tests whose declared inputs match a changed repository path. Changed
 * paths may be added, modified, or deleted files; a deleted route or script is
 * as much a change to a scanner's inventory as a new one.
 */
export function selectTestsForChangedPaths(
  declaredInputsByTestFile: Readonly<Record<string, readonly string[]>>,
  changedPaths: readonly string[],
): string[] {
  const selected: string[] = [];
  for (const [testFile, globs] of Object.entries(declaredInputsByTestFile)) {
    const matches = fileMatcher(globs);
    if (changedPaths.some((changedPath) => matches(changedPath))) {
      selected.push(testFile);
    }
  }
  return selected.sort();
}

export interface StaleDeclaredInput {
  readonly testFile: string;
  readonly glob: string;
}

/**
 * Declared globs that match no repository file: the input moved or was
 * deleted, so the declaration no longer selects anything and should follow it.
 * A literal path is exempt because a test may declare a path whose absence it
 * asserts, and the tracer still fails the test if the paths it reads change.
 */
export function findStaleDeclaredInputs(
  declaredInputsByTestFile: Readonly<Record<string, readonly string[]>>,
  repositoryFiles: readonly string[],
): StaleDeclaredInput[] {
  const stale: StaleDeclaredInput[] = [];
  for (const [testFile, globs] of Object.entries(declaredInputsByTestFile)) {
    for (const glob of globs) {
      if (!picomatch.scan(glob).isGlob) continue;
      const matches = picomatch(glob, MATCH_OPTIONS);
      if (!repositoryFiles.some((file) => matches(file))) {
        stale.push({ testFile, glob });
      }
    }
  }
  return stale;
}
