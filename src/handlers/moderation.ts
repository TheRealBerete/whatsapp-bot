import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { getGroupSettings } from "../database";
import { getBody } from "../lib/message";

const URL_RE = /(https?:\/\/\S+|chat\.whatsapp\.com\/\S+|wa\.me\/\S+|discord\.gg\/\S+|t\.me\/\S+)/i;

async function isGroupAdmin(sock: WASocket, chat: string, sender: string): Promise<boolean> {
  try {
    const meta = await sock.groupMetadata(chat);
    return meta.participants.some((p) => p.id === sender && (p.admin === "admin" || p.admin === "superadmin"));
  } catch {
    return false;
  }
}

export async function handleAntilink(sock: WASocket, msg: WAMessage): Promise<void> {
  const chat = msg.key.remoteJid ?? "";
  if (!getGroupSettings(chat).antilink) return;
  if (msg.key.fromMe) return;
  const sender = msg.key.participant ?? msg.key.remoteJid ?? "";
  const body = getBody(msg);
  if (!body || !URL_RE.test(body)) return;
  if (await isGroupAdmin(sock, chat, sender)) return;

  await sock.sendMessage(chat, { delete: msg.key });
  await sock.sendMessage(chat, {
    text: `🚫 @${sender.split("@")[0]} — les liens sont interdits dans ce groupe.`,
    mentions: [sender],
  });
}

const spamTracker = new Map<string, { count: number; first: number; warned: boolean }>();

export async function handleAntispam(sock: WASocket, msg: WAMessage): Promise<void> {
  const chat = msg.key.remoteJid ?? "";
  if (!getGroupSettings(chat).antispam) return;
  if (msg.key.fromMe) return;
  const sender = msg.key.participant ?? msg.key.remoteJid ?? "";
  if (await isGroupAdmin(sock, chat, sender)) return;

  const key = `${chat}:${sender}`;
  const now = Date.now();
  const entry = spamTracker.get(key) ?? { count: 0, first: now, warned: false };
  entry.count += 1;

  if (entry.count === 1) entry.first = now;

  if (entry.count >= 8 && now - entry.first < 10_000) {
    spamTracker.delete(key);
    await sock.sendMessage(chat, { delete: msg.key });
    if (!entry.warned) {
      entry.warned = true;
      await sock.sendMessage(chat, {
        text: `⚠️ @${sender.split("@")[0]} — arrête le spam ou tu seras expulsé.`,
        mentions: [sender],
      });
    }
  } else if (now - entry.first > 10_000) {
    entry.count = 1;
    entry.first = now;
  }
  spamTracker.set(key, entry);
}
