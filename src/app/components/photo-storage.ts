"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resizeImage } from "@/lib/image-resize";

export const PHOTO_BUCKET = "item-photos";
/** Signed URLs are re-minted on every load, so this only has to outlive a visit. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;
export { MAX_PHOTOS } from "@/lib/photo-limits";

export type PhotoParent = { kind: "purchase" | "giftIdea"; id: string };

/** `item_photos` holds one column per parent kind, and exactly one is set. */
export function parentColumn(kind: PhotoParent["kind"]) {
  return kind === "purchase" ? "purchase_id" : "gift_idea_id";
}

/**
 * Stores one already-resized image and indexes it.
 *
 * Shared by the gallery (attaching to an existing item) and the picker
 * (attaching straight after a new item is created), so the rollback below
 * cannot drift between the two.
 */
export async function uploadPhoto(
  db: SupabaseClient,
  parent: PhotoParent,
  image: { blob: Blob; width: number; height: number },
) {
  const path = `${parent.kind}/${parent.id}/${crypto.randomUUID()}.jpg`;

  const uploaded = await db.storage.from(PHOTO_BUCKET).upload(path, image.blob, {
    contentType: "image/jpeg",
    upsert: false,
  });
  if (uploaded.error) throw new Error(uploaded.error.message);

  const inserted = await db.from("item_photos").insert({
    [parentColumn(parent.kind)]: parent.id,
    storage_path: path,
    width: image.width,
    height: image.height,
    byte_size: image.blob.size,
  });

  // Roll the file back if the row could not be written, so the bucket never
  // accumulates files that nothing points at.
  if (inserted.error) {
    await db.storage.from(PHOTO_BUCKET).remove([path]);
    throw new Error(inserted.error.message);
  }
}

/** Resizes then stores, for callers holding a raw file straight from an input. */
export async function uploadPhotoFile(db: SupabaseClient, parent: PhotoParent, file: File) {
  return uploadPhoto(db, parent, await resizeImage(file));
}

/** One batch call rather than one per photo. */
export async function signedUrlsFor(db: SupabaseClient, paths: string[]) {
  if (paths.length === 0) return new Map<string, string>();
  const signed = await db.storage.from(PHOTO_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
  return new Map(
    (signed.data ?? []).flatMap((entry) =>
      entry.path && entry.signedUrl ? [[entry.path, entry.signedUrl] as const] : [],
    ),
  );
}
