import assert from "node:assert/strict";
import { test } from "node:test";

import { commands } from "../src/commands.js";
import { OWNER_COMMANDS, PREMIUM_COMMANDS } from "../src/premium-commands.js";
import { planRoleChanges } from "../src/premium-jobs.js";
import * as pui from "../src/premium-ui.js";
import { weeklySlot } from "../src/runtime.js";
import { createTheme } from "../src/ui.js";
import { validateCommands } from "./helpers/command-validate.mjs";
import { allText, findButtons, validateMessage } from "./helpers/discord-validate.mjs";
import { createBot, DAY, discordId, HOUR, makeAccount, makeTitles, option, psnId } from "./helpers/harness.mjs";

const OWNER_GUILD = "900000000000000001";
const PREMIUM_GUILD = "100000000000000777";
const ADMIN = String(1 << 3);
const MANAGE = String(1 << 5);
const BUDGET = 45;

const sub = (name, options = []) => [{ name, type: 1, options }];
const group = (groupName, name, options = []) => [{ name: groupName, type: 2, options: [{ name, type: 1, options }] }];
const as = (bot, index, permissions = "0", guildId = "g1") => ({ ...bot.asUser(index, permissions), guild_id: guildId });
const owner = { guild_id: OWNER_GUILD, member: { user: { id: "42" }, permissions: ADMIN } };

const thisMonth = () => new Date().toISOString().slice(0, 7);
const lastMonth = () => new Date(Date.parse(`${thisMonth()}-01T00:00:00Z`) - 1).toISOString().slice(0, 7);

function noPlatinum(titles) {
  return titles.map((title) => ({ ...title, progress: 40, earnedTrophies: { ...title.earnedTrophies, platinum: 0 } }));
}

function seedSnapshot(bot, { psnId: id, name, np, title, progress, platinum = 0, total = 20 }) {
  bot.db.sqlite
    .prepare(
      `INSERT OR REPLACE INTO psn_title_snapshots (id, psn_id, psn_username, np_communication_id, np_service_name, title_name, title_icon_url,
         platform, progress, earned_platinum, earned_gold, earned_silver, earned_bronze, total, last_updated_at, last_seen_at, last_alerted_platinum)
       VALUES (?, ?, ?, ?, 'trophy2', ?, 'https://image.api.playstation.com/icon.png', 'PS5', ?, ?, 2, 4, 10, ?, ?, ?, 0)`
    )
    .run(`${id}:${np}`, id, name, np, title, progress, platinum, total, new Date().toISOString(), Date.now());
}

test("Platinum commands sync themselves: global for everyone, Platinum only where granted, /admin only for the owner", async () => {
  const bot = await createBot({ env: { OWNER_GUILD_ID: OWNER_GUILD } });
  bot.seedAuth();
  bot.seedAccounts(3, { guildId: PREMIUM_GUILD, cache: "fresh" });

  await bot.cron();
  assert.equal(bot.discord.globalCommands.length, 11, "free commands registered globally");
  assert.ok(bot.discord.globalCommands.every((c) => !["platinum", "race", "admin"].includes(c.name)));
  assert.deepEqual(bot.discord.guildCommands.get(OWNER_GUILD).map((c) => c.name), ["admin"]);
  assert.equal(bot.discord.guildCommands.has(PREMIUM_GUILD), false);

  const puts = bot.discord.commandPuts.length;
  await bot.cron();
  assert.equal(bot.discord.commandPuts.length, puts, "nothing re-registered when nothing changed");

  const denied = await bot.command("admin", sub("stats"), { guild_id: OWNER_GUILD, member: { user: { id: "7" }, permissions: MANAGE } });
  assert.match(allText(denied.final), /Owner only/);

  const grant = await bot.command("admin", sub("grant", [option("server_id", PREMIUM_GUILD), option("days", 30, 4), option("note", "founder")]), owner);
  assert.ok(grant.meter.total <= BUDGET);
  assert.match(allText(grant.final), /Platinum granted/);
  assert.match(allText(grant.final), /live there now/);
  assert.deepEqual(bot.discord.guildCommands.get(PREMIUM_GUILD).map((c) => c.name), PREMIUM_COMMANDS.map((c) => c.name));
  const row = bot.db.row("SELECT * FROM premium_guilds WHERE guild_id = ?", PREMIUM_GUILD);
  assert.equal(row.note, "founder");
  assert.ok(row.expires_at > Date.now() + 29 * DAY);
  assert.equal(bot.db.row("SELECT COUNT(*) AS n FROM psn_trophy_cache WHERE next_refresh_at = 0").n, 3, "its accounts refresh first");

  const stats = await bot.command("admin", sub("stats"), owner);
  assert.match(allText(stats.final), /321\*\* servers installed/);
  assert.match(allText(stats.final), /1\*\* Platinum/);

  const list = await bot.command("admin", sub("list"), owner);
  assert.match(allText(list.final), /founder/);

  const revoke = await bot.command("admin", sub("revoke", [option("server_id", PREMIUM_GUILD)]), owner);
  assert.match(allText(revoke.final), /back on the free plan/);
  assert.deepEqual(bot.discord.guildCommands.get(PREMIUM_GUILD), [], "Platinum commands removed from that server");
});

