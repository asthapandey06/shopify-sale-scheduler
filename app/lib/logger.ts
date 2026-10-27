/**
 * Structured JSON logger with secret redaction.
 *
 * Never log raw request bodies, sessions or tokens. Anything passed in the
 * context object is scrubbed: keys that look like secrets are replaced, token
 * and credential patterns inside strings are masked, and long strings are truncated.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const SECRET_KEY_RE = /token|secret|password|passwd|authorization|cookie|api[-_]?key|session|credential|signature|hmac/i;
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_STRING = 500;
// Secrets that can hide inside messages: Shopify tokens, bearer tokens, passwords in connection URLs.
const SECRET_VALUE_RES: [RegExp, string][] = [
  [/\bshp[a-z]{2}_[A-Za-z0-9]+/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/:\/\/[^\s/@:]+:[^\s/@]+@/g, "://[redacted]@"],
];

function maskSecrets(value: string): string {
  return SECRET_VALUE_RES.reduce((out, [re, replacement]) => out.replace(re, replacement), value);
}
const MAX_DEPTH = 4;

export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    const masked = maskSecrets(value);
    return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…[truncated]` : masked;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1) };
  }
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function createLogger(
  options: { level?: LogLevel; write?: (line: string, level: LogLevel) => void } = {},
): Logger {
  const minLevel = LEVEL_ORDER[options.level ?? "info"];
  const write =
    options.write ??
    ((line: string, level: LogLevel) => {
      if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    });

  const emit = (level: LogLevel, message: string, context?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < minLevel) return;
    const entry = { time: new Date().toISOString(), level, message, ...(redact(context ?? {}) as object) };
    write(JSON.stringify(entry), level);
  };

  return {
    debug: (m, c) => emit("debug", m, c),
    info: (m, c) => emit("info", m, c),
    warn: (m, c) => emit("warn", m, c),
    error: (m, c) => emit("error", m, c),
  };
}

function envLevel(): LogLevel {
  const raw = (typeof process !== "undefined" ? process.env.LOG_LEVEL : undefined)?.toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

export const logger: Logger = createLogger({ level: envLevel() });
