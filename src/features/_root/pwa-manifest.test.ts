// @vitest-inputs public/**
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const iconSchema = z.object({
  src: z.string().startsWith("/"),
  sizes: z.string().regex(/^\d+x\d+$/),
  type: z.literal("image/png"),
  purpose: z.literal("maskable").optional(),
});

const manifestSchema = z.object({
  name: z.string().min(1),
  short_name: z.string().min(1),
  id: z.literal("/"),
  start_url: z.literal("/"),
  scope: z.literal("/"),
  icons: z.array(iconSchema),
  theme_color: z.string(),
  background_color: z.string(),
  display: z.literal("standalone"),
});

function parseSquareSize(size: string): number {
  const [width, height] = size.split("x").map(Number);

  if (width === undefined || height === undefined) {
    throw new Error(`Invalid icon size: ${size}`);
  }

  expect(width).toBe(height);
  expect(width).toBeGreaterThan(0);
  return width;
}

describe("PWA manifest", () => {
  it("defines one stable standalone Command Center app", async () => {
    const raw = await readFile(
      path.join(process.cwd(), "public/site.webmanifest"),
      "utf8",
    );
    const manifest = manifestSchema.parse(JSON.parse(raw));

    expect(manifest).toMatchObject({
      name: "Command Center",
      short_name: "Command Center",
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      theme_color: "#06090f",
      background_color: "#06090f",
    });
  });

  it("ships every declared icon at its intrinsic PNG size", async () => {
    const raw = await readFile(
      path.join(process.cwd(), "public/site.webmanifest"),
      "utf8",
    );
    const manifest = manifestSchema.parse(JSON.parse(raw));

    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192" }),
        expect.objectContaining({ sizes: "512x512" }),
        expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
      ]),
    );

    for (const icon of manifest.icons) {
      const bytes = await readFile(
        path.join(process.cwd(), "public", icon.src.slice(1)),
      );
      const declaredSize = parseSquareSize(icon.sizes);

      expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(bytes.readUInt32BE(16)).toBe(declaredSize);
      expect(bytes.readUInt32BE(20)).toBe(declaredSize);
    }
  });
});