test("Platinum features say so politely in servers without Platinum", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(2, { cache: "fresh" });
  const result = await bot.command("monthly");
  assert.match(allText(result.final), /This is a Platinum feature/);
});

test("Platinum accounts refresh every 2 hours and keep a daily history; free ones every 6", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(2, { guildId: "g1", cache: "stale" });
  bot.seedAccounts(2, { guildId: "g2", cache: "stale", start: 10 });
  bot.grantPremium("g1");

  await bot.cron();
  const premiumNext = bot.db.row("SELECT next_refresh_at FROM psn_trophy_cache WHERE psn_id = ?", psnId(0)).next_refresh_at - Date.now();
  const freeNext = bot.db.row("SELECT next_refresh_at FROM psn_trophy_cache WHERE psn_id = ?", psnId(10)).next_refresh_at - Date.now();
  assert.ok(premiumNext > 1.9 * HOUR && premiumNext < 2.3 * HOUR, `premium refresh in ${premiumNext / HOUR} h`);
  assert.ok(freeNext > 5.9 * HOUR && freeNext < 6.7 * HOUR, `free refresh in ${freeNext / HOUR} h`);
  assert.equal(bot.db.row("SELECT COUNT(*) AS n FROM trophy_history").n, 2, "history only for Platinum accounts");
});

test("Platinum raises the per-member link cap", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  bot.seedAccounts(3, { cache: "fresh", linkedBy: () => discordId(7) });
  bot.psn.add(makeAccount(950, { onlineId: "FourthOne" }));

  const result = await bot.command("addpsn", [option("username", "FourthOne")], bot.asUser(7));
  assert.match(allText(result.final), /Linked \*\*FourthOne\*\*/);
});

