import { Client } from "pg";
import { afterAll, afterEach } from "vitest";

/**
 * Vitest setup of the integration projects: a test fails when a query starts on a pg connection
 * that is still running another one, e.g. a `Promise.all` on a transaction (ADR-0002, queries on
 * one connection). pg 8 queues such a query and warns (`queryQueueLengthDeprecationNotice`, only
 * from the third query at once and once per process), and pg 9 removes that queue. The queries
 * still run, so a test fails on the overlap and not on its consequences.
 */

/** pg's deprecation warning, matched by its message since it has no code. */
const pgWarning = "Calling client.query() when the client is already executing a query";

const overlaps: string[] = [];
const running = new WeakMap<Client, string[]>();
const statement = (config: unknown) =>
  String(typeof config === "string" ? config : (config as { text?: unknown } | null)?.text)
    .replace(/\s+/g, " ")
    .slice(0, 120);

const query = Client.prototype.query as (this: Client, ...args: unknown[]) => unknown;
Client.prototype.query = function (this: Client, ...args: unknown[]) {
  // Pipeline mode sends queries at once on purpose.
  if ((this as { pipeline?: boolean }).pipeline) return Reflect.apply(query, this, args);
  const sql = statement(args[0]);
  let active = running.get(this);
  if (!active) running.set(this, (active = []));
  if (active.length > 0) overlaps.push(`started "${sql}" while "${active[0]}" was running`);
  active.push(sql);
  const settle = () => active.splice(active.indexOf(sql), 1);
  const callback = args.at(-1);
  if (typeof callback === "function") {
    args[args.length - 1] = (...result: unknown[]) => {
      settle();
      return Reflect.apply(callback, undefined, result);
    };
    return Reflect.apply(query, this, args);
  }
  const result = Reflect.apply(query, this, args);
  // A submittable (a cursor) isn't followed; pg's warning still catches a pile-up behind it.
  if (result instanceof Promise) result.then(settle, settle);
  else settle();
  return result;
} as typeof Client.prototype.query;

process.on("warning", (warning) => {
  if (warning.name === "DeprecationWarning" && warning.message.startsWith(pgWarning))
    overlaps.push(`pg warned: ${warning.message}`);
});

function failOnOverlaps() {
  if (overlaps.length === 0) return;
  const found = overlaps.splice(0);
  throw new Error(
    `Queries overlapped on one pg connection; run them one after another (ADR-0002):\n${found.join("\n")}`,
  );
}

afterEach(failOnOverlaps);
afterAll(failOnOverlaps);
