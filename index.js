// Discord bot that shows a leaderboard based on PSN trophy data
// Run: npm install discord.js dotenv psn-api

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const dotenv = require('dotenv');
const fs = require('fs');
const {
  exchangeNpssoForCode,
  exchangeCodeForAccessToken,
  getUserTrophyProfileSummary,
  makeUniversalSearch
} = require('psn-api');

dotenv.config();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const NPSSO = process.env.PSN_NPSSO;
const psnUsersFile = 'psn_users.json';

let psnUsers = {};
if (fs.existsSync(psnUsersFile)) {
  psnUsers = JSON.parse(fs.readFileSync(psnUsersFile));
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('addpsn')
    .setDescription('Add your PSN username')
    .addStringOption(opt =>
      opt.setName('username').setDescription('Your PSN username').setRequired(true)
    ),
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

    let tokens;
    try {
      const accessCode = await exchangeNpssoForCode(NPSSO);
      tokens = await exchangeCodeForAccessToken(accessCode);
    } catch (err) {
      console.error('❌ Auth error:', err);
      await interaction.reply('⚠️ Failed to authenticate with PSN.');
      return;
    }

    try {
      const searchResult = await makeUniversalSearch(tokens, username, 'SocialAllAccounts');
      const accountId = searchResult?.domainResponses
        ?.find(r => r.domain === 'SocialAllAccounts')
        ?.results?.[0]?.socialMetadata?.accountId;

      if (!accountId) {
        await interaction.reply('❌ Could not find your PSN account.');
        return;
      }

      psnUsers[interaction.user.id] = { username, accountId };

      let existingUsers = {};
      if (fs.existsSync(psnUsersFile)) {
        try {
          existingUsers = JSON.parse(fs.readFileSync(psnUsersFile));
        } catch (e) {
          console.warn('⚠️ Failed to parse existing user file. Overwriting.');
        }
      }

      existingUsers[interaction.user.id] = { username, accountId };
      fs.writeFileSync(psnUsersFile, JSON.stringify(existingUsers, null, 2));
      await interaction.reply(`✅ PSN user **${username}** saved!`);
    } catch (err) {
      console.error(`❌ Error resolving account ID for ${username}:`, err.message);
      await interaction.reply('❌ Failed to resolve PSN account ID.');
    }
  }

  if (commandName === 'leaderboard') {
    await interaction.deferReply();

    let tokens;
    try {
      const accessCode = await exchangeNpssoForCode(NPSSO);
      tokens = await exchangeCodeForAccessToken(accessCode);
    } catch (err) {
      console.error('❌ Auth error:', err);
      await interaction.editReply('⚠️ Failed to authenticate with PSN.');
      return;
    }

    const results = [];

    for (const userObj of Object.values(psnUsers)) {
      const { username, accountId } = userObj;
      if (!accountId) continue;

      try {
        const summary = await getUserTrophyProfileSummary(tokens, accountId);
        const earned = summary.earnedTrophies || {};

        results.push({
          username,
          platinum: earned.platinum || 0,
          gold: earned.gold || 0,
          silver: earned.silver || 0,
          bronze: earned.bronze || 0
        });
      } catch (err) {
        console.error(`❌ Error fetching trophy summary for ${username}:`, err.message);
      }
    }

    if (results.length === 0) {
      await interaction.editReply('❌ No valid data could be retrieved.');
      return;
    }

    results.sort((a, b) =>
      b.platinum - a.platinum ||
      b.gold - a.gold ||
      b.silver - a.silver ||
      b.bronze - a.bronze
    );

    const msg = results
      .map((u, i) =>
        `${i + 1}. **${u.username}** – 🏆 ${u.platinum} | 🥇 ${u.gold} | 🥈 ${u.silver} | 🥉 ${u.bronze}`
      )
      .join('\n');

    await interaction.editReply(`🏅 **PSN Trophy Leaderboard**\n${msg}`);
  }
});

client.login(TOKEN);