test("branding: accent colour and trophy emojis apply to every message in that server", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  bot.seedAccounts(5, { cache: "fresh" });

  const color = await bot.command("platinum", sub("color", [option("hex", "#FF8800")]), as(bot, 1, MANAGE));
  assert.match(allText(color.final), /#ff8800/);
  const emojis = await bot.command("platinum", sub("emojis", [option("platinum", "<:plat:123456789012345678>")]), as(bot, 1, MANAGE));
  assert.match(allText(emojis.final), /<:plat:123456789012345678>/);

  const board = await bot.command("leaderboard");
  assert.equal(board.reply.data.components[0].accent_color, 0xff8800);
  assert.match(allText(board.reply.data), /<:plat:123456789012345678> \*\*/);

  const badColor = await bot.command("platinum", sub("color", [option("hex", "orange")]), as(bot, 1, MANAGE));
  assert.match(allText(badColor.final), /isn't a colour/);
  const badEmoji = await bot.command("platinum", sub("emojis", [option("gold", "gold")]), as(bot, 1, MANAGE));
  assert.match(allText(badEmoji.final), /isn't an emoji/);

  const status = await bot.command("platinum", sub("status"), as(bot, 1, MANAGE));
  assert.match(allText(status.final), /Platinum is active/);
  assert.match(allText(status.final), /#ff8800/);
});

test("Platinum servers can move their weekly post to another day and hour", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  bot.seedAccounts(4, { guildId: "g1", cache: "fresh" });
  bot.seedAccounts(4, { guildId: "g2", cache: "fresh", start: 10 });
  bot.setWeeklyChannel("g1", "premium-channel", Date.now() - 8 * DAY);
  bot.setWeeklyChannel("g2", "free-channel", Date.now() - 8 * DAY);

  const saved = await bot.command("platinum", sub("weekly", [option("day", 3, 4), option("hour", 18, 4)]), as(bot, 1, MANAGE));
  assert.match(allText(saved.final), /Wednesday at 18:00 UTC/);

  const nextSunday = weeklySlot(Date.now(), 0, 16) + 7 * DAY + 5 * 60_000;
  await bot.cron(nextSunday);
  const sundayPosts = bot.discord.posts.map((post) => post.channelId);
  assert.ok(sundayPosts.includes("free-channel"), "free servers keep Sunday");
  assert.ok(!sundayPosts.includes("premium-channel"), "the Platinum server skips Sunday");

  const nextWednesday = weeklySlot(nextSunday, 3, 18) + 7 * DAY + 5 * 60_000;
  const run = await bot.cron(nextWednesday);
  assert.ok(run.meter.total <= BUDGET);
  assert.equal(bot.discord.posts.filter((post) => post.channelId === "premium-channel").length, 1, "posted on its own schedule");
});

test("monthly standings crown a Hunter of the Month and hand over the role", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  bot.seedAccounts(3, { cache: "fresh" });
  bot.setWeeklyChannel("g1", "c1", Date.now());

  const start = await bot.command("monthly");
  assert.match(allText(start.final), /Monthly standings started/);

  await bot.command("platinum", sub("hunter", [option("role", "555000000000000001", 8)]), as(bot, 1, MANAGE));
  bot.db.sqlite.prepare("UPDATE psn_trophy_cache SET platinum = platinum + 3, total = total + 9 WHERE psn_id = ?").run(psnId(1));

  const standings = await bot.command("monthly");
  assert.match(allText(standings.final), /Player1/);
  assert.match(allText(standings.final), /\+3 🏆/);

  bot.db.sqlite.prepare("UPDATE guild_settings SET monthly_month = ?, hunter_discord_id = ? WHERE guild_id = 'g1'").run(lastMonth(), discordId(99));
  const run = await bot.cron();
  assert.ok(run.meter.total <= BUDGET);
  const post = bot.discord.posts.find((p) => /Hunter of/.test(allText(p.body)));
  assert.ok(post, "announced");
  assert.ok(allText(post.body).includes(`Hunter of ${pui.monthLabel(lastMonth())}`));
  assert.match(allText(post.body), /Player1/);
  assert.deepEqual(
    bot.discord.roleOps.map((op) => [op.userId, op.add]),
    [[discordId(99), false], [discordId(2), true]],
    "role moved from last month's hunter to the new one"
  );
  const settings = bot.db.row("SELECT monthly_month, hunter_discord_id FROM guild_settings WHERE guild_id = 'g1'");
  assert.equal(settings.monthly_month, new Date().toISOString().slice(0, 7));
  assert.equal(settings.hunter_discord_id, discordId(2));
});

test("milestone roles follow members' platinum counts", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  const counts = [5, 15, 60];
  bot.seedAccounts(3, { cache: "fresh", overrides: (i) => ({ trophies: { platinum: counts[i], gold: 10, silver: 20, bronze: 30 } }) });

  await bot.command("platinum", group("milestone", "add", [option("platinums", 10, 4), option("role", "777000000000000010", 8)]), as(bot, 1, MANAGE));
  await bot.command("platinum", group("milestone", "add", [option("platinums", 50, 4), option("role", "777000000000000050", 8)]), as(bot, 1, MANAGE));
  const list = await bot.command("platinum", group("milestone", "list"), as(bot, 1, MANAGE));
  assert.match(allText(list.final), /10\*\* platinums/);

  await bot.cron();
  const added = (ops) => ops.filter((op) => op.add).map((op) => [op.userId, op.roleId]);
  assert.deepEqual(added(bot.discord.roleOps).sort(), [
    [discordId(2), "777000000000000010"],
    [discordId(3), "777000000000000050"],
  ]);

  bot.discord.roleOps.length = 0;
  bot.db.sqlite.prepare("UPDATE psn_trophy_cache SET platinum = 55 WHERE psn_id = ?").run(psnId(1));
  await bot.cron();
  assert.deepEqual(
    bot.discord.roleOps.map((op) => [op.userId, op.roleId, op.add]),
    [
      [discordId(2), "777000000000000010", false],
      [discordId(2), "777000000000000050", true],
    ],
    "moved up a tier"
  );

  bot.discord.roleOps.length = 0;
  bot.discord.roleStatus = 403;
  await bot.command("platinum", group("milestone", "remove", [option("platinums", 50, 4)]), as(bot, 1, MANAGE));
  await bot.cron();
  assert.equal(bot.db.row("SELECT roles_error FROM guild_settings WHERE guild_id = 'g1'").roles_error, "missing_access");
  const attempts = bot.discord.roleOps.length;
  await bot.cron();
  assert.equal(bot.discord.roleOps.length, attempts, "paused until settings change");
});

test("platinum races: start, join, track progress, announce finishers and final results", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  const accounts = bot.seedAccounts(2, { cache: "fresh", overrides: () => ({ titles: noPlatinum(makeTitles(5)) }) });
  for (const account of accounts) {
    seedSnapshot(bot, { psnId: account.psnId, name: account.onlineId, np: "NPWR00001_00", title: "Game 1", progress: 40 });
  }

  const choices = await bot.autocomplete("race", [{ name: "start", type: 1, options: [option("game", "game", 3, { focused: true })] }], as(bot, 1, MANAGE));
  assert.ok(choices.reply.data.choices.some((c) => c.value === "NPWR00001_00" && /2 players/.test(c.name)));

  const denied = await bot.command("race", sub("start", [option("game", "NPWR00001_00"), option("days", 7, 4)]), as(bot, 1));
  assert.match(allText(denied.final), /Manage Server/);

  const start = await bot.command("race", sub("start", [option("game", "NPWR00001_00"), option("days", 7, 4)]), { ...as(bot, 1, MANAGE), channel_id: "race-channel" });
  assert.match(allText(start.final), /Platinum race: Game 1/);
  const joinButton = findButtons(start.final)[0];
  assert.match(joinButton.custom_id, /^race:join:/);

  const join = await bot.command("race", sub("join"), as(bot, 1));
  assert.match(allText(join.final), /You're in/);
  const viaButton = await bot.component(joinButton.custom_id, as(bot, 2));
  assert.ok(viaButton.reply.data.flags & 64);
  assert.equal(bot.db.row("SELECT COUNT(*) AS n FROM race_participants").n, 2);

  await bot.cron();
  assert.equal(bot.db.row("SELECT COUNT(*) AS n FROM race_participants WHERE checked_at > 0").n, 2, "progress checked");

  accounts[1].titles[1] = { ...accounts[1].titles[1], progress: 100, earnedTrophies: { platinum: 1, gold: 5, silver: 10, bronze: 30 } };
  bot.db.sqlite.prepare("UPDATE race_participants SET checked_at = 0").run();
  const run = await bot.cron();
  assert.ok(run.meter.total <= BUDGET);
  const finish = bot.discord.posts.find((p) => p.channelId === "race-channel" && /finished!/.test(allText(p.body)));
  assert.ok(finish, "finisher announced in the race channel");
  assert.match(allText(finish.body), /Player1/);

  const status = await bot.command("race", sub("status"));
  assert.match(allText(status.final), /🥇 \*\*Player1\*\*/);
  assert.match(allText(status.final), /40%/);

  bot.db.sqlite.prepare("UPDATE races SET ends_at = ?").run(Date.now() - 1000);
  await bot.cron();
  const results = bot.discord.posts.find((p) => p.channelId === "race-channel" && /Final standings/.test(allText(p.body)));
  assert.ok(results, "final standings posted");
  assert.equal(bot.db.row("SELECT status FROM races").status, "ended");
});

