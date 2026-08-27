import { mkdtempSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { PublishFn } from "@/lib/events/publication";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  createNotepadsRepo,
  type NotepadsRepo,
} from "@/lib/state-store/notepads-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import {
  createNotepadContentStore,
  type NotepadContentStore,
} from "./content-store";
import {
  createNotepadImageRouteHandlers,
  MAX_NOTEPAD_IMAGE_BYTES,
  type NotepadImageRouteHandlers,
} from "./image-route-handlers";
import { createNotepadImageService } from "./image-service";
import type { RouteContext } from "./route-handlers";
import type { Notepad, NotepadImage } from "./schemas";
import { createNotepadService, type NotepadService } from "./service";

const TOKEN = "notepad-image-test-token";
const BASE_URL = "http://localhost/api/notepads";
/** A PNG signature plus a few bytes — enough to prove byte-for-byte fidelity. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xfe, 0xff,
]);

let fixture: PersistenceFixture;
let repo: NotepadsRepo;
let contentStore: NotepadContentStore;
let contentBase: string;
let service: NotepadService;
let handlers: NotepadImageRouteHandlers;
let idSeq: number;

const publish: PublishFn = () => ({ delivered: true });

const auth: AgentAuth = {
  async requireToken() {
    return null;
  },
  async validateOptionalToken(request) {
    const header = request.headers.get("authorization");
    if (header === null) return { kind: "absent" };
    return header === `Bearer ${TOKEN}`
      ? { kind: "valid" }
      : { kind: "invalid" };
  },
};

function buildHandlers(
  overrides: { repo?: NotepadsRepo } = {},
): NotepadImageRouteHandlers {
  const imageService = createNotepadImageService({
    notepads: service,
    repo: overrides.repo ?? repo,
    contentStore,
    now: () => new Date(Date.UTC(2026, 7, 27, 9, 0, 0)).toISOString(),
    generateId: () => {
      idSeq += 1;
      return `image-${idSeq}`;
    },
  });
  return createNotepadImageRouteHandlers({
    getImageService: () => imageService,
    auth,
  });
}

beforeEach(() => {
  fixture = createPersistenceFixture();
  repo = createNotepadsRepo(fixture.db, createWriteQueue());
  contentBase = mkdtempSync(path.join(tmpdir(), "cc-notepad-images-"));
  contentStore = createNotepadContentStore({
    contentRoot: path.join(contentBase, "notepad-content"),
    listNotepadIdsForProject: (projectPath) => repo.listNotepadIds(projectPath),
  });
  idSeq = 0;
  let notepadSeq = 0;
  service = createNotepadService({
    repo,
    publish,
    deleteNotepadContent: (notepadId) => contentStore.deleteNotepad(notepadId),
    now: () => new Date(Date.UTC(2026, 7, 27, 9, 0, 0)).toISOString(),
    generateId: () => {
      notepadSeq += 1;
      return `notepad-${notepadSeq}`;
    },
  });
  handlers = buildHandlers();
});

afterEach(() => {
  fixture.close();
  rmSync(contentBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createNotepad(name = "shots"): Promise<Notepad> {
  const result = await service.create({
    scope: "global",
    projectPath: null,
    name,
  });
  if (!result.ok)
    throw new Error(`fixture create failed: ${result.error.code}`);
  return result.value;
}

function uploadContext(notepadId: string): RouteContext {
  return { params: Promise.resolve({ notepadId }) };
}

function readContext(notepadId: string, imageId: string): RouteContext {
  return { params: Promise.resolve({ notepadId, imageId }) };
}

function multipartUpload(
  notepadId: string,
  options: {
    // ArrayBuffer-backed specifically: a `BlobPart` cannot be a view over a
    // SharedArrayBuffer, which the bare `Uint8Array` alias still admits.
    bytes?: Uint8Array<ArrayBuffer>;
    fileName?: string;
    mediaType?: string;
    metadata?: Record<string, unknown>;
    token?: string;
  } = {},
): Request {
  const form = new FormData();
  form.set(
    "file",
    new File(
      [options.bytes ?? PNG_BYTES],
      options.fileName ?? "screenshot.png",
      {
        type: options.mediaType ?? "image/png",
      },
    ),
  );
  if (options.metadata !== undefined) {
    form.set("metadata", JSON.stringify(options.metadata));
  }
  const headers = new Headers();
  if (options.token !== undefined) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  return new Request(`${BASE_URL}/${notepadId}/images`, {
    method: "POST",
    headers,
    body: form,
  });
}

async function uploadImage(
  notepadId: string,
  options: Parameters<typeof multipartUpload>[1] = {},
): Promise<NotepadImage> {
  const response = await handlers.uploadPOST(
    multipartUpload(notepadId, options),
    uploadContext(notepadId),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { image: NotepadImage };
  return body.image;
}

// ---------------------------------------------------------------------------
// Upload and read
// ---------------------------------------------------------------------------

describe("notepad image upload and read", () => {
  it("round-trips uploaded bytes through the read route", async () => {
    const notepad = await createNotepad();

    const image = await uploadImage(notepad.id);
    expect(image).toMatchObject({
      notepadId: notepad.id,
      mediaType: "image/png",
      sizeBytes: PNG_BYTES.byteLength,
      fileName: "screenshot.png",
    });

    // The bytes landed in the content store, not just in a response body.
    await expect(
      stat(path.join(contentBase, "notepad-content", notepad.id, image.id)),
    ).resolves.toBeDefined();
    expect(await repo.findImage(notepad.id, image.id)).toMatchObject({
      snapshotKey: image.snapshotKey,
    });

    const served = await handlers.readGET(
      new Request(`${BASE_URL}/${notepad.id}/images/${image.id}`),
      readContext(notepad.id, image.id),
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("keeps every image of a notepad separately addressable", async () => {
    const notepad = await createNotepad();
    const first = await uploadImage(notepad.id, { fileName: "one.png" });
    const second = await uploadImage(notepad.id, {
      fileName: "two.webp",
      mediaType: "image/webp",
      bytes: new Uint8Array([1, 2, 3, 4]),
    });

    expect(second.id).not.toBe(first.id);
    const servedSecond = await handlers.readGET(
      new Request(`${BASE_URL}/${notepad.id}/images/${second.id}`),
      readContext(notepad.id, second.id),
    );
    expect(servedSecond.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await servedSecond.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it("prefers an explicit metadata part over the file part's own naming", async () => {
    const notepad = await createNotepad();
    const image = await uploadImage(notepad.id, {
      fileName: "blob",
      mediaType: "application/octet-stream",
      metadata: { fileName: "pasted.png", mediaType: "image/png" },
    });

    expect(image).toMatchObject({
      fileName: "pasted.png",
      mediaType: "image/png",
    });
  });

  it("404s an upload to a notepad that does not exist", async () => {
    const response = await handlers.uploadPOST(
      multipartUpload("missing-notepad"),
      uploadContext("missing-notepad"),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("not_found");
    expect(body["error"]).toContain("missing-notepad");
  });

  it("415s a media type notepads do not accept", async () => {
    const notepad = await createNotepad();
    const response = await handlers.uploadPOST(
      multipartUpload(notepad.id, {
        fileName: "notes.pdf",
        mediaType: "application/pdf",
      }),
      uploadContext(notepad.id),
    );
    expect(response.status).toBe(415);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("unsupported_media_type");
    expect(body["instruction"]).toContain("image/png");
    expect(await repo.listImages(notepad.id)).toHaveLength(0);
  });

  it("400s a body that is not multipart form data", async () => {
    const notepad = await createNotepad();
    const response = await handlers.uploadPOST(
      new Request(`${BASE_URL}/${notepad.id}/images`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "inline" }),
      }),
      uploadContext(notepad.id),
    );
    expect(response.status).toBe(400);
  });

  it("400s a multipart body with no file part", async () => {
    const notepad = await createNotepad();
    const form = new FormData();
    form.set("metadata", JSON.stringify({ fileName: "orphan.png" }));
    const response = await handlers.uploadPOST(
      new Request(`${BASE_URL}/${notepad.id}/images`, {
        method: "POST",
        body: form,
      }),
      uploadContext(notepad.id),
    );
    expect(response.status).toBe(400);
  });

  it("400s a metadata part that is not JSON", async () => {
    const notepad = await createNotepad();
    const form = new FormData();
    form.set("file", new File([PNG_BYTES], "shot.png", { type: "image/png" }));
    form.set("metadata", "not json");
    const response = await handlers.uploadPOST(
      new Request(`${BASE_URL}/${notepad.id}/images`, {
        method: "POST",
        body: form,
      }),
      uploadContext(notepad.id),
    );
    expect(response.status).toBe(400);
  });

  it("413s an oversized file, leaving no row and no bytes", async () => {
    const notepad = await createNotepad();
    const response = await handlers.uploadPOST(
      multipartUpload(notepad.id, {
        bytes: new Uint8Array(MAX_NOTEPAD_IMAGE_BYTES + 1),
      }),
      uploadContext(notepad.id),
    );
    expect(response.status).toBe(413);

    expect(await repo.listImages(notepad.id)).toHaveLength(0);
    await expect(
      stat(path.join(contentBase, "notepad-content", notepad.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("413s an oversized declared content-length before reading the body", async () => {
    const notepad = await createNotepad();
    const response = await handlers.uploadPOST(
      new Request(`${BASE_URL}/${notepad.id}/images`, {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=x",
          "content-length": String(MAX_NOTEPAD_IMAGE_BYTES * 3),
        },
        body: "irrelevant",
      }),
      uploadContext(notepad.id),
    );
    expect(response.status).toBe(413);
  });

  it("removes the captured bytes when the metadata row cannot be written", async () => {
    const notepad = await createNotepad();
    const failingRepo: NotepadsRepo = {
      ...repo,
      addImage() {
        return Promise.reject(new Error("insert failed"));
      },
    };
    const failing = buildHandlers({ repo: failingRepo });

    const response = await failing.uploadPOST(
      multipartUpload(notepad.id),
      uploadContext(notepad.id),
    );
    expect(response.status).toBe(500);

    expect(await repo.listImages(notepad.id)).toHaveLength(0);
    await expect(
      stat(path.join(contentBase, "notepad-content", notepad.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ---------------------------------------------------------------------------
// Read failures
// ---------------------------------------------------------------------------

describe("notepad image read failures", () => {
  it("404s an image id the notepad does not carry", async () => {
    const notepad = await createNotepad();
    const response = await handlers.readGET(
      new Request(`${BASE_URL}/${notepad.id}/images/ghost`),
      readContext(notepad.id, "ghost"),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("image_not_found");
    expect(body["error"]).toContain("ghost");
  });

  it("410s when the row outlived its stored bytes", async () => {
    const notepad = await createNotepad();
    const image = await uploadImage(notepad.id);
    await contentStore.delete(image.snapshotKey);

    const response = await handlers.readGET(
      new Request(`${BASE_URL}/${notepad.id}/images/${image.id}`),
      readContext(notepad.id, image.id),
    );
    expect(response.status).toBe(410);
    expect((await response.json())["code"]).toBe("image_unavailable");
  });

  it("does not serve an image through another notepad's id", async () => {
    const owner = await createNotepad("owner");
    const other = await createNotepad("other");
    const image = await uploadImage(owner.id);

    const response = await handlers.readGET(
      new Request(`${BASE_URL}/${other.id}/images/${image.id}`),
      readContext(other.id, image.id),
    );
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Token gate
// ---------------------------------------------------------------------------

describe("notepad image route token gate", () => {
  it("401s a malformed bearer token on both handlers", async () => {
    const notepad = await createNotepad();
    const image = await uploadImage(notepad.id);

    const upload = await handlers.uploadPOST(
      multipartUpload(notepad.id, { token: "wrong-token" }),
      uploadContext(notepad.id),
    );
    const read = await handlers.readGET(
      new Request(`${BASE_URL}/${notepad.id}/images/${image.id}`, {
        headers: { authorization: "Bearer wrong-token" },
      }),
      readContext(notepad.id, image.id),
    );

    expect([upload.status, read.status]).toEqual([401, 401]);
    expect(await repo.listImages(notepad.id)).toHaveLength(1);
  });
});
