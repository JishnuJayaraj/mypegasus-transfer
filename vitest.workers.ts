import { availableParallelism } from "node:os";

/**
 * The worker count of the run and of every project: Vitest needs one value across the projects
 * that run together. The integration projects (db, api) wait on PostgreSQL much of the time, so
 * there are more workers than cores; each worker gets its own database (ADR-0003, testing).
 * `--maxWorkers` still overrides it.
 */
export const maxWorkers = Math.ceil(availableParallelism() * 1.5);
