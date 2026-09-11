import path from "node:path";

// The validation launcher hands its `paths` filters to the Vitest config
// through this variable so each project's explicit include list can be
// narrowed before Vitest globs it. The unit projects list every test file
// literally (about 2,000 entries), and tinyglobby matches every entry
// against the crawl, so an un-narrowed single-file run spends over a second
// finding nothing in the projects that do not own the file.
export const TEST_PATH_FILTERS_ENV = "CC_TEST_PATH_FILTERS";

export function readTestPathFilters(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const raw = env[TEST_PATH_FILTERS_ENV];
  if (raw === undefined || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${TEST_PATH_FILTERS_ENV} must be a JSON array of strings`);
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`${TEST_PATH_FILTERS_ENV} must be a JSON array of strings`);
  }
  return parsed;
}

// Mirrors Vitest's `filterFiles` (TestProject, vitest/node) so the narrowed
// include selects exactly the files Vitest's own filter would keep: an
// absolute filter is a path prefix, anything else is a case-insensitive
// substring of the repository-relative path, with a trailing slash kept so a
// directory filter cannot match a longer directory name.
export function narrowTestFilesToFilters(
  files: readonly string[],
  filters: readonly string[],
  rootDir: string,
): readonly string[] {
  if (filters.length === 0) return files;
  return files.filter((file) => {
    const absolute = path.resolve(rootDir, file);
    const relative = path.relative(rootDir, absolute).toLocaleLowerCase();
    return filters.some((filter) => {
      if (path.isAbsolute(filter) && absolute.startsWith(filter)) return true;
      const relativeFilter = filter.endsWith("/")
        ? path.join(path.relative(rootDir, filter), "/")
        : path.relative(rootDir, filter);
      return (
        relative.includes(filter.toLocaleLowerCase()) ||
        relative.includes(relativeFilter.toLocaleLowerCase())
      );
    });
  });
}