test("/game ranks members on one game", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  const accounts = bot.seedAccounts(3, { cache: "fresh" });
  seedSnapshot(bot, { psnId: accounts[0].psnId, name: "Player0", np: "NPWR00005_00", title: "Elden Ring", progress: 55 });
  seedSnapshot(bot, { psnId: accounts[1].psnId, name: "Player1", np: "NPWR00005_00", title: "Elden Ring", progress: 100, platinum: 1, total: 42 });
  seedSnapshot(bot, { psnId: accounts[2].psnId, name: "Player2", np: "NPWR00005_00", title: "Elden Ring", progress: 80 });

  const result = await bot.command("game", [option("title", "Elden Ring")]);
  const text = allText(result.final);
  assert.match(text, /Elden Ring/);
  assert.ok(text.indexOf("Player1") < text.indexOf("Player2") && text.indexOf("Player2") < text.indexOf("Player0"));
  assert.match(text, /3 players/);
});

test("/history draws an 8-week trend", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  const [account] = bot.seedAccounts(1, { cache: "fresh", linkedBy: () => discordId(1) });
  const insert = bot.db.sqlite.prepare("INSERT INTO trophy_history (psn_id, day, platinum, gold, silver, bronze, total, trophy_level) VALUES (?, ?, ?, 0, 0, 0, ?, 300)");
  for (let day = 40; day >= 0; day -= 1) {
    insert.run(account.psnId, new Date(Date.now() - day * DAY).toISOString().slice(0, 10), 100 + Math.floor((40 - day) / 4), 1000 + (40 - day) * 5);
  }

  const result = await bot.command("history", [], bot.asUser(1));
  const text = allText(result.final);
  assert.match(text, /platinums in 8 weeks/);
  assert.match(text, /[▁▂▃▄▅▆▇█]{8}/);
});

test("Platinum alerts show rarity; free servers get the normal alert", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  const [account] = bot.seedAccounts(1, { guildId: "g1", cache: "fresh", overrides: () => ({ titles: noPlatinum(makeTitles(5)) }) });
  bot.db.sqlite.prepare("INSERT INTO psn_users (id, discord_id, guild_id, psn_username, psn_id, created_at) VALUES ('g2:x', ?, 'g2', ?, ?, ?)").run(discordId(5), account.onlineId, account.psnId, Date.now());
  bot.setWeeklyChannel("g1", "premium-alerts", Date.now());
  bot.setWeeklyChannel("g2", "free-alerts", Date.now());

  account.titles[0] = { ...account.titles[0], progress: 100, earnedTrophies: { platinum: 1, gold: 5, silver: 10, bronze: 30 }, lastUpdatedDateTime: new Date(Date.now() - 60_000).toISOString() };
  account.trophies.platinum += 1;
  bot.psn.rarity.set(account.titles[0].npCommunicationId, 1.7);
  bot.db.sqlite.prepare("UPDATE psn_trophy_cache SET next_refresh_at = 0 WHERE psn_id = ?").run(account.psnId);

  await bot.cron();
  await bot.cron();
  const premiumPost = bot.discord.posts.find((p) => p.channelId === "premium-alerts" && /New platinum/.test(allText(p.body)));
  const freePost = bot.discord.posts.find((p) => p.channelId === "free-alerts" && /New platinum/.test(allText(p.body)));
  assert.ok(premiumPost && freePost);
  assert.match(allText(premiumPost.body), /Rare: only \*\*1\.7%\*\*/);
  assert.doesNotMatch(allText(freePost.body), /%/);
});

