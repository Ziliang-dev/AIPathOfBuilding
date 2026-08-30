import { canonicalHash } from "../search/canonical.js";
import {
  TRADE_DEFAULT_CACHE_TTL_MS,
  TRADE_DEFAULT_DEADLINE_MS,
  TRADE_DEFAULT_MAX_QUERIES,
  TRADE_DEFAULT_MAX_RESULTS,
  TRADE_DEFAULT_MAX_RAW_LENGTH,
  TRADE_DEFAULT_MAX_QUERY_LENGTH,
  TradeCatalogEntrySchema,
  TradeRawListingSchema,
  TradeSearchQuerySchema,
  TradeBrokerError,
  type TradeBrokerErrorCode,
  type TradeCatalogEntry,
  type TradeContentCatalogEntry,
  type TradeQueryTransport,
  type TradeRawListing,
  type TradeSearchQuery,
} from "./types.js";

export interface TradeBrokerOptions {
  readonly maxResults?: number;
  readonly maxQueries?: number;
  readonly maxQueryLength?: number;
  readonly maxRawLength?: number;
  readonly cacheTtlMs?: number;
  readonly deadlineMs?: number;
  /** Return Divine-equivalent price, or undefined when conversion is unavailable. */
  readonly currencyToDivine?: (
    currency: string,
    amount: number,
    query: TradeSearchQuery,
  ) => number | undefined;
  readonly fixedPriceTypes?: ReadonlySet<string>;
}

interface CachedResult {
  readonly key: string;
  readonly result: readonly TradeCatalogEntry[];
  readonly expiresAt: number;
}

interface SharedRequest {
  readonly key: string;
  readonly query: TradeSearchQuery;
  readonly queryHash: string;
  readonly controller: AbortController;
  readonly cancel: () => void;
  promise: Promise<readonly TradeCatalogEntry[]>;
  readonly subscribers: Set<RequestState>;
  settled: boolean;
}

interface RequestState {
  readonly id: string;
  readonly key: string;
  readonly shared: SharedRequest;
  cancelled: boolean;
  done: boolean;
}

interface CompletedResult {
  readonly key: string;
  readonly result?: readonly TradeCatalogEntry[];
  readonly error?: TradeBrokerError;
  readonly expiresAt: number;
}

export interface TradeBarrierHandle {
  readonly id: string;
  readonly controller: AbortController;
  readonly promise: Promise<Readonly<Record<string, readonly TradeCatalogEntry[]>>>;
}

