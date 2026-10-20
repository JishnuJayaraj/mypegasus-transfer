/**
 * Where a login may return to (D1): `/` or a staff route below `/projects`, as plain path
 * segments. No query or fragment, no other origin, never the API or the portal; anything else
 * returns to `/`.
 */
const allowed = /^\/(projects(\/[A-Za-z0-9-]{1,100})*\/?)?$/;

export function safeReturnPath(path: string | undefined): string {
  return path !== undefined && allowed.test(path) ? path : "/";
}
