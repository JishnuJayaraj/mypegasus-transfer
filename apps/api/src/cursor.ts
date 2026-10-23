import { AgenturKey } from "@transfer/config";
import { z } from "zod";

/** base64url of the JSON of a keyset position; anything else decodes to undefined. */
function cursorCodec<T extends z.ZodType>(schema: T) {
  return {
    encode: (cursor: z.output<T>): string =>
      Buffer.from(JSON.stringify(cursor)).toString("base64url"),
    decode: (value: string): z.output<T> | undefined => {
      try {
        return schema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
      } catch {
        return undefined;
      }
    },
  };
}

// { createdAt, id }. createdAt keeps the database's microseconds, so the keyset comparison is
// exact.
const Cursor = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });
export type Cursor = z.infer<typeof Cursor>;

export const { encode: encodeCursor, decode: decodeCursor } = cursorCodec(Cursor);

/** The template catalog's position: its last (agenturKey, version) (plan 5.8). */
export const templateCursor = cursorCodec(
  z.strictObject({ agenturKey: AgenturKey, version: z.int().min(1) }),
);

/** The audit history's position: the last shown event's sequence number (opaque to the client). */
export const historyCursor = cursorCodec(z.strictObject({ before: z.int().min(1) }));
