/**
 * The composer's stop square is drawn 13% smaller than the composer's other icons (13 Oct:
 * "10%-15% smaller"), rounded to a whole point: 20 -> 17 on phones, 16 -> 14 on web. Only the
 * square changes; the button and the shared icon size stay as they are.
 */
export const STOP_SQUARE_SCALE = 0.87;

export function stopSquareSize(buttonIconSize: number): number {
  return Math.round(buttonIconSize * STOP_SQUARE_SCALE);
}
