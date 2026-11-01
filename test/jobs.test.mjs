import assert from "node:assert/strict";
import { test } from "node:test";

import { weeklyPostSlot } from "../src/runtime.js";
import { allText } from "./helpers/discord-validate.mjs";
import { createBot, DAY, discordId, HOUR, makeAccount, makeTitles, option, psnId } from "./helpers/harness.mjs";

const SUBREQUEST_BUDGET = 45;

function assertRunWithinLimits(run) {
  assert.ok(run.meter.total <= SUBREQUEST_BUDGET, `cron used ${run.meter.total} subrequests`);
}

test("the background job refreshes every account, a slice per run, within budget", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(120, { cache: "stale" });
  for (const account of bot.psn.accounts.values()) account.trophies.gold += 1;

  let runs = 0;
  while (bot.db.row("SELECT COUNT(*) AS n FROM psn_trophy_cache WHERE next_refresh_at <= ?", Date.now()).n > 0) {
    const run = await bot.cron();
    assertRunWithinLimits(run);
    runs += 1;
    assert.ok(runs <= 8, "should finish in a handful of 5-minute runs");
  }

  assert.ok(runs >= 5, `refreshed in ${runs} runs (25 per run)`);
  const fresh = bot.db.row("SELECT COUNT(*) AS n FROM psn_trophy_cache WHERE fetched_at > ? AND gold > 50", Date.now() - HOUR).n;
  assert.equal(fresh, 120);
});

test("platinum alerts fire once for an existing game and a brand-new game", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.setWeeklyChannel("g1", "trophy-channel", Date.now());
  const [account] = bot.seedAccounts(1, { cache: "fresh", overrides: () => ({ titles: makeTitles(12, { platinumEvery: 100 }) }) });
  // Seen before without a platinum:
  await bot.command("recent", [option("limit", 10, 4)], bot.asUser(1));

  const base = account.trophies.platinum;
  const now = Date.now();
  account.titles = [
    { ...makeTitles(1, { prefix: "Brand New", newestAt: now - 60_000 })[0], npCommunicationId: "NPWR99999_00" },
    { ...account.titles[1], earnedTrophies: { platinum: 1, gold: 5, silver: 10, bronze: 30 }, progress: 100, lastUpdatedDateTime: new Date(now - 120_000).toISOString() },
    ...account.titles.slice(2),
  ];
  account.trophies.platinum = base + 2;
  bot.db.sqlite.prepare("UPDATE psn_trophy_cache SET next_refresh_at = 0 WHERE psn_id = ?").run(account.psnId);

  await bot.cron(); // picks up the new platinum count
  const run = await bot.cron(); // announces it
  assertRunWithinLimits(run);

  const alerts = bot.discord.posts.filter((post) => post.channelId === "trophy-channel" && /New platinum/.test(allText(post.body)));
  assert.equal(alerts.length, 1, "one message");
  const text = allText(alerts[0].body);
  assert.match(text, /Brand New 0/);
  assert.match(text, /Game 1/);
  assert.match(text, new RegExp(`Platinum #${base + 2}`));

  await bot.cron();
  await bot.cron();
  assert.equal(bot.discord.posts.filter((post) => /New platinum/.test(allText(post.body))).length, 1, "never repeats");
});

test("linking an account never announces its old platinums", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.setWeeklyChannel("g1", "trophy-channel", Date.now());
  bot.psn.add(makeAccount(500, { onlineId: "Veteran", trophies: { platinum: 80, gold: 400, silver: 900, bronze: 3000 } }));

  await bot.command("addpsn", [option("username", "Veteran")], bot.asUser(1));
  await bot.cron();
  await bot.cron();

  assert.equal(bot.discord.posts.filter((post) => /New platinum/.test(allText(post.body))).length, 0);
});

test("weekly leaderboards post on Sunday 16:00 UTC for many servers, once per week", async () => {
  const bot = await createBot();
  bot.seedAuth();
  const sunday = weeklyPostSlot(Date.UTC(2026, 10, 1, 18)) + 5 * 60_000; // Sun 1 Nov 2026 16:05 UTC
  const lastWeek = sunday - 7 * DAY;

  for (let g = 0; g < 20; g += 1) {
    bot.seedAccounts(5, { guildId: `guild${g}`, cache: "fresh", start: g * 5 });
    bot.setWeeklyChannel(`guild${g}`, `channel${g}`, lastWeek);
  }

  const early = await bot.cron(sunday - HOUR);
  assert.equal(early.report.weekly, 0, "nothing before 16:00");

  let posted = 0;
  for (let i = 0; i < 6 && posted < 20; i += 1) {
    const run = await bot.cron(sunday + i * 5 * 60_000);
    assertRunWithinLimits(run);
    posted += run.report.weekly;
  }

  assert.equal(posted, 20);
  assert.equal(new Set(bot.discord.posts.map((post) => post.channelId)).size, 20);
  assert.match(allText(bot.discord.posts[0].body), /Weekly Trophy Standings/);
  assert.equal(bot.db.row("SELECT COUNT(DISTINCT guild_id) AS n FROM weekly_trophy_baselines").n, 20, "weekly baselines reset");

  const again = await bot.cron(sunday + HOUR);
  assert.equal(again.report.weekly, 0, "not posted twice in a week");
});

