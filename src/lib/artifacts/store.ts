import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Immutable snapshots of document bytes, identified by their content. A
 * snapshot is written once and never changed; every read checks the bytes
 * against their identity, so a consumer holding a reference reads exactly
 * what was frozen or learns that it cannot.
 */

export const artifactIdSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "not an artifact identity");

export interface ArtifactRef {
  artifactId: string;
  bytes: number;
}

export interface ArtifactStore {
  /** Stores bytes once, by their content, and returns their identity. */
  snapshot(bytes: Uint8Array): Promise<ArtifactRef>;
  /** The bytes of a snapshot, checked against its identity. */
  read(artifactId: string): Promise<Buffer>;
  /**
   * Writes read-only copies of snapshots at their paths under `root`,
   * replacing whatever is there, so each delivery leaves the frozen bytes.
   * Refuses a path that leaves `root` or passes through a link.
   */
  materialize(
    root: string,
    entries: ReadonlyArray<{ artifactId: string; path: string }>,
  ): Promise<void>;
}

export class ArtifactUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactUnavailableError";
  }
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Writes through a temporary sibling and a rename, so a reader never sees a
 * partial file. The sibling's name is short, so any name that fits fits here.
 */
async function replaceFile(target: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { mode: 0o444 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function createArtifactStore(options: { root: string }): ArtifactStore {
  function objectPath(artifactId: string): { file: string; hex: string } {
    const parsed = artifactIdSchema.safeParse(artifactId);
    if (!parsed.success)
      throw new ArtifactUnavailableError(
        `"${artifactId}" is not an artifact identity`,
      );
    const hex = artifactId.slice("sha256:".length);
    return {
      file: path.join(options.root, "objects", hex.slice(0, 2), hex),
      hex,
    };
  }

  async function read(artifactId: string): Promise<Buffer> {
    const { file, hex } = objectPath(artifactId);
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new ArtifactUnavailableError(
          `Artifact ${artifactId} is missing from the store`,
        );
      throw error;
    }
    if (sha256(bytes) !== hex)
      throw new ArtifactUnavailableError(
        `The stored bytes of artifact ${artifactId} do not match its identity`,
      );
    return bytes;
  }

  return {
    async snapshot(bytes) {
      const artifactId = `sha256:${sha256(bytes)}`;
      const ref = { artifactId, bytes: bytes.byteLength };
      try {
        await read(artifactId);
        return ref;
      } catch (error) {
        if (!(error instanceof ArtifactUnavailableError)) throw error;
      }
      // Missing, or damaged: write the bytes again.
      await replaceFile(objectPath(artifactId).file, bytes);
      return ref;
    },
    read,
    async materialize(root, entries) {
      const base = await realpath(root);
      for (const entry of entries) {
        const target = path.resolve(base, entry.path);
        const relative = path.relative(base, target);
        if (
          path.isAbsolute(entry.path) ||
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          relative === ""
        )
          throw new ArtifactUnavailableError(
            `A copy of artifact ${entry.artifactId} must stay inside ${root}: "${entry.path}"`,
          );
        // Each directory on the way is created here or must be a real one: a link would send the copy elsewhere.
        let directory = base;
        for (const part of relative.split(path.sep).slice(0, -1)) {
          directory = path.join(directory, part);
          const found = await lstat(directory).catch((error: unknown) => {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return null;
            throw error;
          });
          if (found === null) await mkdir(directory);
          else if (found.isSymbolicLink() || !found.isDirectory())
            throw new ArtifactUnavailableError(
              `A copy of artifact ${entry.artifactId} at "${entry.path}" passes through a link or a file at "${path.relative(base, directory)}"`,
            );
        }
        await replaceFile(target, await read(entry.artifactId));
      }
    },
  };
}
