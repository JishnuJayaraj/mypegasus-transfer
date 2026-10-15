import { z } from "zod";

// base64url of { createdAt, id }. createdAt keeps the database's microseconds, so the keyset
// comparison is exact.
const Cursor = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });
export type Cursor = z.infer<typeof Cursor>;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(value: string): Cursor | undefined {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}
