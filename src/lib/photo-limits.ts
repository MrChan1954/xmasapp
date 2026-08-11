/** How many photos one purchase or gift idea may carry. */
export const MAX_PHOTOS = 12;

/**
 * How many of `incoming` can be accepted when `current` are already held, and
 * how many are turned away.
 *
 * Pure, and separated from the picker component, because getting this wrong is
 * silent: an off-by-one here shows up as "nothing happened" plus a limit warning
 * rather than as an error anyone can trace.
 */
export function photoIntake(current: number, incoming: number, max = MAX_PHOTOS) {
  const room = Math.max(0, max - current);
  const accepted = Math.min(incoming, room);
  return { room, accepted, rejected: incoming - accepted, atLimit: room === 0 };
}
