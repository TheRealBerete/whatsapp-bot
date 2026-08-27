import fs from "fs";
import path from "path";
import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { config, isOwner } from "../config";
import { isSudo } from "../database";
import { getCommand, isOnCooldown } from "../lib/command";
import { getBody, isBotSelfMessage } from "../lib/message";
import type { CommandContext } from "../lib/types";
import { isGroupJid } from "../lib/utils";
import { handleViewOnce } from "./viewonce";
import { handleAntilink, handleAntispam } from "./moderation";
import { storeMessage, handleRevoke, isRevokeMessage } from "./antidelete";
import { trackUnavailable, markResolved } from "../lib/unavailable";

function buildContext(sock: WASocket, msg: WAMessage, command: string, args: string): CommandContext {
  const sender = msg.key.participant ?? msg.key.remoteJid ?? "";
  const chat = msg.key.remoteJid ?? "";
  const isGroup = isGroupJid(chat);
  const ctx: CommandContext = {
    sock,
    msg,
    body: getBody(msg),
    command,
    args,
    sender,
    pushName: msg.pushName ?? "",
    chat,
    isGroup,
    isOwner: isOwner(sender),
    isSudo: isSudo(sender),
    prefix: config.prefix,
    reply: async (text, options = {}) => {
      try {
        return await sock.sendMessage(chat, { text, ...options }, { quoted: msg });
      } catch {
        return sock.sendMessage(chat, { text, ...options });
      }
    },
    react: async (emoji) => {
      try {
        return await sock.sendMessage(chat, { react: { text: emoji, key: msg.key } });
      } catch {
        return null;
      }
    },
  };
  return ctx;
}

const bg = (label: string, p: Promise<unknown>): void => {
  void p.catch((e) => console.error(`${label}:`, e));
};

export async function handleMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  if (isBotSelfMessage(msg)) return;
  if (msg.key.remoteJid === "status@broadcast") return;
  if (!msg.message) return;

  const chat = msg.key.remoteJid ?? "";
  const sender = msg.key.participant ?? msg.key.remoteJid ?? "";
  const body = getBody(msg);

  // Suppression de message (antidelete) : traité à part, on n'en fait pas une
  // commande.
  if (isRevokeMessage(msg)) {
    bg("handleRevoke", handleRevoke(sock, msg));
    return;
  }

  // Effets de bord indépendants de la commande → détachés pour ne pas
  // retarder le traitement de la commande (ni des messages suivants).
  handleViewOnce(sock, msg); // → Telegram, déjà détaché en interne
  if (isGroupJid(chat)) {
    bg("handleAntilink", handleAntilink(sock, msg));
    bg("handleAntispam", handleAntispam(sock, msg));
  }

  if (!body.startsWith(config.prefix)) return;

  const raw = body.slice(config.prefix.length).trim();
  if (!raw) return;

  const [cmdName, ...rest] = raw.split(/\s+/);
  const command = getCommand(cmdName);
  if (!command) return;

  const ctx = buildContext(sock, msg, cmdName, rest.join(" ").trim());

  if (command.isOwner && !ctx.isOwner) {
    await ctx.reply("❌ Commande réservée au propriétaire du bot.");
    return;
  }
  if (command.isSudo && !ctx.isSudo && !ctx.isOwner) {
    await ctx.reply("❌ Commande réservée aux administrateurs du bot.");
    return;
  }
  if (command.groupOnly && !ctx.isGroup) {
    await ctx.reply("❌ Cette commande fonctionne uniquement en groupe.");
    return;
  }

  const cd = isOnCooldown(sender, command);
  if (cd > 0) {
    await ctx.reply(`⏳ Attends ${Math.ceil(cd / 1000)}s avant de réutiliser cette commande.`);
    return;
  }

  try {
    await command.execute(ctx);
  } catch (e) {
    console.error(`Error in ${command.name}:`, e);
    await ctx.reply(`⚠️ Une erreur est survenue : ${(e as Error).message ?? "inconnue"}`);
  }
}

const MESSAGES_LOG = path.resolve("./data/messages.log");

export function registerMessageHandler(sock: WASocket): void {
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      // Contenu vide / stub non déchiffrable = média non livré à l'appareil
      // lié (view-once surtout). On demande au téléphone de renvoyer, avec
      // plusieurs relances échelonnées ; dès que le vrai contenu arrive, on
      // arrête d'insister.
      if (!msg.key.fromMe && msg.key.remoteJid !== "status@broadcast" && msg.key.id) {
        const empty = !msg.message || Object.keys(msg.message).length === 0;
        if (empty || msg.messageStubType) trackUnavailable(sock, msg.key);
        else markResolved(msg.key.id);
      }

      // stockage synchrone (Map) AVANT le dispatch : garantit qu'un message
      // est mémorisé avant que sa suppression n'arrive
      storeMessage(msg);

      fs.appendFile(
        MESSAGES_LOG,
        `[${new Date().toISOString()}] ${msg.key.remoteJid} fromMe=${msg.key.fromMe} id=${msg.key.id} stub=${msg.messageStubType} keys=${msg.message ? Object.keys(msg.message).join("+") : "none"} body=${JSON.stringify(getBody(msg).slice(0, 80))}\n`,
        () => {}
      );

      // traitement détaché : un message lent (download, IA…) ne bloque plus
      // ni les messages suivants ni le keep-alive de la connexion
      void handleMessage(sock, msg).catch((e) => console.error("handleMessage error:", e));
    }
  });
}
