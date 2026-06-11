// Discord bot that shows a PSN trophy leaderboard using psn-api.

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const {
  exchangeNpssoForCode,
  exchangeCodeForAccessToken,
  getUserTrophyProfileSummary,
  makeUniversalSearch,
} = require('psn-api');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const requiredEnv = ['DISCORD_BOT_TOKEN', 'PSN_NPSSO', 'DATABASE_URL'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const NPSSO = process.env.PSN_NPSSO;
const DATABASE_URL = process.env.DATABASE_URL;

const poolConfig = { connectionString: DATABASE_URL };

if (!/sslmode=disable/i.test(DATABASE_URL)) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('addpsn')
    .setDescription('Add your PSN username')
    .addStringOption((opt) =>
      opt.setName('username').setDescription('Your PSN username').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('removepsn')
    .setDescription('Remove your PSN username')
    .addStringOption((opt) =>
      opt.setName('username').setDescription('Your PSN username to remove').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show PSN platinum leaderboard'),
].map((command) => command.toJSON());

async function initializeDatabase() {
  await pool.query(`CREATE TABLE IF NOT EXISTS psn_users (
    id TEXT PRIMARY KEY,
    discord_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    psn_username TEXT NOT NULL,
    psn_id TEXT NOT NULL
  )`);
}

async function getPsnTokens() {
  const code = await exchangeNpssoForCode(NPSSO);
  return exchangeCodeForAccessToken(code);
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Global commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }

  try {
    await initializeDatabase();
    console.log('Database initialized.');
  } catch (err) {
    console.error('Failed to initialize database:', err);
    await shutdown('database-initialization-failed', 1);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'addpsn') {
    await interaction.deferReply();

    const psnUsername = interaction.options.getString('username');
    const discordId = interaction.user.id;
    const guildId = interaction.guildId;
    const id = `${guildId}:${discordId}:${psnUsername}`;

    try {
      const tokens = await getPsnTokens();
      const searchResult = await makeUniversalSearch(tokens, psnUsername, 'SocialAllAccounts');
      const psnId = searchResult?.domainResponses
        ?.find((response) => response.domain === 'SocialAllAccounts')
        ?.results?.[0]?.socialMetadata?.accountId;

      if (!psnId) {
        await interaction.editReply('Could not find your PSN account.');
        return;
      }

      await pool.query(
        `INSERT INTO psn_users (id, discord_id, guild_id, psn_username, psn_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET psn_id = $5`,
        [id, discordId, guildId, psnUsername, psnId]
      );

      await interaction.editReply(`PSN user **${psnUsername}** saved!`);
    } catch (err) {
      console.error('Failed to add PSN username:', err);
      await interaction.editReply('Failed to add your PSN username.');
    }
  }

  if (commandName === 'removepsn') {
    const psnUsername = interaction.options.getString('username');
    const discordId = interaction.user.id;
    const guildId = interaction.guildId;
    const id = `${guildId}:${discordId}:${psnUsername}`;

    try {
      const res = await pool.query(
        'SELECT id FROM psn_users WHERE id = $1 AND guild_id = $2',
        [id, guildId]
      );

      if (res.rowCount === 0) {
        await interaction.reply('No matching PSN username found in this server.');
        return;
      }

      await pool.query('DELETE FROM psn_users WHERE id = $1 AND guild_id = $2', [id, guildId]);
      await interaction.reply(`PSN username **${psnUsername}** removed from this server.`);
    } catch (err) {
      console.error('Failed to remove PSN username:', err);
      await interaction.reply('Failed to remove your PSN username.');
    }
  }

  if (commandName === 'leaderboard') {
    await interaction.deferReply();

    try {
      const guildId = interaction.guildId;
      const tokens = await getPsnTokens();
      const res = await pool.query('SELECT * FROM psn_users WHERE guild_id = $1', [guildId]);

      const results = [];

      for (const row of res.rows) {
        try {
          const summary = await getUserTrophyProfileSummary(tokens, row.psn_id);
          const earned = summary.earnedTrophies || {};

          results.push({
            username: row.psn_username,
            platinum: earned.platinum || 0,
            gold: earned.gold || 0,
            silver: earned.silver || 0,
            bronze: earned.bronze || 0,
          });
        } catch (err) {
          console.warn(`Failed to fetch trophy summary for ${row.id}: ${err.message}`);
        }
      }

      if (results.length === 0) {
        await interaction.editReply('No data found for this server.');
        return;
      }

      results.sort(
        (a, b) =>
          b.platinum - a.platinum ||
          b.gold - a.gold ||
          b.silver - a.silver ||
          b.bronze - a.bronze
      );

      const msg = results
        .map(
          (user, index) =>
            `${index + 1}. **${user.username}** - Platinum ${user.platinum} | Gold ${user.gold} | Silver ${user.silver} | Bronze ${user.bronze}`
        )
        .join('\n');

      await interaction.editReply(`**PSN Trophy Leaderboard** (This Server)\n${msg}`);
    } catch (err) {
      console.error('Failed to generate leaderboard:', err);
      await interaction.editReply('Failed to generate leaderboard.');
    }
  }
});

let shuttingDown = false;

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Shutting down after ${signal}.`);

  try {
    client.destroy();
  } catch (err) {
    console.error('Failed to destroy Discord client:', err);
  }

  try {
    await pool.end();
  } catch (err) {
    console.error('Failed to close database pool:', err);
  }

  process.exit(exitCode);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  void shutdown('uncaughtException', 1);
});

client.login(TOKEN).catch((err) => {
  console.error('Failed to log in to Discord:', err);
  void shutdown('discord-login-failed', 1);
});
