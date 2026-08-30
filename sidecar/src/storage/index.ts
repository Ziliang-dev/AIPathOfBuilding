import { join } from "node:path";
import type { PlannerStore } from "./types.js";
import { MemoryPlannerStore } from "./memory.js";

export type StorageWarningSink = (message: string) => void;

export async function createPlannerStore(
  dataDir: string,
  warn: StorageWarningSink = (message) => process.emitWarning(message),
): Promise<PlannerStore> {
  try {
    const { SidecarDatabase } = await import("./database.js");
    return new SidecarDatabase(join(dataDir, "aipob.sqlite"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`SQLite unavailable; using non-persistent in-memory planner store: ${detail}`);
    return new MemoryPlannerStore();
  }
}

export type { PlannerStore } from "./types.js";
export { MemoryPlannerStore } from "./memory.js";
