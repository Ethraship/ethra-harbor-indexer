export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const ERROR_DETAIL_KEYS = [
  "code",
  "reason",
  "shortMessage",
  "action",
  "method",
  "url",
  "status",
] as const;

function shouldLog(configuredLevel: LogLevel, messageLevel: LogLevel): boolean {
  return LEVEL_ORDER[messageLevel] >= LEVEL_ORDER[configuredLevel];
}

function stringifyValue(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unstringifiable]";
  }
}

function serializeErrorDetail(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return stringifyValue(value);
}

export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) {
    return {
      name: typeof error,
      message: stringifyValue(error),
    };
  }

  const serialized: SerializedError = {
    name: error.name || "Error",
    message: error.message,
  };

  if (typeof error.stack === "string") {
    serialized.stack = error.stack;
  }

  for (const key of ERROR_DETAIL_KEYS) {
    const value = (error as unknown as Record<string, unknown>)[key];

    if (value !== undefined) {
      serialized[key] = serializeErrorDetail(value);
    }
  }

  const cause = (error as { cause?: unknown }).cause;

  if (cause !== undefined) {
    serialized.cause =
      cause instanceof Error ? serializeError(cause) : serializeErrorDetail(cause);
  }

  return serialized;
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  return JSON.stringify(meta ? { ...meta, level, message } : { level, message });
}

export function createLogger(level: LogLevel) {
  return {
    debug(message: string, meta?: Record<string, unknown>): void {
      if (shouldLog(level, "debug")) {
        console.log(emit("debug", message, meta));
      }
    },
    info(message: string, meta?: Record<string, unknown>): void {
      if (shouldLog(level, "info")) {
        console.log(emit("info", message, meta));
      }
    },
    warn(message: string, meta?: Record<string, unknown>): void {
      if (shouldLog(level, "warn")) {
        console.warn(emit("warn", message, meta));
      }
    },
    error(message: string, meta?: Record<string, unknown>): void {
      if (shouldLog(level, "error")) {
        console.error(emit("error", message, meta));
      }
    },
  };
}
