import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason,
  type WASocket,
  type ConnectionState,
  type AnyMessageContent,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { config } from "../config";
import { baileysLogger } from "./logger";
import { recallMessage, rememberMessage } from "./msg-store";

export interface StartOptions {
  setup?: (sock: WASocket) => void;
}

/* ------------------------------------------------------------------ */
/*  État du gestionnaire de connexion                                  */
/* ------------------------------------------------------------------ */

let sock: WASocket | null = null;
let startOpts: StartOptions = {};

let connecting = false; // un seul `connect()` en vol à la fois
let stopped = false; // arrêt volontaire : on ne se reconnecte plus
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0; // compteur pour le backoff exponentiel
let everOnline = false;

let ownerJids: string[] = [];

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function getSock(): WASocket {
  if (!sock) throw new Error("Socket non initialisé");
  return sock;
}

export async function notifyOwner(text: string): Promise<void> {
  if (!sock) return;
  const jids =
    ownerJids.length > 0
      ? ownerJids
      : config.ownerNumbers.map((n) => `${n.replace(/\D/g, "")}@s.whatsapp.net`);
  for (const jid of jids) {
    try {
      await sock.sendMessage(jid, { text });
    } catch {
      /* ignore */
    }
  }
}

/** Code de statut HTTP-like renvoyé par WhatsApp à la fermeture (Boom). */
function closeStatus(state: Partial<ConnectionState>): number | undefined {
  const err = state.lastDisconnect?.error as
    | { output?: { statusCode?: number } }
    | undefined;
  return err?.output?.statusCode;
}

function reasonName(code: number | undefined): string {
  if (code == null) return "inconnu";
  const entry = Object.entries(DisconnectReason).find(([, v]) => v === code);
  return entry ? `${entry[0]} (${code})` : String(code);
}

function backoffDelay(): number {
  // 1s, 2s, 4s, 8s … plafonné à 60s, + jitter pour éviter les reconnexions synchronisées
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  attempt += 1;
  return exp + Math.floor(Math.random() * 1_000);
}