test("a server whose channel is gone stops being retried", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(3, { cache: "fresh" });
  const sunday = weeklyPostSlot(Date.UTC(2026, 10, 1, 18)) + 60_000;
  bot.setWeeklyChannel("g1", "deleted-channel", sunday - 7 * DAY);
  bot.discord.channelStatus.set("deleted-channel", 404);

  await bot.cron(sunday);
  assert.equal(bot.db.row("SELECT channel_error FROM guild_settings WHERE guild_id = 'g1'").channel_error, "unknown_channel");
});

test("PSN's 429 pauses all PSN calls until the cooldown ends", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(40, { cache: "stale" });
  bot.psn.perOwnerLimit = 5;

  await bot.cron();
  const callsAfterFirst = bot.psn.apiCalls;
  assert.ok(bot.db.row("SELECT cooldown_until FROM rate_limits WHERE key = 'psn:primary'").cooldown_until > Date.now());

  const second = await bot.cron();
  assert.equal(bot.psn.apiCalls, callsAfterFirst, "no PSN calls during the cooldown");
  assertRunWithinLimits(second);
});

test("the shared limiter caps PSN calls per 15 minutes across runs and commands", async () => {
  const bot = await createBot({ env: { PSN_CALLS_PER_15_MIN: "40" } });
  bot.seedAuth();
  bot.seedAccounts(100, { cache: "stale" });

  for (let i = 0; i < 4; i += 1) await bot.cron();
  assert.equal(bot.psn.apiCalls, 40);
});

test("a failing PSN login is recorded and the owner is told once a day", async () => {
  const bot = await createBot({ env: { PSN_NPSSO: "expired", OPS_CHANNEL_ID: "ops" } });
  bot.seedAccounts(10, { cache: "stale" });

  const run = await bot.cron();
  assertRunWithinLimits(run);
  assert.match(bot.db.row("SELECT value FROM job_state WHERE key = 'psn_auth_error'").value, /NPSSO/);

  await bot.cron();
  await bot.cron();
  const opsPosts = bot.discord.posts.filter((post) => post.channelId === "ops");
  assert.equal(opsPosts.length, 1);
  assert.match(allText(opsPosts[0].body), /PSN login is failing/);
  assert.match(allText(opsPosts[0].body), /wrangler secret put PSN_NPSSO/);
});

test("the owner is reminded before the PSN refresh token expires", async () => {
  const bot = await createBot({ env: { OPS_CHANNEL_ID: "ops" } });
  bot.seedAuth();
  bot.db.sqlite.prepare("UPDATE psn_auth_state SET refresh_token_expires_at = ?").run(Date.now() + 7 * DAY - HOUR);

  await bot.cron();
  await bot.cron();
  const reminders = bot.discord.posts.filter((post) => post.channelId === "ops");
  assert.equal(reminders.length, 1);
  assert.match(allText(reminders[0].body), /expires in 7 days/);
});

test("old accounts get avatars and their real Online ID filled in", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(3, { cache: "none" });
  bot.db.sqlite.prepare("UPDATE psn_trophy_cache SET psn_username = lower(psn_username)").run();

  await bot.cron();
  const row = bot.db.row("SELECT psn_username, avatar_url FROM psn_trophy_cache WHERE psn_id = ?", psnId(1));
  assert.equal(row.psn_username, "Player1");
  assert.match(row.avatar_url, /avatar\/1\.png/);
});

test("private profiles back off instead of burning PSN calls every run", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(1, { cache: "stale", overrides: () => ({ private: true }) });

  await bot.cron();
  const row = bot.db.row("SELECT last_error, next_refresh_at FROM psn_trophy_cache WHERE psn_id = ?", psnId(0));
  assert.equal(row.last_error, "private");
  assert.ok(row.next_refresh_at > Date.now() + 11 * HOUR);
});

test("removing someone's last link stops refreshing them", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(1, { cache: "stale", linkedBy: () => discordId(1) });
  await bot.command("removepsn", [option("username", "Player0")], bot.asUser(1));

  const calls = bot.psn.apiCalls;
  await bot.cron();
  assert.equal(bot.psn.apiCalls, calls);
});
