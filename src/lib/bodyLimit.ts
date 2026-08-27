/**
 * Public-route body size cap (wp4-vet.md's "Public API protection": rate limits, body size caps,
 * one-time-token TTLs). No public request body in this app carries more than a short JSON object
 * (the largest, `BookAppointmentRequest`, tops out around its 2000-char `notes` field), so 16KB
 * leaves generous headroom while still refusing an attacker's oversized payload before it is fully
 * buffered into memory. Checks `Content-Length` first (cheap, but a caller can omit or lie about
 * it) and enforces the same cap again while reading the body, so a chunked or mislabeled request
 * cannot bypass it.
 *
 * Kept free of `server-only` and `next/server` (unlike `publicApi.ts`, which re-exports this) so
 * it can be unit tested directly against the standard `Request` object, the same pattern
 * `rateLimit.ts` uses for its own route-adjacent wrapper in `publicApi.ts`.
 */

export const PUBLIC_BODY_MAX_BYTES = 16 * 1024;

export type ReadJsonBodyResult = {ok: true; body: unknown} | {ok: false; tooLarge: true} | {ok: false; tooLarge: false};

export async function readJsonBody(request: Request, maxBytes = PUBLIC_BODY_MAX_BYTES): Promise<ReadJsonBodyResult> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maxBytes) {
    return {ok: false, tooLarge: true};
  }

  if (!request.body) {
    try {
      return {ok: true, body: await request.json()};
    } catch {
      return {ok: false, tooLarge: false};
    }
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return {ok: false, tooLarge: true};
    }
    chunks.push(value);
  }

  try {
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
    return {ok: true, body: text.length ? JSON.parse(text) : null};
  } catch {
    return {ok: false, tooLarge: false};
  }
}