test("/platinum export sends the leaderboard as a CSV file", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  bot.seedAccounts(3, { cache: "fresh" });
  bot.seedAccounts(1, { cache: "none", start: 20 });
  bot.db.sqlite.prepare("UPDATE psn_trophy_cache SET last_error = 'private' WHERE psn_id = ?").run(psnId(20));

  const result = await bot.command("platinum", sub("export"), as(bot, 1, MANAGE));
  assert.equal(result.reply.type, 4);
  assert.ok(result.reply.data.flags & 64);
  assert.match(result.reply.file.name, /\.csv$/);
  const lines = result.reply.file.text.split("\n");
  assert.equal(lines[0], "rank,psn_online_id,discord_user_id,level,platinum,gold,silver,bronze,total,updated_utc,status");
  assert.equal(lines.length, 5);
  assert.match(lines[1], /^1,Player/);
  assert.match(lines[4], /private$/);
});

test("a Discord purchase unlocks Platinum once a SKU is configured (the payment hook)", async () => {
  const entitlement = { id: "e1", sku_id: "sku-platinum", guild_id: "g1", type: 8, deleted: false, ends_at: new Date(Date.now() + 30 * DAY).toISOString() };

  const unlinked = await createBot();
  unlinked.seedAuth();
  unlinked.seedAccounts(2, { cache: "fresh" });
  const ignored = await unlinked.command("monthly", [], { entitlements: [entitlement] });
  assert.match(allText(ignored.final), /Platinum feature/, "ignored while not linked to payments");

  const linked = await createBot({ env: { PREMIUM_SKU_ID: "sku-platinum" } });
  linked.seedAuth();
  linked.seedAccounts(2, { cache: "fresh" });
  const result = await linked.command("monthly", [], { entitlements: [entitlement] });
  assert.match(allText(result.final), /Monthly standings started/);
  assert.equal(linked.db.row("SELECT source FROM premium_guilds WHERE guild_id = 'g1'").source, "entitlement");
});

test("background runs with every Platinum feature busy stay within the Free plan budget", async () => {
  const bot = await createBot({ env: { OWNER_GUILD_ID: OWNER_GUILD } });
  bot.seedAuth();
  bot.grantPremium("g1");
  const accounts = bot.seedAccounts(60, { cache: "stale", overrides: () => ({ titles: noPlatinum(makeTitles(5)) }) });
  bot.setWeeklyChannel("g1", "c1", Date.now() - 8 * DAY);
  bot.db.sqlite.prepare("INSERT INTO milestone_roles (guild_id, platinums, role_id) VALUES ('g1', 1, '777000000000000001')").run();
  bot.db.sqlite.prepare("UPDATE guild_settings SET monthly_month = '2026-01', hunter_role_id = '555000000000000001' WHERE guild_id = 'g1'").run();
  bot.db.sqlite
    .prepare("INSERT INTO races (id, guild_id, channel_id, np_communication_id, np_service_name, title_name, created_by, started_at, ends_at, status) VALUES ('r1', 'g1', 'c1', 'NPWR00001_00', 'trophy2', 'Game 1', '1', ?, ?, 'active')")
    .run(Date.now(), Date.now() + DAY);
  const join = bot.db.sqlite.prepare("INSERT INTO race_participants (race_id, psn_id, discord_id, name, joined_at) VALUES ('r1', ?, ?, ?, ?)");
  for (const account of accounts.slice(0, 20)) join.run(account.psnId, "1", account.onlineId, Date.now());

  for (let run = 0; run < 6; run += 1) {
    const result = await bot.cron();
    assert.ok(result.meter.total <= BUDGET, `run ${run} used ${result.meter.total}`);
  }
  assert.ok(bot.db.row("SELECT COUNT(*) AS n FROM race_participants WHERE checked_at > 0").n > 0);
  assert.ok(bot.db.row("SELECT COUNT(*) AS n FROM role_grants").n > 0);
  assert.ok(bot.db.row("SELECT COUNT(*) AS n FROM psn_trophy_cache WHERE titles_synced_at > 0").n > 0);
});

test("role planning gives each member only their highest milestone", () => {
  const plan = planRoleChanges({
    members: [
      { discord_id: "a", platinum: 3 },
      { discord_id: "b", platinum: 12 },
      { discord_id: "c", platinum: 120 },
      { discord_id: "d", platinum: 120 },
    ],
    milestones: [
      { platinums: 10, role_id: "r10" },
      { platinums: 100, role_id: "r100" },
    ],
    grants: [
      { discord_id: "c", role_id: "r10" },
      { discord_id: "d", role_id: "-" },
    ],
  });
  assert.deepEqual(plan, [
    { discordId: "b", roleId: "r10", add: true },
    { discordId: "c", roleId: "r10", add: false },
    { discordId: "c", roleId: "r100", add: true },
  ]);
});

