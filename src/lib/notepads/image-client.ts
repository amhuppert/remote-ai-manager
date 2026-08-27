/**
 * Browser-side access to the notepad image routes: the upload that mints an
 * image id and the URL the rendered surfaces point an `<img>` at. The id is
 * what canonical text stores, so these two calls are the whole client story —
 * bytes never travel through component state.
 */

import { z } from "zod";
import { mutationFetch } from "@/lib/api/fetcher";
import { notepadImageSchema, type NotepadImage } from "./schemas";

const uploadResponseSchema = z.object({ image: notepadImageSchema });

export function notepadImageUrl(notepadId: string, imageId: string): string {
  return `/api/notepads/${encodeURIComponent(notepadId)}/images/${encodeURIComponent(imageId)}`;
}

export async function uploadNotepadImage(
  notepadId: string,
  file: File,
): Promise<NotepadImage> {
  const form = new FormData();
  form.append("file", file);
  const metadata = {
    ...(file.name.length > 0 ? { fileName: file.name } : {}),
    ...(file.type.length > 0 ? { mediaType: file.type } : {}),
  };
  if (Object.keys(metadata).length > 0) {
    form.append("metadata", JSON.stringify(metadata));
  }
  const response = await mutationFetch(
    `/api/notepads/${encodeURIComponent(notepadId)}/images`,
    "notepads.image-upload",
    { method: "POST", body: form },
    uploadResponseSchema,
  );
  return response.image;
}
