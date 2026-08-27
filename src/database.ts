import Database from "better-sqlite3";
import { config } from "./config";

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS groups (
    jid TEXT PRIMARY KEY,
    antilink INTEGER DEFAULT 0,
    antispam INTEGER DEFAULT 0,
    antidelete INTEGER DEFAULT 0,
    autoview INTEGER DEFAULT 0,
    welcome INTEGER DEFAULT 0,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sudo (
    jid TEXT PRIMARY KEY,
    added_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS chat_history (
    jid TEXT PRIMARY KEY,
    history TEXT DEFAULT '[]'
  );
`);

export interface GroupSettings {
  antilink: boolean;
  antispam: boolean;
  antidelete: boolean;
  autoview: boolean;
  welcome: boolean;
}

const DEFAULT_GROUP: GroupSettings = {
  antilink: false,
  antispam: false,
  antidelete: false,
  autoview: false,
  welcome: false,
};

export function getSetting(key: string, fallback = ""): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function getGroupSettings(jid: string): GroupSettings {
  const row = db.prepare("SELECT * FROM groups WHERE jid = ?").get(jid) as
    | Record<string, unknown>
    | undefined;
  if (!row) return { ...DEFAULT_GROUP };
  return {
    antilink: !!row.antilink,
    antispam: !!row.antispam,
    antidelete: !!row.antidelete,
    autoview: !!row.autoview,
    welcome: !!row.welcome,
  };
}

export function setGroupSetting(jid: string, key: keyof GroupSettings, value: boolean): void {
  db.prepare(
    `INSERT INTO groups (jid, ${key}) VALUES (?, ?)
     ON CONFLICT(jid) DO UPDATE SET ${key} = excluded.${key}`
  ).run(jid, value ? 1 : 0);
}

export function ensureGroup(jid: string): void {
  db.prepare("INSERT OR IGNORE INTO groups (jid, created_at) VALUES (?, ?)").run(
    jid,
    Date.now()
  );
}

export function isSudo(jid: string): boolean {
  const row = db.prepare("SELECT jid FROM sudo WHERE jid = ?").get(jid);
  return !!row;
}

export function addSudo(jid: string): void {
  db.prepare("INSERT OR IGNORE INTO sudo (jid, added_at) VALUES (?, ?)").run(jid, Date.now());
}

export function removeSudo(jid: string): void {
  db.prepare("DELETE FROM sudo WHERE jid = ?").run(jid);
}

export function listSudo(): string[] {
  return (db.prepare("SELECT jid FROM sudo").all() as { jid: string }[]).map((r) => r.jid);
}

export function getChatHistory(jid: string): Array<{ role: string; content: string }> {
  const row = db.prepare("SELECT history FROM chat_history WHERE jid = ?").get(jid) as
    | { history: string }
    | undefined;
  if (!row) return [];
  try {
    return JSON.parse(row.history);
  } catch {
    return [];
  }
}

export function setChatHistory(jid: string, history: Array<{ role: string; content: string }>): void {
  db.prepare(
    "INSERT INTO chat_history (jid, history) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET history = excluded.history"
  ).run(jid, JSON.stringify(history));
}

export default db;
