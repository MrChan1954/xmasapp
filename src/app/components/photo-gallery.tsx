"use client";

/* eslint-disable @next/next/no-img-element -- see note below */

/*
 * Raw <img> throughout, deliberately. These are signed Supabase Storage URLs:
 * short-lived, and already downscaled by the browser before upload. `next/image`
 * would proxy and re-optimise them, which on Cloudflare Workers means paying to
 * re-encode an image that is already the right size, against a URL that expires
 * before any cache of it would be worth keeping.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Trash2 } from "lucide-react";
import { createClient } from "@/utils/supabase/client";
import { photoIntake } from "@/lib/photo-limits";
import { cx } from "./cx";
import {
  MAX_PHOTOS,
  PHOTO_BUCKET,
  parentColumn,
  signedUrlsFor,
  uploadPhotoFile,
  type PhotoParent as Parent,
} from "./photo-storage";
import { Modal, Notice } from "./ui";

type Photo = { id: string; storage_path: string; width: number | null; height: number | null };
type PhotoWithUrl = Photo & { url: string | null };

/**
 * Photos attached to one purchase or gift idea.
 *
 * Thumbnails in a grid; tapping one opens it full size. Files live in a private
 * Storage bucket, so each thumbnail is shown through a short-lived signed URL
 * minted here rather than a permanent public link.
 */
export function PhotoGallery({ parent, label }: { parent: Parent; label: string }) {
  const [photos, setPhotos] = useState<PhotoWithUrl[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<PhotoWithUrl | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<PhotoWithUrl | null>(null);

  // Two inputs, because the difference is the `capture` attribute: one opens the
  // camera directly, the other the photo library.
  const libraryInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  const column = parentColumn(parent.kind);

  const load = useCallback(async () => {
    const db = createClient();
    const result = await db
      .from("item_photos")
      .select("id, storage_path, width, height")
      .eq(column, parent.id)
      .order("created_at");

    if (result.error) {
      setError("Photos could not be loaded.");
      setLoading(false);
      return;
    }

    const rows = result.data as Photo[];
    const urlByPath = await signedUrlsFor(db, rows.map((row) => row.storage_path));
    setPhotos(rows.map((row) => ({ ...row, url: urlByPath.get(row.storage_path) ?? null })));
    setError(null);
    setLoading(false);
  }, [column, parent.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);

    const intake = photoIntake(photos.length, files.length);
    if (intake.atLimit) {
      setError(`Up to ${MAX_PHOTOS} photos can be added to one item.`);
      return;
    }

    setBusy(true);
    const db = createClient();
    const chosen = [...files].slice(0, intake.accepted);

    for (const file of chosen) {
      try {
        // Resize, store and index, with the same rollback the add form uses.
        await uploadPhotoFile(db, parent, file);
      } catch {
        setError("That photo could not be uploaded.");
      }
    }

    if (intake.rejected > 0) {
      setError(`Only ${intake.accepted} more could be added — the limit is ${MAX_PHOTOS} per item.`);
    }
    await load();
    setBusy(false);
  };

  const remove = async (photo: PhotoWithUrl) => {
    setBusy(true);
    setConfirmingDelete(null);
    const db = createClient();
    // Row first: it is the thing RLS protects and the thing the activity log
    // watches. A file left behind is invisible; a row pointing at nothing is not.
    const deleted = await db.from("item_photos").delete().eq("id", photo.id);
    if (deleted.error) {
      setError("That photo could not be removed.");
    } else {
      await db.storage.from(PHOTO_BUCKET).remove([photo.storage_path]);
      setViewing(null);
    }
    await load();
    setBusy(false);
  };

  return (
    <section className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h4 className="font-display text-base font-semibold text-ink-900">Photos</h4>
        <div className="flex items-center gap-2">
          {/* `capture` asks for the camera; without it the picker opens the
              library. Both accept images only. */}
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }}
          />
          <input
            ref={libraryInput}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => cameraInput.current?.click()}
            className="flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-ink-700 hover:border-line-strong disabled:opacity-50 sm:hidden"
          >
            <Camera aria-hidden size={17} strokeWidth={1.8} />
            Camera
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => libraryInput.current?.click()}
            className="flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-ink-700 hover:border-line-strong disabled:opacity-50"
          >
            <ImagePlus aria-hidden size={17} strokeWidth={1.8} />
            {busy ? "Adding..." : "Add photo"}
          </button>
        </div>
      </div>

      {error && <Notice tone="warning" className="mt-3" onDismiss={() => setError(null)}>{error}</Notice>}

      {loading ? (
        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          <div className="aspect-square animate-pulse rounded-xl bg-surface-3/70" />
          <div className="aspect-square animate-pulse rounded-xl bg-surface-3/70" />
        </div>
      ) : photos.length === 0 ? (
        <p className="mt-2 text-sm leading-6 text-ink-600">
          No photos yet. Add one from your camera roll, or take one now.
        </p>
      ) : (
        <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((photo) => (
            <li key={photo.id}>
              <button
                type="button"
                onClick={() => setViewing(photo)}
                className="group relative block w-full overflow-hidden rounded-xl border border-line bg-surface-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label={`View photo of ${label}`}
              >
                {/* Fixed square tiles keep the grid tidy whatever shape the
                    photos are; the full-size view shows them uncropped. */}
                <span className="block aspect-square">
                  {photo.url && (
                    <img
                      src={photo.url}
                      alt={`Photo of ${label}`}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover transition group-hover:scale-[1.03]"
                    />
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {viewing && (
        <Modal labelledBy="photo-viewer-title" onClose={() => setViewing(null)} size="lg" surface="ground">
          <div className="flex items-center justify-between gap-4 px-5 pt-4 sm:px-7 sm:pt-6">
            <h2 id="photo-viewer-title" className="font-display text-xl font-semibold text-ink-900">
              {label}
            </h2>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmingDelete(viewing)}
              className="flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-berry hover:border-line-strong disabled:opacity-50"
            >
              <Trash2 aria-hidden size={17} strokeWidth={1.8} />
              Remove
            </button>
          </div>
          <div className="px-5 pt-4 pb-6 sm:px-7">
            {viewing.url && (
              <img
                src={viewing.url}
                alt={`Photo of ${label}`}
                width={viewing.width ?? undefined}
                height={viewing.height ?? undefined}
                className={cx(
                  // Bounded by the viewport so a tall photo cannot push the
                  // modal past its own max height.
                  "mx-auto max-h-[70dvh] w-auto max-w-full rounded-2xl object-contain",
                )}
              />
            )}
          </div>
        </Modal>
      )}

      {confirmingDelete && (
        <Modal labelledBy="photo-remove-title" onClose={() => setConfirmingDelete(null)} size="sm" surface="ground">
          <div className="px-5 pt-5 pb-6 sm:px-7">
            <h2 id="photo-remove-title" className="font-display text-xl font-semibold text-ink-900">
              Remove this photo?
            </h2>
            <p className="mt-2 text-sm leading-6 text-ink-600">
              It will be deleted for everyone. This appears in the activity log.
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setConfirmingDelete(null)}
                className="h-11 rounded-xl border border-line bg-surface text-sm font-semibold text-ink-700 hover:border-line-strong"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(confirmingDelete)}
                className="h-11 rounded-xl bg-berry text-sm font-semibold text-white disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