test("every Platinum layout stays inside Discord's limits", () => {
  const theme = createTheme({}, { accent: 0x123456, emojis: { platinum: "<:plat:123456789012345678>" } });
  const now = Date.now();
  const longName = "Abcdefghijklmnop";
  const mover = (i) => ({ name: `${longName}${i}`, discord_id: String(100000000000000000n + BigInt(i)), avatar_url: "https://a.example/x.png", platinum_gain: 99, gold_gain: 999, silver_gain: 999, bronze_gain: 9999, total_gain: 12096 });
  const race = { id: "r", title_name: "A Very Long Game Title: Definitive Edition — Remastered Collection", title_icon_url: "https://i.example/g.png", platform: "PS4,PS5", created_by: "1", ends_at: now + DAY };
  const participants = Array.from({ length: 40 }, (_, i) => ({ name: `${longName}${i}`, discord_id: "1", progress: i * 2, finished_at: i < 5 ? now - i * HOUR : null }));
  const views = [
    pui.platinumStatusView({ branding: { accent_color: 0x123456, weekly_day: 3, weekly_hour: 18, hunter_role_id: "5", roles_error: "missing_access" }, milestones: Array.from({ length: 10 }, (_, i) => ({ platinums: (i + 1) * 100, role_id: String(i) })), expiresAt: now + DAY, theme }),
    pui.milestoneListView({ milestones: Array.from({ length: 10 }, (_, i) => ({ platinums: i + 1, role_id: String(i) })), rolesError: null, theme }),
    pui.monthlyMessage({ month: "2026-11", baselineAt: now - DAY, trackedCount: 999, movers: Array.from({ length: 10 }, (_, i) => mover(i)) }, { theme }),
    pui.hunterOfMonthMessage({ month: "2026-10", winners: [mover(1), mover(2), mover(3)], roleId: "5", theme }),
    pui.raceStartMessage(race, { theme }),
    pui.raceStatusMessage(race, participants, { theme }),
    pui.raceStatusMessage(race, participants, { theme, ended: true }),
    pui.raceFinishMessage(race, participants[0], 1, { theme }),
    pui.gameBoardMessage(Array.from({ length: 15 }, (_, i) => ({ ...mover(i), title_name: race.title_name, title_icon_url: race.title_icon_url, platform: "PS5", progress: 99, platinum: 1, total: 200, players: 150 })), { theme }),
    pui.historyMessage({ accounts: [1, 2, 3].map((i) => ({ name: `${longName}${i}`, rows: Array.from({ length: 56 }, (_, d) => ({ day: new Date(now - (55 - d) * DAY).toISOString().slice(0, 10), platinum: 100 + d, total: 5000 + d * 7, trophy_level: 500 })) })), now, theme }),
    pui.adminStatsView({ stats: { totals: { servers: 160, links: 639, accounts: 599, people: 491 }, top: Array.from({ length: 5 }, (_, i) => ({ guild_id: String(i), links: 258, people: 251 })), premium: 3, health: { weekly_servers: 28, fresh_6h: 500, private: 74, auth_error: null, login_expires: now + 10 * DAY } }, names: new Map([["0", "A server with a very long name indeed"]]), guildCount: 400, premiumIds: new Set(["0"]) }),
    pui.adminListView({ rows: Array.from({ length: 10 }, (_, i) => ({ guild_id: String(i), source: "grant", note: "founder", expires_at: now + DAY })), names: new Map() }),
  ];
  for (const view of views) assert.deepEqual(validateMessage(view), []);
});

test("every command definition follows Discord's registration rules", () => {
  assert.deepEqual(validateCommands(commands), []);
  assert.deepEqual(validateCommands([...PREMIUM_COMMANDS, ...OWNER_COMMANDS], { scope: "guild" }), []);
  assert.ok(validateCommands([{ name: "Bad Name", description: "" }]).length >= 2, "the checker itself catches mistakes");
});

test("a rejected command update isn't retried every run, but is after 6 hours", async () => {
  const bot = await createBot({ env: { OWNER_GUILD_ID: OWNER_GUILD } });
  bot.seedAuth();
  bot.discord.globalCommandStatus = 400;
  bot.discord.commandStatus.set(OWNER_GUILD, 403);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await bot.cron();
    const second = await bot.cron();
    assert.equal(bot.db.rows("SELECT * FROM job_state WHERE key LIKE 'commands_hash:%' AND value LIKE 'failed:%'").length, 2);
    assert.equal(second.meter.fetches, 0, "no Discord calls on the next run");
  } finally {
    console.warn = originalWarn;
  }

  bot.discord.globalCommandStatus = 200;
  bot.discord.commandStatus.delete(OWNER_GUILD);
  await bot.cron(Date.now() + 7 * HOUR);
  assert.equal(bot.discord.commandPuts.length, 2, "retried after 6 hours");
  assert.deepEqual(bot.discord.guildCommands.get(OWNER_GUILD).map((c) => c.name), ["admin"]);
});

test("a Platinum lookup failure never breaks the free commands", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(3, { cache: "fresh" });
  bot.db.sqlite.exec("DROP TABLE premium_guilds");
  const originalError = console.error;
  console.error = () => {};
  try {
    const board = await bot.command("leaderboard");
    assert.match(allText(board.final), /Player/);
    assert.deepEqual(board.replyErrors, []);
  } finally {
    console.error = originalError;
  }
});

