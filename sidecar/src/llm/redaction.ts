const REDACTED = "[REDACTED]";
const MAX_DEPTH = 64;

const SENSITIVE_KEYS = new Set([
  "accesstoken",
  "account",
  "accountid",
  "accountname",
  "apikey",
  "authorization",
  "bearer",
  "character",
  "characterid",
  "charactername",
  "contact",
  "cookie",
  "listingid",
  "importlink",
  "oauth",
  "oauthcode",
  "oauthstate",
  "password",
  "poesessid",
  "refreshtoken",
  "resultid",
  "seller",
  "sellerid",
  "sellername",
  "sessiontoken",
  "secret",
  "token",
  "tradeid",
  "whisper",
]);

const XML_IDENTITY_ATTRIBUTE =
  /\b(account(?:Name|Id)?|character(?:Name|Id)?|seller(?:Name|Id)?|listingId|tradeId|resultId|importLink|poesessid|accessToken|refreshToken|apiKey|token)\s*=\s*("[^"]*"|'[^']*')/gi;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_ASSIGNMENT =
  /\b(access[_-]?token|refresh[_-]?token|api[_-]?key|poesessid|authorization|import[_-]?link|account[_-]?(?:name|id)|character[_-]?(?:name|id)|seller[_-]?(?:name|id)|listing[_-]?id|trade[_-]?id)\b(\s*[:=]\s*)([^\s,;]+)/gi;

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.startsWith("oauth") ||
    normalized.includes("token") ||
    normalized.includes("apikey") ||
    normalized.includes("secret") ||
    /^(account|character|seller)(id|name)?$/.test(normalized) ||
    /^(trade|listing|result|tradequery|traderesult)id$/.test(normalized)
  );
}

export function redactString(value: string): string {
  return value
    .replace(XML_IDENTITY_ATTRIBUTE, "")
    .replace(AUTHORIZATION_VALUE, `${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, REDACTED);
}

export function redactForModel(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>();

  const visit = (current: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) {
      return "[TRUNCATED:MAX_DEPTH]";
    }
    if (typeof current === "string") {
      return redactString(current);
    }
    if (
      current === null ||
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "undefined"
    ) {
      return current;
    }
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (current instanceof Date) {
      return current.toISOString();
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        return "[CIRCULAR]";
      }
      const output: unknown[] = [];
      seen.set(current, output);
      for (const item of current) {
        output.push(visit(item, depth + 1));
      }
      return output;
    }
    if (typeof current === "object") {
      if (seen.has(current)) {
        return "[CIRCULAR]";
      }
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      seen.set(current, output);
      for (const [key, item] of Object.entries(current)) {
        if (!isSensitiveKey(key)) {
          output[key] = visit(item, depth + 1);
        }
      }
      return output;
    }
    return `[UNSUPPORTED:${typeof current}]`;
  };

  return visit(value, 0);
}

export function stringifyForModel(value: unknown): string {
  return JSON.stringify(redactForModel(value));
}
