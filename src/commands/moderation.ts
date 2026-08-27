import { setGroupSetting, getGroupSettings } from "../database";
import type { Command } from "../lib/types";

export const commands: Command[] = [
  {
    name: "antilink",
    description: "Active/désactive la suppression des liens",
    category: "moderation",
    groupOnly: true,
    usage: "on/off",
    async execute(ctx) {
      const arg = ctx.args.toLowerCase();
      if (arg !== "on" && arg !== "off")
        return ctx.reply(`❌ Usage : ${ctx.prefix}antilink on|off`);
      setGroupSetting(ctx.chat, "antilink", arg === "on");
      await ctx.reply(`🛡️ Antilink : *${arg.toUpperCase()}*`);
    },
  },
  {
    name: "antispam",
    description: "Active/désactive l'anti-spam",
    category: "moderation",
    groupOnly: true,
    usage: "on/off",
    async execute(ctx) {
      const arg = ctx.args.toLowerCase();
      if (arg !== "on" && arg !== "off")
        return ctx.reply(`❌ Usage : ${ctx.prefix}antispam on|off`);
      setGroupSetting(ctx.chat, "antispam", arg === "on");
      await ctx.reply(`🛡️ Antispam : *${arg.toUpperCase()}*`);
    },
  },
  {
    name: "antidelete",
    description: "Active/désactive l'anti-suppression de messages",
    category: "moderation",
    groupOnly: true,
    usage: "on/off",
    async execute(ctx) {
      const arg = ctx.args.toLowerCase();
      if (arg !== "on" && arg !== "off")
        return ctx.reply(`❌ Usage : ${ctx.prefix}antidelete on|off`);
      setGroupSetting(ctx.chat, "antidelete", arg === "on");
      await ctx.reply(`🛡️ Antidelete : *${arg.toUpperCase()}*`);
    },
  },
  {
    name: "welcome",
    description: "Active/désactive le message de bienvenue",
    category: "moderation",
    groupOnly: true,
    usage: "on/off",
    async execute(ctx) {
      const arg = ctx.args.toLowerCase();
      if (arg !== "on" && arg !== "off")
        return ctx.reply(`❌ Usage : ${ctx.prefix}welcome on|off`);
      setGroupSetting(ctx.chat, "welcome", arg === "on");
      await ctx.reply(`👋 Welcome : *${arg.toUpperCase()}*`);
    },
  },
  {
    name: "groupsettings",
    aliases: ["gs"],
    description: "Affiche les réglages de ce groupe",
    category: "moderation",
    groupOnly: true,
    async execute(ctx) {
      const s = getGroupSettings(ctx.chat);
      const on = (v: boolean) => (v ? "✅ ON" : "❌ OFF");
      await ctx.reply(
        `⚙️ *Réglages du groupe* :\n` +
          `🛡️ Antilink : ${on(s.antilink)}\n` +
          `🛡️ Antispam : ${on(s.antispam)}\n` +
          `🛡️ Antidelete : ${on(s.antidelete)}\n` +
          `👋 Welcome : ${on(s.welcome)}`
      );
    },
  },
];
