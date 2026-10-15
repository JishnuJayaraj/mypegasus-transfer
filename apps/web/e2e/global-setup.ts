import { recreateTestDatabase } from "@transfer/db/testing";

/** transfer_e2e from scratch with the synthetic seed, before every run. */
export default async function globalSetup(): Promise<void> {
  await recreateTestDatabase("transfer_e2e", { seed: true });
}
