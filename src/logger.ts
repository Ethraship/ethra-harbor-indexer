export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(configuredLevel: LogLevel, messageLevel: LogLevel): boolean {
  return LEVEL_ORDER[messageLevel] >= LEVEL_ORDER[configuredLevel];
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
