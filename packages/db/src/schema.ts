import { ProjectType, StaffRole } from "@transfer/domain";
import { sql } from "drizzle-orm";
import { check, date, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Every table here needs an entry in data-catalog.ts (CLAUDE.md rule 10); a test enforces it.

// The Postgres enums take their values from the domain's Zod enums.
const values = <T extends string>(e: { options: T[] }) => e.options as [T, ...T[]];

export const staffRole = pgEnum("staff_role", values(StaffRole));
export const projectType = pgEnum("project_type", values(ProjectType));

/** Synthetic staff users only in Slice 0 (the dev session stub). Never hard-deleted (Q59). */
export const staffUser = pgTable("staff_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull().unique(),
  role: staffRole("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The root of project scoping, so it has no project_id itself (ADR-0002). */
export const project = pgTable(
  "project",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    customerName: text("customer_name").notNull(),
    type: projectType("type").notNull(),
    // Legal dates: `date` columns as ISO strings, so no time zone can shift them.
    signingDeadline: date("signing_deadline", { mode: "string" }),
    defaultTgStart: date("default_tg_start", { mode: "string" }),
    defaultTgEnd: date("default_tg_end", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => staffUser.id),
  },
  (t) => [
    check("project_tg_dates_ordered", sql`${t.defaultTgStart} <= ${t.defaultTgEnd}`),
    // A ta_only project has no DSV track and no beE (process-and-lifecycle.md).
    check(
      "project_ta_only_has_no_tg_dates",
      sql`${t.type} <> 'ta_only' or (${t.signingDeadline} is null and ${t.defaultTgStart} is null and ${t.defaultTgEnd} is null)`,
    ),
    index("project_created_at_id_idx").on(t.createdAt.desc(), t.id.desc()),
  ],
);

export const tables = [staffUser, project];
