import { availableParallelism } from "node:os";

/**
 * The worker count of the run and of every project: Vitest needs one value across the projects
 * that run together, so the CPU-bound projects (web, the jsdom wizard, parsing) share it with the
 * integration projects. One worker per core: more starved those of CPU until their 5 s timeouts
 * failed at random on 4 cores (ADR-0003, testing). Each worker gets its own database.
 * `--maxWorkers` still overrides it.
 */
export const maxWorkers = availableParallelism();
