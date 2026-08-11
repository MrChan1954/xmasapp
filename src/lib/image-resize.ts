/** Longest edge of a stored photo, in pixels. */
export const MAX_EDGE = 1600;

/** JPEG quality for the re-encoded upload. */
export const JPEG_QUALITY = 0.82;

export type ResizedImage = { blob: Blob; width: number; height: number };

/**
 * Scale factor that fits `width × height` inside a `MAX_EDGE` box, never
 * enlarging a photo that is already small.
 *
 * Pure so it can be tested without a DOM; the canvas work that uses it cannot.
 */
export function scaleToFit(width: number, height: number, maxEdge = MAX_EDGE) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return 1;
  return maxEdge / longest;
}

/** Dimensions after `scaleToFit`, rounded to whole pixels and never below 1. */
export function fittedSize(width: number, height: number, maxEdge = MAX_EDGE) {
  const scale = scaleToFit(width, height, maxEdge);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Re-encodes a picked or captured photo to a sensible size before upload.
 *
 * Phone cameras produce 3–12 MB images, and a family scrolling a gallery on
 * mobile data should not pay for that. Downscaling in the browser also strips
 * EXIF — including GPS coordinates, which have no business being attached to a
 * Christmas present.
 *
 * `createImageBitmap` applies the EXIF orientation flag itself, so photos taken
 * sideways are stored the right way up rather than relying on a tag that a
 * cropped `<img>` might ignore.
 */
export async function resizeImage(file: File, maxEdge = MAX_EDGE): Promise<ResizedImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { width, height } = fittedSize(bitmap.width, bitmap.height, maxEdge);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("This browser could not process the image.");
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!blob) throw new Error("This image could not be prepared for upload.");

  return { blob, width, height };
}
