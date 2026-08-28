import { TradeBroker, TradeBrokerError, type TradeQueryTransport } from "../src/trade/index.js";
import { describe, expect, it, vi } from "vitest";

const query = (overrides: Record<string, unknown> = {}) => ({
  requestId: "request-1",
  realm: "pc",
  league: "Settlers",
  slot: "Helmet",
  query: JSON.stringify({ query: { stats: [{ id: "explicit.life", value: { min: 80 } }] } }),
  budgetDivine: 5,
  maxResults: 10,
  ...overrides,
});

const listing = (overrides: Record<string, unknown> = {}) => ({
  amount: 2,
  currency: "divine",
  priceType: "~b/o",
  item_string: "Rarity: Rare\nTitanium Spirit Shield",
  trader: "must-not-leave-process",
  whisper: "@seller Hi!",
  id: "secret-listing-id",
  ...overrides,
});

describe("TradeBroker", () => {
  it("normalizes fixed-price listings and strips seller fields", () => {
    const broker = new TradeBroker();
    const [entry] = broker.normalizeResults([listing()], broker.validateQuery(query()));
    expect(entry).toMatchObject({
      source: "trade",
      slot: "Helmet",
      price: { amount: 2, currency: "divine", divineEquivalent: 2 },
    });
    expect(entry).not.toHaveProperty("trader");
    expect(entry).not.toHaveProperty("whisper");
    expect(entry).not.toHaveProperty("id", "secret-listing-id");
    expect(entry?.itemHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects negotiable, unknown-currency, and over-budget listings", () => {
    const broker = new TradeBroker({ currencyToDivine: (currency, amount) => currency === "chaos" ? amount / 100 : undefined });
    const validated = broker.validateQuery(query({ budgetDivine: 1 }));
    expect(broker.normalizeResults([listing({ priceType: "~price" })], validated)).toHaveLength(0);
    expect(broker.normalizeResults([listing({ currency: "mirror" })], validated)).toHaveLength(0);
    expect(broker.normalizeResults([listing({ amount: 2 })], validated)).toHaveLength(0);
    expect(broker.normalizeResults([listing({ amount: 501, currency: "chaos" })], validated)).toHaveLength(0);
  });

  it("uses Divine conversion with conservative rounding and budget", () => {
    const broker = new TradeBroker({ currencyToDivine: (currency, amount) => currency === "chaos" ? amount / 123 : undefined });
    const validated = broker.validateQuery(query({ budgetDivine: 3 }));
    const [entry] = broker.normalizeResults([listing({ amount: 123, currency: "chaos" })], validated);
    expect(entry?.price.divineEquivalent).toBe(1);
    const [rounded] = broker.normalizeResults([listing({ amount: 123.001, currency: "chaos" })], validated);
    expect(rounded?.price.divineEquivalent).toBe(1.0001);
  });

  it("deduplicates in-flight requests and serves the short-lived cache", async () => {
    let calls = 0;
    const transport: TradeQueryTransport = async () => {
      calls += 1;
      await Promise.resolve();
      return [listing()];
    };
    const broker = new TradeBroker({ cacheTtlMs: 10_000 });
    const first = broker.search(query(), transport);
    const second = broker.search(query(), transport);
    await expect(first).resolves.toHaveLength(1);
    await expect(second).resolves.toHaveLength(1);
    expect(calls).toBe(1);
    await expect(broker.search(query(), transport)).resolves.toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("enforces idempotency-key reuse", async () => {
    const broker = new TradeBroker();
    const transport: TradeQueryTransport = async () => [listing()];
    await broker.search(query({ idempotencyKey: "same", requestId: undefined }), transport);
    await expect(broker.search(query({ idempotencyKey: "same", requestId: undefined, slot: "Boots" }), transport))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("cancels a subscriber and ignores a late transport response", async () => {
    let release: ((value: readonly unknown[]) => void) | undefined;
    const transport: TradeQueryTransport = () => new Promise((resolve) => { release = resolve; });
    const broker = new TradeBroker({ cacheTtlMs: 10_000 });
    const controller = new AbortController();
    const pending = broker.search(query(), transport, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    release?.([listing()]);
    await Promise.resolve();
    expect(broker.getCached(query())).toBeUndefined();
  });

  it("settles a hung transport at the broker deadline", async () => {
    vi.useFakeTimers();
    try {
      const broker = new TradeBroker({ deadlineMs: 1_000 });
      const pending = broker.search(query(), () => new Promise<readonly unknown[]>(() => undefined));
      const assertion = expect(pending).rejects.toMatchObject({ code: "trade_timeout" });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for all queries at a barrier and fails closed on one error", async () => {
    const broker = new TradeBroker({ maxQueries: 2 });
    const transport: TradeQueryTransport = async (value) => {
      if (value.slot === "Boots") throw new TradeBrokerError("trade_rate_limited", "rate limited");
      return [listing()];
    };
    const result = broker.queryBarrier([
      query({ requestId: "helmet", slot: "Helmet" }),
      query({ requestId: "boots", slot: "Boots" }),
    ], transport);
    await expect(result).rejects.toMatchObject({ code: "trade_rate_limited" });
  });

  it("exposes a cancellable barrier handle", async () => {
    const broker = new TradeBroker();
    const transport: TradeQueryTransport = () => new Promise<readonly unknown[]>(() => undefined);
    const barrier = broker.startBarrier([query()], transport);
    expect(broker.cancel(barrier.id)).toBe(true);
    await expect(barrier.promise).rejects.toMatchObject({ code: "cancelled" });
  });

  it("emits a planner-ready catalog action without seller metadata", () => {
    const broker = new TradeBroker();
    const [entry] = broker.normalizeResults([listing()], broker.validateQuery(query()));
    const catalog = broker.toContentCatalogEntry(entry!);
    expect(catalog.data).toHaveProperty("metadata.source", "trade");
    expect(catalog.data).toHaveProperty("action.kind", "importAndEquip");
    expect(JSON.stringify(catalog)).not.toMatch(/trader|whisper|secret-listing-id/iu);
  });
});
