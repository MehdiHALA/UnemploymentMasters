// Discord bot that shows a leaderboard based on PSN trophy data using psn-api
// Install required packages: npm install discord.js psn-api dotenv pg

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { exchangeNpssoForCode, exchangeCodeForAccessToken, getUserTrophyProfileSummary, makeUniversalSearch } = require('psn-api');
const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const NPSSO = process.env.PSN_NPSSO;
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('addpsn')
    .setDescription('Add your PSN username')
    .addStringOption(opt => opt.setName('username').setDescription('Your PSN username').setRequired(true)),
  new SlashCommandBuilder()
    .setName('removepsn')
    .setDescription('Remove your PSN username')
    .addStringOption(opt => opt.setName('username').setDescription('Your PSN username to remove').setRequired(true)),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show PSN platinum leaderboard')
].map(c => c.toJSON());

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Global commands registered.');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }

  await pool.query(`CREATE TABLE IF NOT EXISTS psn_users (
    id TEXT PRIMARY KEY,
    discord_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    psn_username TEXT NOT NULL,
    psn_id TEXT NOT NULL
  )`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === 'addpsn') {
    const psnUsername = interaction.options.getString('username');
    const discordId = interaction.user.id;
    const guildId = interaction.guildId;
    const id = `${guildId}:${discordId}:${psnUsername}`;

    try {
      const code = await exchangeNpssoForCode(NPSSO);
      const tokens = await exchangeCodeForAccessToken(code);

      const searchResult = await makeUniversalSearch(tokens, psnUsername, 'SocialAllAccounts');
      const psnId = searchResult?.domainResponses?.find(r => r.domain === 'SocialAllAccounts')?.results?.[0]?.socialMetadata?.accountId;

      if (!psnId) return await interaction.reply('❌ Could not find your PSN account.');

      await pool.query(`INSERT INTO psn_users (id, discord_id, guild_id, psn_username, psn_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET psn_id = $5`,
        [id, discordId, guildId, psnUsername, psnId]);

      await interaction.reply(`✅ PSN user **${psnUsername}** saved!`);
    } catch (err) {
      console.error('❌ Error:', err);
      await interaction.reply('⚠️ Failed to add your PSN username.');
    }
  }

  if (commandName === 'removepsn') {
    const psnUsername = interaction.options.getString('username');
    const discordId = interaction.user.id;
    const guildId = interaction.guildId;
    const id = `${guildId}:${discordId}:${psnUsername}`;

    try {
      const res = await pool.query('SELECT id FROM psn_users WHERE id = $1 AND guild_id = $2', [id, guildId]);
      if (res.rowCount === 0) return await interaction.reply('❌ No matching PSN username found in this server.');

      await pool.query('DELETE FROM psn_users WHERE id = $1 AND guild_id = $2', [id, guildId]);
      await interaction.reply(`🗑️ PSN username **${psnUsername}** removed from this server.`);
    } catch (err) {
      console.error('❌ Error:', err);
      await interaction.reply('⚠️ Failed to remove your PSN username.');
    }
  }

  if (commandName === 'leaderboard') {
    await interaction.deferReply();
    try {
      const guildId = interaction.guildId;
      const code = await exchangeNpssoForCode(NPSSO);
      const tokens = await exchangeCodeForAccessToken(code);
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
            bronze: earned.bronze || 0
          });
        } catch (err) {
          console.warn(`⚠️ Failed for ${row.id}: ${err.message}`);
        }
      }

      if (results.length === 0) return await interaction.editReply('❌ No data found for this server.');

      results.sort((a, b) =>
        b.platinum - a.platinum || b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze
      );

      const msg = results.map((u, i) =>
        `${i + 1}. **${u.username}** – 🏆 ${u.platinum} | 🥇 ${u.gold} | 🥈 ${u.silver} | 🥉 ${u.bronze}`
      ).join('\n');

      await interaction.editReply(`🏅 **PSN Trophy Leaderboard** (This Server)\n${msg}`);
    } catch (err) {
      console.error('❌ Leaderboard error:', err);
      await interaction.editReply('⚠️ Failed to generate leaderboard.');
    }
  }
});

client.login(TOKEN);
