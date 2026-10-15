import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import { seedStaffUserIds } from "./seed";
import { resetTestDatabase, testDatabaseUrls } from "./testing";

// AC-13: the runtime role only has the grants that migrations give it explicitly.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const staffUserId = seedStaffUserIds.projectLead;

const insertProject = (client: Client) =>
  client.query(
    "insert into project (name, customer_name, type, created_by) values ($1, $2, 'ta_only', $3) returning id",
    ["Grant-Test", "Beispiel GmbH", staffUserId],
  );

const permissionDenied = { code: "42501" };

beforeAll(() => app.connect());
afterAll(() => app.end());
beforeEach(() => resetTestDatabase({ seed: true }));

describe("transfer_app", () => {
  it("may select and insert projects", async () => {
    const { rows } = await insertProject(app);
    const selected = await app.query("select name from project where id = $1", [rows[0].id]);
    expect(selected.rows).toEqual([{ name: "Grant-Test" }]);
  });

  it("may select staff users", async () => {
    const { rowCount } = await app.query("select id from staff_user");
    expect(rowCount).toBe(5);
  });

  it.each([
    ["update project", "update project set name = 'x'"],
    ["delete from project", "delete from project"],
    ["truncate project", "truncate project"],
    [
      "insert into staff_user",
      "insert into staff_user (display_name, email, role) values ('x', 'x@example.org', 'admin')",
    ],
    ["update staff_user", "update staff_user set display_name = 'x'"],
    ["delete from staff_user", "delete from staff_user"],
    ["create table", "create table intruder (id int)"],
    ["create schema", "create schema intruder"],
  ])("may not %s", async (_label, sql) => {
    await expect(app.query(sql)).rejects.toMatchObject(permissionDenied);
  });

  it("cannot run migrations; only transfer_owner can", async () => {
    await expect(runMigrations(urls.app)).rejects.toMatchObject({ cause: permissionDenied });
  });
});
