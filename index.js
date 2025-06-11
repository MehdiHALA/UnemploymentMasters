// Discord bot that shows a leaderboard based on PSN trophy data using psn-api and stores data in PostgreSQL
// Requires: npm install discord.js dotenv pg psn-api

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import pkg from 'psn-api';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const {
  exchangeNpssoForCode,
  exchangeCodeForAccessToken,
  getUserTrophyProfileSummary,
  makeUniversalSearch
} = pkg;

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const NPSSO = process.env.PSN_NPSSO;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('addpsn')
    .setDescription('Add your PSN username')
    .addStringOption(opt =>
      opt.setName('username').setDescription('Your PSN username').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('removepsn')
    .setDescription('Remove your PSN username from the leaderboard'),
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
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === 'addpsn') {
    const username = interaction.options.getString('username');

    try {
      const accessCode = await exchangeNpssoForCode(NPSSO);
      const tokens = await exchangeCodeForAccessToken(accessCode);
      const searchResult = await makeUniversalSearch(tokens, username, 'SocialAllAccounts');
      const accountId = searchResult?.domainResponses
        ?.find(r => r.domain === 'SocialAllAccounts')
        ?.results?.[0]?.socialMetadata?.accountId;

      if (!accountId) {
        await interaction.reply('❌ Could not find your PSN account.');
        return;
      }

      await pool.query(
        `INSERT INTO psn_users (discord_id, username, account_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (discord_id) DO UPDATE SET username = $2, account_id = $3`,
        [interaction.user.id, username, accountId]
      );

      await interaction.reply(`✅ PSN user **${username}** saved!`);
    } catch (err) {
      console.error('❌ Error:', err);
      await interaction.reply('❌ Failed to authenticate or retrieve account.');
    }
  }

  if (commandName === 'removepsn') {
    try {
      await pool.query('DELETE FROM psn_users WHERE discord_id = $1', [interaction.user.id]);
      await interaction.reply('🗑️ Your PSN username was removed from the leaderboard.');
    } catch (err) {
      console.error('❌ DB Error:', err);
      await interaction.reply('❌ Could not remove your PSN username.');
    }
  }

  if (commandName === 'leaderboard') {
    await interaction.deferReply();

    try {
      const accessCode = await exchangeNpssoForCode(NPSSO);
      const tokens = await exchangeCodeForAccessToken(accessCode);

      const res = await pool.query('SELECT * FROM psn_users');
      const results = [];

      for (const row of res.rows) {
        try {
          const summary = await getUserTrophyProfileSummary(tokens, row.account_id);
          const earned = summary.earnedTrophies || {};

          results.push({
            username: row.username,
            platinum: earned.platinum || 0,
            gold: earned.gold || 0,
            silver: earned.silver || 0,
            bronze: earned.bronze || 0
          });
        } catch (err) {
          console.error(`❌ Error fetching data for ${row.username}:`, err.message);
        }
      }

      if (results.length === 0) {
        await interaction.editReply('❌ No valid data could be retrieved.');
        return;
      }

      results.sort((a, b) =>
        b.platinum - a.platinum || b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze
      );

      const msg = results
        .map((u, i) =>
          `${i + 1}. **${u.username}** – 🏆 ${u.platinum} | 🥇 ${u.gold} | 🥈 ${u.silver} | 🥉 ${u.bronze}`
        )
        .join('\n');

      await interaction.editReply(`🏅 **PSN Trophy Leaderboard**\n${msg}`);
    } catch (err) {
      console.error('❌ Leaderboard Error:', err);
      await interaction.editReply('❌ Failed to generate leaderboard.');
    }
  }
});

client.login(TOKEN);
