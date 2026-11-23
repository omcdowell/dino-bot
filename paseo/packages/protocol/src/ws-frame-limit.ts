/**
 * Largest WebSocket message the daemon accepts (ws `maxPayload`). A bigger frame closes the
 * socket with 1009, and a client that resends it never gets through, so senders must stay under
 * it (see INLINE_IMAGES_MAX_BYTES in the app's outbox). Set explicitly so a `ws` upgrade cannot
 * move it; the value is the library default the app was sized against.
 */
export const MAX_WS_FRAME_BYTES = 100 * 1024 * 1024;
