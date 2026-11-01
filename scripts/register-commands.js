// Registers the slash commands defined in src/commands.js.
// Usage: DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... npm run cf:register
// Set DISCORD_GUILD_ID as well to register to one server instantly (handy for testing).

import { commands } from "../src/commands.js";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !applicationId) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_APPLICATION_ID.");
  process.exit(1);
}

const route = guildId
  ? `applications/${applicationId}/guilds/${guildId}/commands`
  : `applications/${applicationId}/commands`;

const res = await fetch(`https://discord.com/api/v10/${route}`, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error(`Failed to register commands: ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}

const registered = await res.json();
console.log(`Registered ${registered.length} ${guildId ? `commands for guild ${guildId}` : "global commands"}.`);
