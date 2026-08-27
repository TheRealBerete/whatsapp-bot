const IGNORED = [
  "failed to decrypt message",
  "sent retry receipt",
  "PreKeyError",
  "SessionError",
  "closing stale connection",
  "Invalid PreKey ID",
  "No session record",
];

function shouldIgnore(obj: unknown, msg?: string): boolean {
  const text = JSON.stringify(obj) + (msg ?? "");
  return IGNORED.some((i) => text.includes(i));
}

export const LOG_LEVEL = (process.env.LOG_LEVEL ?? "silent").toLowerCase();
const isDebug = LOG_LEVEL === "debug" || LOG_LEVEL === "trace";

export interface BaileysLogger {
  level: string;
  child(obj: Record<string, unknown>): BaileysLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

function makeLogger(prefix: string): BaileysLogger {
  return {
    level: LOG_LEVEL,
    child: () => makeLogger(prefix),
    trace: () => {},
    debug: (obj: unknown, msg?: string) => {
      if (isDebug) console.debug("[baileys:debug]", msg ?? "", obj);
    },
    info: (obj: unknown, msg?: string) => {
      if (isDebug) console.info("[baileys:info]", msg ?? "", typeof obj === "string" ? obj : "");
    },
    warn: (obj: unknown, msg?: string) => {
      if (!shouldIgnore(obj, msg)) console.warn("[baileys:warn]", msg ?? "", typeof obj === "string" ? obj : "");
    },
    error: (obj: unknown, msg?: string) => {
      if (!shouldIgnore(obj, msg)) console.error("[baileys:error]", msg ?? "", typeof obj === "string" ? obj : "");
    },
  };
}

export const baileysLogger: BaileysLogger = makeLogger("baileys:");
