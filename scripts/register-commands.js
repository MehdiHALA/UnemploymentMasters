const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;

const CommandOptionType = {
  SUB_COMMAND: 1,
  STRING: 3,
  USER: 6,
  CHANNEL: 7,
};

const ChannelType = {
  GUILD_TEXT: 0,
  GUILD_ANNOUNCEMENT: 5,
};

const commands = [
  {
    name: "addpsn",
    description: "Link a PSN username to your Discord profile",
    type: 1,
    options: [
      {
        name: "username",
        description: "The PSN username to link",
        type: CommandOptionType.STRING,
        required: true,
      },
    ],
  },
  {
    name: "removepsn",
    description: "Remove one of your saved PSN usernames",
    type: 1,
    options: [
      {
        name: "username",
        description: "The saved PSN username to remove",
        type: CommandOptionType.STRING,
        required: true,
      },
    ],
  },
  {
    name: "leaderboard",
    description: "Show the server PSN trophy standings",
    type: 1,
  },
  {
    name: "profile",
    description: "Show saved PSN trophy profile stats",
    type: 1,
    options: [
      {
        name: "user",
        description: "Discord user to view",
        type: CommandOptionType.USER,
        required: false,
      },
    ],
  },
  {
    name: "rank",
    description: "Show your place in the server trophy standings",
    type: 1,
  },
  {
    name: "weeklyleaderboard",
    description: "Manage weekly PSN trophy leaderboard posts",
    type: 1,
    default_member_permissions: "32",
    options: [
      {
        name: "set",
        description: "Choose where weekly trophy standings are posted",
        type: CommandOptionType.SUB_COMMAND,
        options: [
          {
            name: "channel",
            description: "Text channel for weekly standings",
            type: CommandOptionType.CHANNEL,
            channel_types: [ChannelType.GUILD_TEXT, ChannelType.GUILD_ANNOUNCEMENT],
            required: true,
          },
        ],
      },
      {
        name: "disable",
        description: "Turn off weekly trophy standings",
        type: CommandOptionType.SUB_COMMAND,
      },
      {
        name: "post",
        description: "Post the current trophy standings now",
        type: CommandOptionType.SUB_COMMAND,
      },
    ],
  },
];

if (!token || !applicationId) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_APPLICATION_ID.");
  process.exit(1);
}

async function main() {
  const res = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
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
  console.log(`Registered ${registered.length} global commands.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