function scheduleReconnect(delayMs: number): void {
  if (stopped || reconnectTimer) return;
  const secs = Math.round(delayMs / 1000);
  console.log(`🔄 Reconnexion dans ${secs}s (tentative ${attempt})…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delayMs);
}

/**
 * Détache proprement l'ancien socket AVANT d'en créer un nouveau.
 * Sans ça, `sock.end()` fait ré-émettre `connection.update: close` sur
 * l'ancien socket (dont les listeners sont toujours branchés) → une
 * deuxième reconnexion se programme → 2, 4, 8 sockets concurrents sur la
 * même identité → WhatsApp coupe tout. C'était la « tempête de reconnexion ».
 */
function teardown(old: WASocket | null): void {
  if (!old) return;
  try {
    old.ev.removeAllListeners("connection.update");
    old.ev.removeAllListeners("creds.update");
    old.ev.removeAllListeners("messages.upsert");
  } catch {
    /* ignore */
  }
  try {
    old.end(undefined);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/*  Cycle de connexion                                                 */
/* ------------------------------------------------------------------ */

async function handleClose(state: Partial<ConnectionState>): Promise<void> {
  connecting = false;
  const code = closeStatus(state);
  console.log(`🔌 Connexion fermée — raison : ${reasonName(code)}`);

  switch (code) {
    case DisconnectReason.loggedOut: // 401
      stopped = true;
      console.error(
        "⛔ WhatsApp a déconnecté cette session (logged out).\n" +
          "   Un ré-appairage est nécessaire : `npm run pair`."
      );
      void notifyOwner(
        `⛔ *${config.botName}* déconnecté par WhatsApp (logged out). Ré-appairage requis.`
      );
      return;

    case DisconnectReason.connectionReplaced: // 440
      stopped = true;
      console.error(
        "⛔ Une autre instance s'est connectée avec cette session.\n" +
          "   Cette instance s'arrête pour ne pas entrer en guerre de reconnexion.\n" +
          "   (Ne lance qu'UN seul bot à la fois sur la même session.)"
      );
      void notifyOwner(
        `⛔ *${config.botName}* : une autre instance a pris la connexion. Arrêt de celle-ci.`
      );
      return;

    case DisconnectReason.badSession: // 500
      stopped = true;
      console.error(
        "⛔ Session corrompue (badSession). Nettoie et ré-appaire :\n" +
          "   rm -rf session session-pair && npm run pair"
      );
      void notifyOwner(`⛔ *${config.botName}* : session corrompue. Ré-appairage requis.`);
      return;

    case DisconnectReason.multideviceMismatch: // 411
      stopped = true;
      console.error("⛔ Incohérence multi-appareils. Ré-appairage nécessaire : `npm run pair`.");
      void notifyOwner(`⛔ *${config.botName}* : incohérence multi-appareils. Ré-appairage requis.`);
      return;

    case DisconnectReason.restartRequired: // 515
      // Normal juste après un appairage : WhatsApp demande un redémarrage
      // du flux avec les nouvelles credentials. On reconnecte tout de suite.
      console.log("↻ restart required (normal après appairage) — reconnexion immédiate.");
      scheduleReconnect(0);
      return;

    default:
      // 408 timedOut, 428 connectionClosed, 503 unavailable, réseau coupé, undefined…
      if (everOnline && attempt === 0) {
        void notifyOwner(`🔴 *${config.botName}* a perdu la connexion. Reconnexion…`).catch(() => {});
      }
      scheduleReconnect(backoffDelay());
  }
}

function handleOpen(): void {
  connecting = false;
  const wasReconnect = everOnline;
  everOnline = true;
  attempt = 0; // reset du backoff : on est revenu

  ownerJids = config.ownerNumbers.map((n) => `${n.replace(/\D/g, "")}@s.whatsapp.net`);
  console.log(`\n✅ CONNECTÉ — ${config.botName} est en ligne.`);

  if (config.ownerNumbers.length > 0) {
    void notifyOwner(
      wasReconnect ? `🟢 *${config.botName}* reconnecté.` : `🟢 *${config.botName}* est en ligne !`
    );
  }
}

async function handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
  const { connection, qr } = update;

  if (qr) {
    console.log(
      "\n📱 Scanne ce QR code avec WhatsApp (Appareils liés → Lier un appareil) :\n"
    );
    qrcode.generate(qr, { small: true });
  }

  if (connection === "connecting") console.log("… connexion à WhatsApp");
  if (connection === "open") handleOpen();
  if (connection === "close") await handleClose(update);
}

/**
 * (Re)crée le socket. Idempotent : si une connexion est déjà en cours, on
 * ne fait rien (garde `connecting`).
 */
async function connect(): Promise<WASocket> {
  if (connecting && sock) return sock;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connecting = true;

  teardown(sock);
  sock = null;

  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);

  const ws = makeWASocket({
    auth: {
      creds: state.creds,
      // cache en RAM des clés Signal (TTL 5 min) : moins de lectures disque,
      // moins de thrash sur les fichiers session-*.json
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as never),
    },
    browser: Browsers.ubuntu("Chrome"),
    printQRInTerminal: false,
    // le bot ne se déclare PAS "en ligne" : le téléphone principal reste
    // l'appareil prioritaire pour la livraison, ce qui fiabilise le relais
    // des médias view-once vers l'appareil lié
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    // ping plus fréquent (défaut 30s) → détection plus rapide d'une
    // connexion morte, donc reconnexion plus rapide
    keepAliveIntervalMs: 15_000,
    logger: baileysLogger as never,
    // clé de voûte du chantier 1 : permet de répondre aux retry receipts
    getMessage: async (key) => recallMessage(key.id),
  });

  sock = ws;

  ws.ev.on("creds.update", saveCreds);
  ws.ev.on("connection.update", (u) => void handleConnectionUpdate(u));

  // Mémoriser tout ce qui passe (nos envois ET les messages entrants) pour
  // pouvoir les re-fournir sur retry receipt.
  ws.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) rememberMessage(m);
  });

  // Mémoriser aussi le retour de sendMessage : le retry receipt peut arriver
  // avant même l'écho `messages.upsert` de notre propre message.
  const origSend = ws.sendMessage.bind(ws);
  ws.sendMessage = (async (jid: string, content: AnyMessageContent, options?: unknown) => {
    const sent = await origSend(jid, content, options as never);
    rememberMessage(sent);
    return sent;
  }) as typeof ws.sendMessage;

  startOpts.setup?.(ws);

  connecting = false;
  return ws;
}

export async function startBot(opts: StartOptions = {}): Promise<WASocket> {
  startOpts = opts;
  stopped = false;
  attempt = 0;
  everOnline = false;
  return connect();
}
