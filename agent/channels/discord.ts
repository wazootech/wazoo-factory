import {
  defaultDiscordAuth,
  discordChannel,
  type DiscordCommandInteraction,
} from "eve/channels/discord";

const allowedGuilds = new Set(
  (process.env.DISCORD_ALLOWED_GUILDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const allowedChannels = new Set(
  (process.env.DISCORD_ALLOWED_CHANNELS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const allowedUsers = new Set(
  (process.env.DISCORD_ALLOWED_USERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

function isAllowed(interaction: DiscordCommandInteraction) {
  return (
    allowedGuilds.has(interaction.guildId ?? "") &&
    allowedChannels.has(interaction.channelId) &&
    allowedUsers.has(interaction.user.id)
  );
}

export default discordChannel({
  credentials: {
    applicationId: process.env.DISCORD_APPLICATION_ID ?? "",
    botToken: process.env.DISCORD_BOT_TOKEN ?? "",
    publicKey: process.env.DISCORD_PUBLIC_KEY ?? "",
  },
  onCommand(_ctx, interaction) {
    if (!isAllowed(interaction)) return null;
    return {
      auth: defaultDiscordAuth(interaction),
      context: [
        `Factory access granted to Discord user ${interaction.user.id}.`,
        "Use the typed factory tools and preserve their approval gates.",
      ],
    };
  },
});