test("game autocomplete reads the server's game list once, then answers from memory", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  const accounts = bot.seedAccounts(2, { cache: "fresh" });
  seedSnapshot(bot, { psnId: accounts[0].psnId, name: "Player0", np: "NPWR00005_00", title: "Elden Ring", progress: 55 });
  seedSnapshot(bot, { psnId: accounts[1].psnId, name: "Player1", np: "NPWR00006_00", title: "Astro Bot", progress: 100, platinum: 1 });
  const focused = (value) => [option("title", value, 3, { focused: true })];

  const first = await bot.autocomplete("game", focused("eld"));
  assert.deepEqual(first.reply.data.choices.map((c) => c.value), ["NPWR00005_00"]);
  const second = await bot.autocomplete("game", focused("astro"));
  assert.deepEqual(second.reply.data.choices.map((c) => c.value), ["NPWR00006_00"]);
  assert.equal(second.meter.d1, 0, "no database read for the next keystroke");
  const all = await bot.autocomplete("game", focused(""));
  assert.equal(all.reply.data.choices.length, 2);
});

test("payment hook: only server subscriptions count, and renewals keep extending", async () => {
  const sku = "sku-platinum";
  const bot = await createBot({ env: { PREMIUM_SKU_ID: sku } });
  bot.seedAuth();
  bot.seedAccounts(2, { cache: "fresh" });

  const personal = await bot.command("monthly", [], { entitlements: [{ id: "e0", sku_id: sku, user_id: discordId(0), type: 8, deleted: false }] });
  assert.match(allText(personal.final), /Platinum feature/, "a personal purchase doesn't unlock a server");

  const renewing = { id: "e1", sku_id: sku, guild_id: "g1", type: 8, deleted: false, starts_at: new Date(Date.now() - DAY).toISOString(), ends_at: null };
  const unlocked = await bot.command("monthly", [], { entitlements: [renewing] });
  assert.match(allText(unlocked.final), /Monthly standings started/);
  const firstUntil = bot.db.row("SELECT expires_at FROM premium_guilds WHERE guild_id = 'g1'").expires_at;
  assert.ok(Math.abs(firstUntil - (Date.now() + 7 * DAY)) < HOUR, "a renewing subscription is held for a rolling week");

  bot.db.sqlite.prepare("UPDATE premium_guilds SET expires_at = ? WHERE guild_id = 'g1'").run(Date.now() + 2 * DAY);
  bot.clearCaches();
  await bot.command("leaderboard", [], { entitlements: [renewing] });
  assert.ok(bot.db.row("SELECT expires_at FROM premium_guilds WHERE guild_id = 'g1'").expires_at > Date.now() + 6 * DAY, "extended by later use");

  const cancelled = { ...renewing, ends_at: new Date(Date.now() + 20 * DAY).toISOString() };
  bot.clearCaches();
  await bot.command("leaderboard", [], { entitlements: [cancelled] });
  assert.equal(
    bot.db.row("SELECT expires_at FROM premium_guilds WHERE guild_id = 'g1'").expires_at,
    Date.parse(cancelled.ends_at),
    "held until a cancelled subscription ends"
  );

  bot.grantPremium("g1", { expiresAt: null, source: "grant" });
  bot.clearCaches();
  await bot.command("leaderboard", [], { entitlements: [cancelled] });
  const row = bot.db.row("SELECT source, expires_at FROM premium_guilds WHERE guild_id = 'g1'");
  assert.deepEqual([row.source, row.expires_at], ["grant", null], "a grant with no end date is left alone");

  const status = await bot.command("platinum", sub("status"), as(bot, 1, MANAGE));
  assert.match(allText(status.final), /No end date/);
});

test("payment hook: the hourly check keeps paying servers on Platinum without anyone using a command", async () => {
  const sku = "sku-platinum";
  const subscriber = "100000000000000888";
  const bot = await createBot({ env: { PREMIUM_SKU_ID: sku } });
  bot.seedAuth();
  bot.discord.entitlements = [
    { id: "e1", sku_id: sku, guild_id: subscriber, type: 8, deleted: false, ends_at: null },
    { id: "e2", sku_id: sku, user_id: "5", type: 8, deleted: false },
    { id: "e3", sku_id: "another-sku", guild_id: "100000000000000999", type: 8, deleted: false },
  ];

  await bot.cron();
  await bot.cron();
  const row = bot.db.row("SELECT source, expires_at FROM premium_guilds WHERE guild_id = ?", subscriber);
  assert.equal(row.source, "entitlement");
  assert.ok(Math.abs(row.expires_at - (Date.now() + 7 * DAY)) < HOUR);
  assert.equal(bot.db.row("SELECT COUNT(*) AS n FROM premium_guilds").n, 1, "personal and other purchases ignored");
  assert.deepEqual(bot.discord.guildCommands.get(subscriber).map((c) => c.name), PREMIUM_COMMANDS.map((c) => c.name), "commands added in the same run");

  const calls = bot.discord.entitlementCalls;
  await bot.cron();
  assert.equal(bot.discord.entitlementCalls, calls, "checked at most once an hour");
  await bot.cron(Date.now() + 2 * HOUR);
  assert.equal(bot.discord.entitlementCalls, calls + 1);

  const unlinked = await createBot();
  unlinked.seedAuth();
  unlinked.discord.entitlements = bot.discord.entitlements;
  await unlinked.cron();
  await unlinked.cron();
  assert.equal(unlinked.discord.entitlementCalls, 0, "never asks Discord while no SKU is set");
});

