import { recreateTestDatabase } from "./index";

/** Vitest global setup: integration tests run against a freshly migrated `transfer_test`. */
export default async function setup(): Promise<void> {
  await recreateTestDatabase();
}
