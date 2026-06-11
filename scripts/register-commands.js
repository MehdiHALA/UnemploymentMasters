const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;

const commands = [
  {
    name: "addpsn",
    description: "Add your PSN username",
    type: 1,
    options: [
      {
        name: "username",
        description: "Your PSN username",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "removepsn",
    description: "Remove your PSN username",
    type: 1,
    options: [
      {
        name: "username",
        description: "Your PSN username to remove",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "leaderboard",
    description: "Show PSN platinum leaderboard",
    type: 1,
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
