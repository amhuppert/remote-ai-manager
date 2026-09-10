import { describe, expect, it } from "vitest";
import {
  describeUndeclaredReads,
  findStaleDeclaredInputs,
  findUndeclaredReads,
  parseDeclaredInputs,
  selectTestsForChangedPaths,
  type RecordedRead,
} from "./test-inputs";

function read(
  path: string,
  kind: RecordedRead["kind"] = "file",
  via = "readFileSync",
): RecordedRead {
  return { path, kind, via };
}

describe("declared test inputs", () => {
  it("parses every @vitest-inputs directive into sorted unique globs", () => {
    const source = [
      "// @vitest-inputs src/app/**/route.ts eslint.config.mjs",
      "import { it } from 'vitest';",
      "// @vitest-inputs scripts/validate/** src/app/**/route.ts",
      "",
    ].join("\n");

    expect(parseDeclaredInputs(source)).toEqual([
      "eslint.config.mjs",
      "scripts/validate/**",
      "src/app/**/route.ts",
    ]);
  });

  it("returns no globs for a test without a directive", () => {
    expect(parseDeclaredInputs("import { it } from 'vitest';\n")).toEqual([]);
  });

  it.each([
    ["/src/**", "absolute"],
    ["../other/**", "parent"],
    ["./src/**", "dot-relative"],
    ["src\\lib\\**", "backslash"],
    ["src/lib/", "trailing slash"],
  ])("rejects the %s declaration (%s)", (glob) => {
    expect(() => parseDeclaredInputs(`// @vitest-inputs ${glob}\n`)).toThrow(
      /@vitest-inputs/,
    );
  });

  it("rejects an empty directive", () => {
    expect(() => parseDeclaredInputs("// @vitest-inputs\n")).toThrow(
      /@vitest-inputs/,
    );
  });
});

describe("undeclared reads", () => {
  const declared = ["src/app/**/route.ts", "eslint.config.mjs"];

  it("accepts file reads matched by a declared glob, including dotfiles", () => {
    expect(
      findUndeclaredReads(
        [
          read("src/app/api/foo/route.ts"),
          read("src/app/.hidden/route.ts"),
          read("eslint.config.mjs"),
        ],
        declared,
      ),
    ).toEqual([]);
  });

  it("reports file reads outside every declared glob", () => {
    const undeclared = read("src/lib/config/loader.ts");
    expect(
      findUndeclaredReads(
        [read("src/app/api/foo/route.ts"), undeclared],
        declared,
      ),
    ).toEqual([undeclared]);
  });

  it("accepts directory listings on the way to, or inside, a declared glob base", () => {
    expect(
      findUndeclaredReads(
        [
          read("", "directory", "readdirSync"),
          read("src", "directory", "readdirSync"),
          read("src/app", "directory", "readdirSync"),
          read("src/app/api/foo", "directory", "readdirSync"),
        ],
        declared,
      ),
    ).toEqual([]);
  });

  it("reports directory listings unrelated to every declared glob", () => {
    const undeclared = read("scripts/validate", "directory", "readdirSync");
    expect(findUndeclaredReads([undeclared], declared)).toEqual([undeclared]);
  });

  it("accepts type probes of entries inside a directory the test listed", () => {
    expect(
      findUndeclaredReads(
        [
          read("src/features", "directory", "readdirSync"),
          read("src/features/theme.css", "file", "statSync"),
          read("src/features/fonts.woff2", "file", "existsSync"),
        ],
        ["src/**/*.ts"],
      ),
    ).toEqual([]);
  });

  it("accepts probes anywhere beneath a recursive listing", () => {
    expect(
      findUndeclaredReads(
        [
          {
            path: "src",
            kind: "directory",
            via: "readdirSync",
            recursive: true,
          },
          read("src/features/styles/theme.css", "file", "statSync"),
        ],
        ["src/**/*.tsx"],
      ),
    ).toEqual([]);
  });

  it("reports targeted probes of paths whose directory the test never listed", () => {
    const probe = read("src/features/theme.css", "file", "existsSync");
    expect(findUndeclaredReads([probe], ["src/**/*.ts"])).toEqual([probe]);
  });

  it("reports content reads of listed entries that match no glob", () => {
    const content = read("src/features/theme.css", "file", "readFileSync");
    expect(
      findUndeclaredReads(
        [read("src/features", "directory", "readdirSync"), content],
        ["src/**/*.ts"],
      ),
    ).toEqual([content]);
  });

  it("treats a rootless glob as covering every directory", () => {
    expect(
      findUndeclaredReads(
        [read("scripts/validate", "directory", "readdirSync")],
        ["**/*.sh"],
      ),
    ).toEqual([]);
  });

  it("reports every read when nothing is declared", () => {
    const reads = [read("package.json"), read("src", "directory")];
    expect(findUndeclaredReads(reads, [])).toEqual(reads);
  });

  it("describes undeclared reads as glob-shaped groups an author can declare", () => {
    const reads = [
      ...Array.from({ length: 30 }, (_, index) =>
        read(`src/lib/memory/file-${index}.ts`),
      ),
      read("src/lib/memory/schemas.test.ts"),
      read("package.json"),
      read("scripts/validate", "directory", "readdirSync"),
      read("scripts/validate/test.sh", "file", "spawn:bash"),
    ];

    const message = describeUndeclaredReads("src/lib/memory/x.test.ts", reads, [
      "docs/**",
    ]);

    expect(message).toContain("src/lib/memory/x.test.ts");
    expect(message).toContain("@vitest-inputs");
    expect(message).toContain("src/lib/**/*.ts (31");
    expect(message).toContain("package.json");
    expect(message).toContain("scripts/validate (directory");
    expect(message).toContain("spawn:bash");
    expect(message).toContain("docs/**");
    expect(message).not.toContain("file-17.ts");
  });
});