const REALM_VALUES = new Set(["pc", "xbox", "sony"]);
const DEFAULT_FIXED_PRICE_TYPES = new Set(["~b/o", "fixed", "buyout"]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function roundUpDivine(value: number): number {
  return Math.ceil((value * 10_000) - 1e-9) / 10_000;
}

function abortError(signal: AbortSignal): TradeBrokerError {
  if (signal.reason instanceof TradeBrokerError) return signal.reason;
  return new TradeBrokerError("cancelled", "Trade query cancelled");
}

function asBrokerError(error: unknown): TradeBrokerError {
  if (error instanceof TradeBrokerError) return error;
  if (typeof error === "object" && error !== null) {
    const value = error as Record<string, unknown>;
    const code = value.code;
    const message = value.message;
    if (typeof message === "string") {
      if (code === "trade_auth_required" || code === "trade_rate_limited" || code === "trade_unavailable") {
        return new TradeBrokerError(code, message);
      }
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("429") || lower.includes("rate")) {
    return new TradeBrokerError("trade_rate_limited", "Trade rate limit reached");
  }
  if (lower.includes("401") || lower.includes("invalid_token") || lower.includes("authorization")) {
    return new TradeBrokerError("trade_auth_required", "Trade authorization is required");
  }
  if (lower.includes("timeout")) return new TradeBrokerError("trade_timeout", "Trade query deadline exceeded");
  if (lower.includes("cancel")) return new TradeBrokerError("cancelled", "Trade query cancelled");
  return new TradeBrokerError("trade_unavailable", "Trade request failed");
}

export class TradeBroker {
  readonly maxResults: number;
  readonly maxQueries: number;
  readonly maxQueryLength: number;
  readonly maxRawLength: number;
  readonly cacheTtlMs: number;
  readonly deadlineMs: number;
  readonly fixedPriceTypes: ReadonlySet<string>;

  readonly #currencyToDivine: (
    currency: string,
    amount: number,
    query: TradeSearchQuery,
  ) => number | undefined;
  readonly #cache = new Map<string, CachedResult>();
  readonly #inflight = new Map<string, SharedRequest>();
  readonly #active = new Map<string, RequestState>();
  readonly #completed = new Map<string, CompletedResult>();
  readonly #barriers = new Map<string, TradeBarrierHandle>();
  #nextRequestId = 1;
  #nextBarrierId = 1;

  public constructor(options: TradeBrokerOptions = {}) {
    this.maxResults = Math.max(1, Math.min(options.maxResults ?? TRADE_DEFAULT_MAX_RESULTS, TRADE_DEFAULT_MAX_RESULTS));
    this.maxQueries = Math.max(1, Math.min(options.maxQueries ?? TRADE_DEFAULT_MAX_QUERIES, 64));
    this.maxQueryLength = Math.max(1_024, Math.min(options.maxQueryLength ?? TRADE_DEFAULT_MAX_QUERY_LENGTH, 1_024 * 1_024));
    this.maxRawLength = Math.max(1_024, Math.min(options.maxRawLength ?? TRADE_DEFAULT_MAX_RAW_LENGTH, 256 * 1_024));
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? TRADE_DEFAULT_CACHE_TTL_MS);
    this.deadlineMs = Math.max(1_000, options.deadlineMs ?? TRADE_DEFAULT_DEADLINE_MS);
    this.fixedPriceTypes = options.fixedPriceTypes ?? DEFAULT_FIXED_PRICE_TYPES;
    this.#currencyToDivine = options.currencyToDivine ?? ((currency, amount) =>
      currency.toLowerCase() === "divine" ? amount : undefined);
  }

  public validateQuery(input: unknown): TradeSearchQuery {
    const parsed = TradeSearchQuerySchema.safeParse(input);
    if (!parsed.success) throw new TradeBrokerError("invalid_query", "Trade query does not match the broker schema");
    const query = parsed.data;
    if (!REALM_VALUES.has(query.realm)) throw new TradeBrokerError("invalid_query", "Trade realm is invalid");
    if (query.query.length > this.maxQueryLength) throw new TradeBrokerError("invalid_query", "Trade query JSON is too large");
    let decoded: unknown;
    try {
      decoded = JSON.parse(query.query) as unknown;
    } catch {
      throw new TradeBrokerError("invalid_query", "Trade query JSON is malformed");
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new TradeBrokerError("invalid_query", "Trade query JSON must be an object");
    }
    return clone(query);
  }

  public queryHash(query: TradeSearchQuery): string {
    let decoded: unknown;
    try {
      decoded = JSON.parse(query.query) as unknown;
    } catch {
      throw new TradeBrokerError("invalid_query", "Trade query JSON is malformed");
    }
    return canonicalHash({
      realm: query.realm,
      league: query.league,
      slot: query.slot,
      ruleset: query.ruleset,
      query: decoded,
    });
  }

  public cacheKey(query: TradeSearchQuery, queryHash = this.queryHash(query)): string {
    return canonicalHash({
      queryHash,
      budgetDivine: query.budgetDivine,
      maxResults: query.maxResults ?? this.maxResults,
      pricePolicy: "fixed-divine-v1",
    });
  }

  /** Whitelist and normalize Lua TradeQueryRequests output. */
  public normalizeResults(
    input: readonly unknown[],
    queryInput: TradeSearchQuery,
    queryHash?: string,
  ): readonly TradeCatalogEntry[] {
    const query = this.validateQuery(queryInput);
    const effectiveQueryHash = queryHash ?? this.queryHash(query);
    const output: TradeCatalogEntry[] = [];
    const seen = new Set<string>();
    const maximum = Math.min(query.maxResults ?? this.maxResults, this.maxResults);
    for (const candidate of input) {
      const parsed = TradeRawListingSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const raw: TradeRawListing = parsed.data;
      const itemRaw = raw.itemRaw ?? raw.item_string;
      const amount = raw.amount;
      const currency = raw.currency?.toLowerCase();
      const priceType = (raw.priceType ?? raw.price_type)?.toLowerCase();
      if (
        output.length >= maximum
        || itemRaw === undefined
        || itemRaw.length === 0
        || itemRaw.length > this.maxRawLength
        || itemRaw.includes("\u0000")
        || amount === undefined
        || !finite(amount)
        || amount <= 0
        || currency === undefined
        || currency.length === 0
        || currency.length > 32
        || priceType === undefined
        || !this.fixedPriceTypes.has(priceType)
      ) continue;
      let divineEquivalent: number | undefined;
      try {
        divineEquivalent = this.#currencyToDivine(currency, amount, query);
      } catch {
        divineEquivalent = undefined;
      }
      if (divineEquivalent === undefined || !finite(divineEquivalent) || divineEquivalent < 0) continue;
      divineEquivalent = roundUpDivine(divineEquivalent);
      if (divineEquivalent > query.budgetDivine) continue;
      const itemHash = canonicalHash(itemRaw);
      const dedupeKey = `${itemHash}:${currency}:${divineEquivalent}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const priceHash = canonicalHash(dedupeKey);
      const numericWeight = typeof raw.weight === "number"
        ? raw.weight
        : typeof raw.weight === "string" && raw.weight.trim() !== "" ? Number(raw.weight) : undefined;
      const entry = TradeCatalogEntrySchema.parse({
        id: `trade:${effectiveQueryHash.slice(0, 20)}:${priceHash.slice(0, 20)}`,
        domain: "gear",
        kind: "tradeItem",
        available: true,
        source: "trade",
        slot: query.slot,
        ...(query.itemSetId === undefined ? {} : { itemSetId: query.itemSetId }),
        itemRaw,
        itemHash,
        queryHash: effectiveQueryHash,
        league: query.league,
        realm: query.realm,
        price: { amount, currency, divineEquivalent },
        ...(numericWeight !== undefined && finite(numericWeight) ? { weight: numericWeight } : {}),
      });
      output.push(entry);
    }
    return output;
  }

  /** Convert a safe result to the ContentCatalog shape expected by PlannerController. */
  public toContentCatalogEntry(entry: TradeCatalogEntry): TradeContentCatalogEntry {
    const action = {
      id: `action:${entry.id}`,
      kind: "importAndEquip",
      description: `Import and equip trade item in ${entry.slot}`,
      dependsOn: [],
      preconditions: [],
      reversible: true,
      costDivine: entry.price.divineEquivalent,
      payload: {
        slot: entry.slot,
        ...(entry.itemSetId === undefined ? {} : { itemSetId: entry.itemSetId }),
        itemRaw: entry.itemRaw,
        itemHash: entry.itemHash,
        catalogId: entry.id,
        source: "trade",
        price: entry.price,
      },
    } as const;
    return {
      id: entry.id,
      domain: "gear",
      kind: "tradeItem",
      available: true,
      data: {
        metadata: { source: "trade", catalogId: entry.id, touches: [`gear.${entry.slot}`] },
        action,
        itemRaw: entry.itemRaw,
        itemHash: entry.itemHash,
        queryHash: entry.queryHash,
        slot: entry.slot,
        ...(entry.itemSetId === undefined ? {} : { itemSetId: entry.itemSetId }),
        price: entry.price,
        league: entry.league,
        realm: entry.realm,
      },
    };
  }

  private newRequestId(query: TradeSearchQuery): string {
    return query.requestId ?? query.idempotencyKey ?? `trade-request-${this.#nextRequestId++}`;
  }

  private startShared(
    query: TradeSearchQuery,
    key: string,
    queryHash: string,
    transport: TradeQueryTransport,
  ): SharedRequest {
    const controller = new AbortController();
    let cancelRequest: (() => void) | undefined;
    let timedOut = false;
    const cancelPromise = new Promise<readonly unknown[]>((_, reject) => {
      cancelRequest = () => reject(new TradeBrokerError("cancelled", "Trade query cancelled"));
    });
    let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
    const deadlinePromise = new Promise<readonly unknown[]>((_, reject) => {
      deadlineHandle = setTimeout(() => {
        timedOut = true;
        controller.abort(new TradeBrokerError("trade_timeout", "Trade query deadline exceeded"));
        reject(new TradeBrokerError("trade_timeout", "Trade query deadline exceeded"));
      }, this.deadlineMs);
      deadlineHandle.unref?.();
    });
    const transportPromise = Promise.resolve().then(() => transport(query, controller.signal));
    transportPromise.catch(() => undefined);
    const shared: SharedRequest = {
      key,
      query,
      queryHash,
      controller,
      cancel: () => {
        if (shared.settled) return;
        controller.abort(new TradeBrokerError("cancelled", "Trade query cancelled"));
        cancelRequest?.();
      },
      promise: Promise.resolve([]),
      subscribers: new Set<RequestState>(),
      settled: false,
    };
    const promise = (async (): Promise<readonly TradeCatalogEntry[]> => {
      try {
        const raw = await Promise.race([transportPromise, deadlinePromise, cancelPromise]);
        if (timedOut) throw new TradeBrokerError("trade_timeout", "Trade query deadline exceeded");
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof TradeBrokerError
            ? controller.signal.reason
            : new TradeBrokerError("cancelled", "Trade query cancelled");
        }
        const result = this.normalizeResults(raw, query, queryHash);
        if (this.cacheTtlMs > 0 && [...shared.subscribers].some((subscriber) => !subscriber.cancelled)) {
          this.#cache.set(key, { key, result: clone(result), expiresAt: Date.now() + this.cacheTtlMs });
        }
        return result;
      } catch (error) {
        throw asBrokerError(error);
      } finally {
        if (deadlineHandle !== undefined) clearTimeout(deadlineHandle);
        shared.settled = true;
        if (this.#inflight.get(key) === shared) this.#inflight.delete(key);
      }
    })();
    promise.catch(() => undefined);
    shared.promise = promise;
    this.#inflight.set(key, shared);
    return shared;
  }

  private waitFor(state: RequestState, signal?: AbortSignal): Promise<readonly TradeCatalogEntry[]> {
    if (signal?.aborted) {
      this.cancel(state.id);
      return Promise.reject(abortError(signal));
    }
    return new Promise<readonly TradeCatalogEntry[]>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        this.cancel(state.id);
        reject(abortError(signal as AbortSignal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      state.shared.promise.then(
        (result) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          if (!state.cancelled) resolve(clone(result));
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(asBrokerError(error));
        },
      );
    });
  }

  public search(input: unknown, transport: TradeQueryTransport, signal?: AbortSignal): Promise<readonly TradeCatalogEntry[]> {
    let query: TradeSearchQuery;
    try {
      query = this.validateQuery(input);
    } catch (error) {
      return Promise.reject(asBrokerError(error));
    }
    const requestId = this.newRequestId(query);
    const queryHash = this.queryHash(query);
    const key = this.cacheKey(query, queryHash);
    const existing = this.#active.get(requestId);
    if (existing) {
      if (existing.key !== key) return Promise.reject(new TradeBrokerError("idempotency_conflict", "requestId was reused for a different Trade query"));
      return this.waitFor(existing, signal);
    }
    const completed = this.#completed.get(requestId);
    if (completed && completed.expiresAt >= Date.now()) {
      if (completed.key !== key) return Promise.reject(new TradeBrokerError("idempotency_conflict", "requestId was reused for a different Trade query"));
      return completed.error ? Promise.reject(completed.error) : Promise.resolve(clone(completed.result ?? []));
    }
    if (completed) this.#completed.delete(requestId);
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt >= Date.now()) {
      const result = clone(cached.result);
      this.#completed.set(requestId, { key, result, expiresAt: cached.expiresAt });
      return Promise.resolve(result);
    }
    if (cached) this.#cache.delete(key);
    const shared = this.#inflight.get(key) ?? this.startShared(query, key, queryHash, transport);
    const state: RequestState = { id: requestId, key, shared, cancelled: false, done: false };
    shared.subscribers.add(state);
    this.#active.set(requestId, state);
    const result = this.waitFor(state, signal);
    shared.promise.then(
      (value) => {
        if (state.done) return;
        state.done = true;
        this.#active.delete(requestId);
        if (!state.cancelled) this.#completed.set(requestId, { key, result: clone(value), expiresAt: Date.now() + this.cacheTtlMs });
      },
      (error: unknown) => {
        if (state.done) return;
        state.done = true;
        this.#active.delete(requestId);
        if (!state.cancelled) this.#completed.set(requestId, { key, error: asBrokerError(error), expiresAt: Date.now() + this.cacheTtlMs });
      },
    );
    return result;
  }

  public cancel(requestId: string): boolean {
    const barrier = this.#barriers.get(requestId);
    if (barrier) {
      barrier.controller.abort(new TradeBrokerError("cancelled", "Trade query barrier cancelled"));
      return true;
    }
    const state = this.#active.get(requestId);
    if (!state || state.done) return false;
    state.cancelled = true;
    state.done = true;
    this.#active.delete(requestId);
    const activeSubscribers = [...state.shared.subscribers].filter((subscriber) => !subscriber.cancelled && !subscriber.done);
    if (activeSubscribers.length === 0) state.shared.cancel();
    return true;
  }

  public startBarrier(
    inputs: readonly unknown[],
    transport: TradeQueryTransport,
    signal?: AbortSignal,
  ): TradeBarrierHandle {
    if (inputs.length === 0 || inputs.length > this.maxQueries) {
      const id = `trade-barrier-${this.#nextBarrierId++}`;
      const promise = Promise.reject<Readonly<Record<string, readonly TradeCatalogEntry[]>>>(
        new TradeBrokerError("invalid_query", "Trade query barrier size is invalid"),
      );
      promise.catch(() => undefined);
      const handle = { id, controller: new AbortController(), promise };
      return handle;
    }
    const id = `trade-barrier-${this.#nextBarrierId++}`;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(abortError(signal as AbortSignal));
    if (signal?.aborted) controller.abort(abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    const promise = (async (): Promise<Readonly<Record<string, readonly TradeCatalogEntry[]>>> => {
      try {
        const values = await Promise.all(inputs.map((input) => {
          const query = this.validateQuery(input);
          const requestId = this.newRequestId(query);
          return this.search({ ...query, requestId }, transport, controller.signal)
            .then((result) => [requestId, result] as const);
        }));
        return Object.fromEntries(values.map(([requestId, result]) => [requestId, result]));
      } finally {
        signal?.removeEventListener("abort", onAbort);
        this.#barriers.delete(id);
      }
    })();
    const handle: TradeBarrierHandle = { id, controller, promise };
    this.#barriers.set(id, handle);
    promise.catch(() => undefined);
    return handle;
  }

  public queryBarrier(
    inputs: readonly unknown[],
    transport: TradeQueryTransport,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, readonly TradeCatalogEntry[]>>> {
    return this.startBarrier(inputs, transport, signal).promise;
  }

  public getCached(input: unknown): readonly TradeCatalogEntry[] | undefined {
    let query: TradeSearchQuery;
    try {
      query = this.validateQuery(input);
    } catch {
      return undefined;
    }
    const key = this.cacheKey(query);
    const cached = this.#cache.get(key);
    if (!cached || cached.expiresAt < Date.now()) {
      this.#cache.delete(key);
      return undefined;
    }
    return clone(cached.result);
  }

  public clearCache(): void {
    this.#cache.clear();
    this.#completed.clear();
  }

  public static errorCode(error: unknown): TradeBrokerErrorCode {
    return asBrokerError(error).code;
  }
}
