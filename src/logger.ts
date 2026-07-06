/** Tiny structured logger. Keeps deps minimal; swap for pino if needed. */
type Level = "info" | "warn" | "error" | "debug";

function log(level: Level, msg: string, extra?: Record<string, unknown>) {
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(line));
}

export const logger = {
  info: (msg: string, extra?: Record<string, unknown>) => log("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => log("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => log("error", msg, extra),
  debug: (msg: string, extra?: Record<string, unknown>) => log("debug", msg, extra),
};