describe("selection from declared inputs", () => {
  const declaredInputsByTestFile = {
    "src/lib/routes.arch.test.ts": ["src/app/**/route.ts"],
    "src/lib/shared/tailwind.test.ts": ["src/**/*.tsx", "src/**/*.css"],
    "scripts/wrappers.test.ts": ["scripts/validate/**"],
  };

  it("selects every test whose declared inputs match a changed path", () => {
    expect(
      selectTestsForChangedPaths(declaredInputsByTestFile, [
        "src/app/api/sessions/route.ts",
        "src/features/_root/styles/theme.css",
      ]),
    ).toEqual([
      "src/lib/routes.arch.test.ts",
      "src/lib/shared/tailwind.test.ts",
    ]);
  });

  it("selects nothing for changes outside every declaration", () => {
    expect(
      selectTestsForChangedPaths(declaredInputsByTestFile, [
        "docs/readme.md",
        "src/lib/memory/service.ts",
      ]),
    ).toEqual([]);
  });

  it("selects on deleted paths as readily as on added ones", () => {
    expect(
      selectTestsForChangedPaths(declaredInputsByTestFile, [
        "scripts/validate/removed.sh",
      ]),
    ).toEqual(["scripts/wrappers.test.ts"]);
  });
});

describe("stale declarations", () => {
  it("reports every declared glob that no repository file matches", () => {
    expect(
      findStaleDeclaredInputs(
        {
          "src/lib/routes.arch.test.ts": [
            "src/app/**/route.ts",
            "docs/gone/**",
          ],
          "scripts/wrappers.test.ts": ["scripts/validate/**"],
        },
        ["src/app/api/route.ts", "scripts/validate/test.sh"],
      ),
    ).toEqual([
      { testFile: "src/lib/routes.arch.test.ts", glob: "docs/gone/**" },
    ]);
  });

  it("exempts literal paths, which may declare an existence probe", () => {
    expect(
      findStaleDeclaredInputs(
        { "src/lib/routes.arch.test.ts": ["package.json.ts"] },
        ["package.json"],
      ),
    ).toEqual([]);
  });
});
