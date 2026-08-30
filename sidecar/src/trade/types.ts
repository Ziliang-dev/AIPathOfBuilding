import { z } from "zod";

export const TRADE_SCHEMA_VERSION = 1 as const;
export const TRADE_DEFAULT_MAX_RESULTS = 10;
export const TRADE_DEFAULT_MAX_QUERIES = 18;
export const TRADE_DEFAULT_MAX_QUERY_LENGTH = 128 * 1024;
export const TRADE_DEFAULT_MAX_RAW_LENGTH = 32 * 1024;
export const TRADE_DEFAULT_CACHE_TTL_MS = 30_000;
export const TRADE_DEFAULT_DEADLINE_MS = 30_000;

const safeText = (max: number) => z.string().min(1).max(max).refine(
  (value) => !/[\u0000\r\n]/u.test(value),
  "value contains a forbidden control character",
);

export const TradeRealmSchema = z.enum(["pc", "xbox", "sony"]);
export type TradeRealm = z.infer<typeof TradeRealmSchema>;

export const TradeSearchQuerySchema = z.object({
  requestId: safeText(128).optional(),
  idempotencyKey: safeText(128).optional(),
  realm: TradeRealmSchema,
  league: safeText(96),
  slot: safeText(96),
  query: z.string().min(1).max(TRADE_DEFAULT_MAX_QUERY_LENGTH).refine(
    (value) => !/\u0000/u.test(value),
    "query contains a NUL byte",
  ),
  budgetDivine: z.number().finite().nonnegative(),
  maxResults: z.number().int().min(1).max(TRADE_DEFAULT_MAX_RESULTS).optional(),
  itemSetId: z.number().int().positive().optional(),
  ruleset: safeText(96).optional(),
});
export type TradeSearchQuery = z.infer<typeof TradeSearchQuerySchema>;

export const TradePriceSchema = z.object({
  amount: z.number().finite().positive(),
  currency: safeText(32).transform((value) => value.toLowerCase()),
  divineEquivalent: z.number().finite().nonnegative(),
});
export type TradePrice = z.infer<typeof TradePriceSchema>;

/** Whitelisted fields consumed from PoB's TradeQueryRequests result. */
export const TradeCatalogEntrySchema = z.object({
  id: safeText(128),
  domain: z.literal("gear"),
  kind: z.literal("tradeItem"),
  available: z.literal(true),
  source: z.literal("trade"),
  slot: safeText(96),
  itemSetId: z.number().int().positive().optional(),
  itemRaw: z.string().min(1).max(TRADE_DEFAULT_MAX_RAW_LENGTH),
  itemHash: z.string().regex(/^[0-9a-f]{64}$/u),
  queryHash: z.string().regex(/^[0-9a-f]{64}$/u),
  league: safeText(96),
  realm: TradeRealmSchema,
  price: TradePriceSchema,
  weight: z.number().finite().optional(),
});
export type TradeCatalogEntry = z.infer<typeof TradeCatalogEntrySchema>;

/** A raw upstream result. Unknown fields are deliberately ignored by the broker. */
export const TradeRawListingSchema = z.object({
  itemRaw: z.string().optional(),
  item_string: z.string().optional(),
  amount: z.number().finite().optional(),
  currency: z.string().optional(),
  priceType: z.string().optional(),
  price_type: z.string().optional(),
  weight: z.union([z.number().finite(), z.string()]).optional(),
}).passthrough();
export type TradeRawListing = z.infer<typeof TradeRawListingSchema>;

export type TradeBrokerErrorCode =
  | "invalid_query"
  | "budget_required"
  | "trade_invalid_response"
  | "trade_item_rejected"
  | "trade_auth_required"
  | "trade_rate_limited"
  | "trade_unavailable"
  | "trade_timeout"
  | "cancelled"
  | "idempotency_conflict";

export class TradeBrokerError extends Error {
  public readonly code: TradeBrokerErrorCode;
  public readonly retryAfterMs?: number;

  public constructor(code: TradeBrokerErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "TradeBrokerError";
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export interface TradeContentCatalogEntry {
  readonly id: string;
  readonly domain: "gear";
  readonly kind: "tradeItem";
  readonly available: true;
  readonly data: Readonly<Record<string, unknown>>;
}

export type TradeQueryTransport = (
  query: TradeSearchQuery,
  signal: AbortSignal,
) => Promise<readonly unknown[]>;
