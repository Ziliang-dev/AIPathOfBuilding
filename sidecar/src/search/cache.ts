import type { PlannerStore } from "../storage/types.js";
import type { MetricVector } from "./types.js";

/** Evaluation cache seam. PlannerStore is the persistent adapter. */
export interface EvaluationCache {
  get(key: string): MetricVector | undefined;
  set(key: string, metrics: MetricVector): void;
}

export class PlannerStoreEvaluationCache implements EvaluationCache {
  readonly #store: Pick<PlannerStore, "getCache" | "setCache">;

  public constructor(store: Pick<PlannerStore, "getCache" | "setCache">) {
    this.#store = store;
  }

  public get(key: string): MetricVector | undefined {
    return this.#store.getCache<MetricVector>(key);
  }

  public set(key: string, metrics: MetricVector): void {
    this.#store.setCache(key, metrics);
  }
}
