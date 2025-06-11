// Discord bot that shows a leaderboard based on PSN trophy data using psn-api and PostgreSQL
// Required packages: npm install discord.js psn-api dotenv pg

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const psn = require('psn-api');
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
    .setDescription('Remove your PSN username'),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show PSN platinum leaderboard')
].map(c => c.toJSON());

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (process.env.DISCORD_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, process.env.DISCORD_GUILD_ID),
        { body: commands }
      );
      console.log('✅ Guild commands registered.');
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('✅ Global commands registered.');
    }
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }

  await pool.query(`CREATE TABLE IF NOT EXISTS psn_users (
    discord_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    account_id TEXT NOT NULL
  )`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === 'addpsn') {
    const username = interaction.options.getString('username');

    try {
      const code = await psn.exchangeNpssoForCode(NPSSO);
      const tokens = await psn.exchangeCodeForAccessToken(code);

      const searchResult = await psn.makeUniversalSearch(tokens, username, 'SocialAllAccounts');
      const accountId = searchResult?.domainResponses?.find(r => r.domain === 'SocialAllAccounts')?.results?.[0]?.socialMetadata?.accountId;

      if (!accountId) return await interaction.reply('❌ Could not find your PSN account.');

      await pool.query(`INSERT INTO psn_users (discord_id, username, account_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (discord_id) DO UPDATE SET username = $2, account_id = $3`,
        [interaction.user.id, username, accountId]);

      await interaction.reply(`✅ PSN user **${username}** saved!`);
    } catch (err) {
      console.error('❌ Error:', err);
      await interaction.reply('⚠️ Failed to add your PSN username.');
    }
  }

  if (commandName === 'removepsn') {
    try {
      await pool.query('DELETE FROM psn_users WHERE discord_id = $1', [interaction.user.id]);
      await interaction.reply('🗑️ Your PSN username has been removed.');
    } catch (err) {
      console.error('❌ Error:', err);
      await interaction.reply('⚠️ Failed to remove your PSN username.');
    }
  }

  if (commandName === 'leaderboard') {
    await interaction.deferReply();
    try {
      const code = await psn.exchangeNpssoForCode(NPSSO);
      const tokens = await psn.exchangeCodeForAccessToken(code);
      const res = await pool.query('SELECT * FROM psn_users');

      const results = [];
      for (const row of res.rows) {
        try {
          const summary = await psn.getUserTrophyProfileSummary(tokens, row.account_id);
          const earned = summary.earnedTrophies || {};
          results.push({
            username: row.username,
            platinum: earned.platinum || 0,
            gold: earned.gold || 0,
            silver: earned.silver || 0,
            bronze: earned.bronze || 0
          });
        } catch (err) {
          console.warn(`⚠️ Failed for ${row.username}: ${err.message}`);
        }
      }

      if (results.length === 0) return await interaction.editReply('❌ No data found.');

      results.sort((a, b) =>
        b.platinum - a.platinum || b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze
      );

      const msg = results.map((u, i) =>
        `${i + 1}. **${u.username}** – 🏆 ${u.platinum} | 🥇 ${u.gold} | 🥈 ${u.silver} | 🥉 ${u.bronze}`
      ).join('\n');

      await interaction.editReply(`🏅 **PSN Trophy Leaderboard**\n${msg}`);
    } catch (err) {
      console.error('❌ Leaderboard error:', err);
      await interaction.editReply('⚠️ Failed to generate leaderboard.');
    }
  }
});

client.login(TOKEN);
