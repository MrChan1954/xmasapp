"use client";

/* eslint-disable @next/next/no-img-element -- previews are local object URLs for
   images already resized in the browser; there is nothing for the optimiser to
   fetch or improve, and the URL is revoked as soon as the preview is dropped. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, X } from "lucide-react";
import { createClient } from "../../../utils/supabase/client";
import { resizeImage } from "@/lib/image-resize";
import { MAX_PHOTOS, uploadPhoto, type PhotoParent } from "./photo-storage";
import { Notice } from "./ui";

type PendingPhoto = { id: string; blob: Blob; width: number; height: number; previewUrl: string };

/**
 * Photos chosen before the thing they belong to exists.
 *
 * A photo row requires a parent id, and while the add form is open there is no
 * purchase or gift idea to point at yet. So selections are resized immediately
 * (the slow part, done while the user is still typing) and held in memory; the
 * caller uploads them once the save returns the new record's id.
 *
 * Nothing is written to Storage until then, so abandoning the form leaves no
 * orphaned files behind.
 */
export function usePendingPhotos() {
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);

  // Object URLs are a manual allocation; without this they leak for the life of
  // the document.
  useEffect(
    () => () => {
      for (const photo of photos) URL.revokeObjectURL(photo.previewUrl);
    },
    [photos],
  );

  const add = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    setPreparing(true);

    const prepared: PendingPhoto[] = [];
    let room = 0;
    setPhotos((current) => {
      room = MAX_PHOTOS - current.length;
      return current;
    });

    for (const file of [...files].slice(0, Math.max(room, 0))) {
      try {
        const { blob, width, height } = await resizeImage(file);
        prepared.push({
          id: crypto.randomUUID(),
          blob,
          width,
          height,
          previewUrl: URL.createObjectURL(blob),
        });
      } catch {
        setError("That photo could not be read.");
      }
    }

    if (prepared.length) {
      setPhotos((current) => [...current, ...prepared].slice(0, MAX_PHOTOS));
    }
    if (files.length > Math.max(room, 0)) {
      setError(`Up to ${MAX_PHOTOS} photos can be added to one item.`);
    }
    setPreparing(false);
  }, []);

  const remove = useCallback((id: string) => {
    setPhotos((current) => {
      const going = current.find((photo) => photo.id === id);
      if (going) URL.revokeObjectURL(going.previewUrl);
      return current.filter((photo) => photo.id !== id);
    });
  }, []);

  /**
   * Called once the parent exists. Failures are reported but never rethrown: by
   * this point the purchase or gift idea is already saved, and losing that save
   * over a photo would be far worse than the photo not appearing. Anything that
   * fails can be added again from the item's own gallery.
   */
  const uploadTo = useCallback(
    async (parent: PhotoParent) => {
      if (photos.length === 0) return { uploaded: 0, failed: 0 };
      const db = createClient();
      let uploaded = 0;
      let failed = 0;

      for (const photo of photos) {
        try {
          await uploadPhoto(db, parent, photo);
          uploaded += 1;
        } catch {
          failed += 1;
        }
      }

      for (const photo of photos) URL.revokeObjectURL(photo.previewUrl);
      setPhotos([]);
      return { uploaded, failed };
    },
    [photos],
  );

  return { photos, add, remove, uploadTo, error, setError, preparing };
}

/** The picker UI. State lives in `usePendingPhotos` so the form can upload on save. */
export function PhotoPicker({
  photos,
  onAdd,
  onRemove,
  error,
  onDismissError,
  preparing,
  disabled = false,
}: {
  photos: ReturnType<typeof usePendingPhotos>["photos"];
  onAdd: (files: FileList | null) => void;
  onRemove: (id: string) => void;
  error: string | null;
  onDismissError: () => void;
  preparing: boolean;
  disabled?: boolean;
}) {
  const libraryInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-900">Photos</p>
          <p className="mt-0.5 text-xs leading-5 text-ink-600">
            Added once you save. Nothing is uploaded before then.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* `capture` opens the camera; without it the picker opens the library. */}
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(event) => { onAdd(event.target.files); event.target.value = ""; }}
          />
          <input
            ref={libraryInput}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(event) => { onAdd(event.target.files); event.target.value = ""; }}
          />
          <button
            type="button"
            disabled={disabled || preparing}
            onClick={() => cameraInput.current?.click()}
            className="flex h-10 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-ink-700 hover:border-line-strong disabled:opacity-50 sm:hidden"
          >
            <Camera aria-hidden size={17} strokeWidth={1.8} />
            Camera
          </button>
          <button
            type="button"
            disabled={disabled || preparing}
            onClick={() => libraryInput.current?.click()}
            className="flex h-10 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-ink-700 hover:border-line-strong disabled:opacity-50"
          >
            <ImagePlus aria-hidden size={17} strokeWidth={1.8} />
            {preparing ? "Adding..." : "Add photo"}
          </button>
        </div>
      </div>

      {error && <Notice tone="warning" className="mt-3" onDismiss={onDismissError}>{error}</Notice>}

      {photos.length > 0 && (
        <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((photo) => (
            <li key={photo.id} className="relative">
              <span className="block aspect-square overflow-hidden rounded-xl border border-line bg-surface-3">
                <img src={photo.previewUrl} alt="" className="h-full w-full object-cover" />
              </span>
              <button
                type="button"
                onClick={() => onRemove(photo.id)}
                aria-label="Remove this photo"
                className="absolute -top-2 -right-2 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface text-ink-700 shadow-card hover:border-line-strong hover:text-berry"
              >
                <X aria-hidden size={15} strokeWidth={2.2} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