test("a month without a fresh winner just starts over", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  bot.seedAccounts(2, { cache: "fresh" });
  bot.setWeeklyChannel("g1", "c1", Date.now());
  await bot.command("monthly");
  bot.db.sqlite.prepare("UPDATE psn_trophy_cache SET platinum = platinum + 1, total = total + 5").run();
  bot.db.sqlite.prepare("UPDATE guild_settings SET monthly_month = '2025-01' WHERE guild_id = 'g1'").run();

  await bot.cron();
  assert.equal(bot.discord.posts.filter((p) => /Hunter of/.test(allText(p.body))).length, 0, "no stale announcement");
  assert.equal(bot.db.row("SELECT monthly_month FROM guild_settings WHERE guild_id = 'g1'").monthly_month, thisMonth());
});

test("the Hunter of the Month post is retried when Discord hiccups", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  bot.seedAccounts(2, { cache: "fresh" });
  bot.setWeeklyChannel("g1", "c1", Date.now());
  await bot.command("monthly");
  bot.db.sqlite.prepare("UPDATE psn_trophy_cache SET platinum = platinum + 2, total = total + 5 WHERE psn_id = ?").run(psnId(0));
  bot.db.sqlite.prepare("UPDATE guild_settings SET monthly_month = ? WHERE guild_id = 'g1'").run(lastMonth());

  bot.discord.channelStatus.set("c1", 503);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await bot.cron();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(bot.db.row("SELECT monthly_month FROM guild_settings WHERE guild_id = 'g1'").monthly_month, lastMonth(), "kept for a retry");

  bot.discord.channelStatus.delete("c1");
  await bot.cron();
  assert.equal(bot.discord.posts.filter((p) => /Hunter of/.test(allText(p.body))).length, 1);
  assert.equal(bot.db.row("SELECT monthly_month FROM guild_settings WHERE guild_id = 'g1'").monthly_month, thisMonth());
});

test("role planning: unlinked members lose the role, grants are re-confirmed weekly, leavers are retried", () => {
  const now = Date.now();
  const milestones = [
    { platinums: 100, role_id: "r100" },
    { platinums: 10, role_id: "r10" },
  ];
  const plan = planRoleChanges(
    {
      members: [
        { discord_id: "fresh", platinum: 12 },
        { discord_id: "stale", platinum: 12 },
        { discord_id: "back", platinum: 150 },
        { discord_id: "away", platinum: 150 },
      ],
      milestones,
      grants: [
        { discord_id: "fresh", role_id: "r10", granted_at: now - DAY },
        { discord_id: "stale", role_id: "r10", granted_at: now - 8 * DAY },
        { discord_id: "back", role_id: "-", granted_at: now - 8 * DAY },
        { discord_id: "away", role_id: "-", granted_at: now - DAY },
        { discord_id: "unlinked", role_id: "r100", granted_at: now - DAY },
      ],
    },
    now
  );
  assert.deepEqual(plan, [
    { discordId: "stale", roleId: "r10", add: true },
    { discordId: "back", roleId: "r100", add: true },
    { discordId: "unlinked", roleId: "r100", add: false },
  ]);
});

test("members who left are skipped for a week, then picked up again if they rejoin", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.grantPremium("g1");
  bot.seedAccounts(2, { cache: "fresh", overrides: () => ({ trophies: { platinum: 20, gold: 1, silver: 1, bronze: 1 } }) });
  bot.db.sqlite.prepare("INSERT INTO milestone_roles (guild_id, platinums, role_id) VALUES ('g1', 10, '777000000000000010')").run();
  bot.discord.goneMembers.add(discordId(2));

  await bot.cron();
  assert.equal(bot.db.row("SELECT COUNT(*) AS n FROM role_grants WHERE role_id = '-'").n, 1, "marked as gone");
  bot.discord.roleOps.length = 0;
  await bot.cron();
  assert.equal(bot.discord.roleOps.length, 0, "not retried straight away");

  bot.discord.goneMembers.clear();
  bot.db.sqlite.prepare("UPDATE role_grants SET granted_at = ?").run(Date.now() - 8 * DAY);
  await bot.cron();
  assert.ok(bot.discord.roleOps.some((op) => op.userId === discordId(2) && op.add), "tried again after a week");
  assert.equal(bot.db.row("SELECT COUNT(*) AS n FROM role_grants WHERE role_id = '-'").n, 0, "back in the server");
  assert.equal(bot.db.row("SELECT COUNT(*) AS n FROM role_grants WHERE discord_id = ? AND role_id = '777000000000000010'", discordId(2)).n, 1);
});
