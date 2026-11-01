import assert from "node:assert/strict";
import { test } from "node:test";

import { resetThrottlesForTests } from "../src/commands.js";
import { allText, countImages, findButtons } from "./helpers/discord-validate.mjs";
import { createBot, discordId, makeAccount, makeTitles, option, psnId } from "./helpers/harness.mjs";

const MANAGE_GUILD = String(1 << 5);
const SUBREQUEST_BUDGET = 45;

function assertWithinFreeLimits(result) {
  assert.deepEqual(result.replyErrors, [], "initial reply must be valid for Discord");
  assert.ok(result.meter.total <= SUBREQUEST_BUDGET, `used ${result.meter.total} subrequests`);
  assert.ok(result.meter.virtualMs < 25_000, `took ${result.meter.virtualMs} ms of simulated time`);
  assert.ok(result.final, "user must always get an answer");
}

test("/leaderboard answers instantly from cache in a 1,000-account server", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(1000, { cache: "stale" });

  const result = await bot.command("leaderboard");

  assert.equal(result.reply.type, 4, "answers directly instead of 'thinking…'");
  assertWithinFreeLimits(result);
  const text = allText(result.reply.data);
  assert.match(text, /Trophy Leaderboard/);
  assert.match(text, /1,000 ranked/);
  assert.match(text, /Page 1\/100/);
  assert.equal(countImages(result.reply.data), 3, "podium shows avatars");
  assert.deepEqual(
    findButtons(result.reply.data).map((b) => b.custom_id),
    ["lb:page:0", "lb:noop", "lb:page:2", "lb:me", "lb:refresh:1"]
  );
  assert.ok(result.meter.psn <= 6, "background top-up refreshes at most 6 accounts");
});

test("/leaderboard counts private profiles separately from accounts still syncing", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(4, { cache: "fresh" });
  bot.seedAccounts(5, { cache: "none", start: 10 });
  bot.db.sqlite.prepare("UPDATE psn_trophy_cache SET last_error = 'private' WHERE psn_id IN (?, ?)").run(psnId(10), psnId(11));

  const result = await bot.command("leaderboard");
  const text = allText(result.reply.data);
  assert.match(text, /4 ranked · ⏳ 3 syncing · 🔒 2 private/);
});

test("/leaderboard with no linked accounts explains how to join", async () => {
  const bot = await createBot();
  const result = await bot.command("leaderboard");
  assertWithinFreeLimits(result);
  assert.match(allText(result.final), /\/addpsn/);
});

test("leaderboard pages, clamps out-of-range pages and keeps ranks in order", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(45, { cache: "fresh" });

  const page2 = await bot.component("lb:page:2");
  assert.equal(page2.reply.type, 7, "updates the existing message");
  assertWithinFreeLimits(page2);
  const text = allText(page2.reply.data);
  assert.match(text, /`#11`/);
  assert.match(text, /`#20`/);
  assert.doesNotMatch(text, /`#21`/);

  const beyond = await bot.component("lb:page:99");
  assert.match(allText(beyond.reply.data), /Page 5\/5/);
  assert.match(allText(beyond.reply.data), /`#45`/);
});

test("📍 Me shows the clicker's rank privately without changing the board", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(30, { cache: "fresh" });

  const result = await bot.component("lb:me", bot.asUser(5));
  assert.equal(result.reply.type, 4);
  assert.ok(result.reply.data.flags & 64, "ephemeral");
  assert.match(allText(result.reply.data), /#\d+ of 30/);
});

test("/rank shows the gap to the players above and below", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(20, { cache: "fresh" });

  const result = await bot.command("rank", [], bot.asUser(10));
  assertWithinFreeLimits(result);
  const text = allText(result.final);
  assert.match(text, /of 20/);
  assert.ok(/⬆️/.test(text) || /👑/.test(text));
});

test("/profile refreshes stale stats for the member within budget", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(500, { cache: "stale" });
  bot.psn.accounts.get(psnId(4)).trophies.platinum = 999;

  const result = await bot.command("profile", [], bot.asUser(5));
  assertWithinFreeLimits(result);
  const text = allText(result.final);
  assert.match(text, /Player4/);
  assert.match(text, /999/, "shows the refreshed platinum count");
  assert.match(text, /rank \*\*#1\*\*/);
  assert.equal(countImages(result.final), 1);
});

test("/addpsn links an exact account, shows its card and rejects guesses", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.psn.add(makeAccount(900, { onlineId: "TrophyKing" }));
  bot.psn.add(makeAccount(901, { onlineId: "TrophyQueen" }));

  const linked = await bot.command("addpsn", [option("username", "trophyking")], bot.asUser(1));
  assert.equal(linked.reply.type, 5);
  assertWithinFreeLimits(linked);
  assert.match(allText(linked.final), /Linked \*\*TrophyKing\*\*/);
  assert.ok(bot.db.row("SELECT * FROM psn_users WHERE psn_id = ?", psnId(900)), "stored the link");
  assert.equal(bot.db.row("SELECT tracked FROM psn_trophy_cache WHERE psn_id = ?", psnId(900)).tracked, 1);

  const miss = await bot.command("addpsn", [option("username", "TrophyKin")], bot.asUser(2));
  assert.ok(miss.deleted, "public 'thinking…' replaced by a private error");
  assert.ok(miss.followups[0].flags & 64);
  const missText = allText(miss.final);
  assert.match(missText, /Couldn't find/);
  assert.match(missText, /TrophyKing/, "offers the close match as a suggestion only");
  assert.equal(bot.db.rows("SELECT * FROM psn_users WHERE discord_id = ?", discordId(2)).length, 0, "never links a guess");

  const duplicate = await bot.command("addpsn", [option("username", "TrophyKing")], bot.asUser(3));
  assert.match(allText(duplicate.final), /already linked/);

  const invalid = await bot.command("addpsn", [option("username", "9bad name")], bot.asUser(3));
  assert.match(allText(invalid.final), /isn't a valid PSN Online ID/);
});

test("/addpsn caps accounts per member", async () => {
  const bot = await createBot({ env: { MAX_LINKS_PER_USER: "2" } });
  bot.seedAuth();
  bot.seedAccounts(2, { cache: "fresh", linkedBy: () => discordId(7) });
  bot.psn.add(makeAccount(950, { onlineId: "ThirdOne" }));

  const result = await bot.command("addpsn", [option("username", "ThirdOne")], bot.asUser(7));
  assert.match(allText(result.final), /up to 2 accounts/);
});

test("/addpsn lets moderators link accounts for their community beyond the member cap", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(26, { cache: "fresh", linkedBy: () => discordId(7) });
  bot.psn.add(makeAccount(951, { onlineId: "Newcomer" }));

  const result = await bot.command("addpsn", [option("username", "Newcomer")], bot.asUser(7, MANAGE_GUILD));
  assert.match(allText(result.final), /Linked \*\*Newcomer\*\*/);
});

test("/addpsn on a private profile links it and explains how to rank", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.psn.add(makeAccount(960, { onlineId: "Shy", private: true }));

  const result = await bot.command("addpsn", [option("username", "Shy")], bot.asUser(1));
  assert.match(allText(result.final), /private/);
  assert.equal(bot.db.row("SELECT last_error FROM psn_trophy_cache WHERE psn_id = ?", psnId(960)).last_error, "private");
});

test("/removepsn unlinks, autocompletes and protects other members", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(3, { cache: "fresh", linkedBy: () => discordId(1) });

  const choices = await bot.autocomplete("removepsn", [option("username", "play", 3, { focused: true })], bot.asUser(1));
  assert.equal(choices.reply.type, 8);
  assert.deepEqual(choices.reply.data.choices.map((c) => c.value), ["Player0", "Player1", "Player2"]);

  const blocked = await bot.command("removepsn", [option("username", "Player0"), option("user", discordId(1), 6)], bot.asUser(2));
  assert.match(allText(blocked.final), /Only moderators/);

  const removed = await bot.command("removepsn", [option("username", "player0")], bot.asUser(1));
  assertWithinFreeLimits(removed);
  assert.ok(removed.reply.data.flags & 64, "private confirmation");
  assert.match(allText(removed.final), /Unlinked Player0/);
  assert.equal(bot.db.row("SELECT tracked FROM psn_trophy_cache WHERE psn_id = ?", psnId(0)).tracked, 0, "stops refreshing it");

  const moderator = await bot.command("removepsn", [option("username", "Player1"), option("user", discordId(1), 6)], bot.asUser(2, MANAGE_GUILD));
  assert.match(allText(moderator.final), /Unlinked Player1/);
});

test("/recent shows up to 10 games with art inside Discord's limits", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(1, { cache: "fresh", linkedBy: () => discordId(1) });

  const result = await bot.command("recent", [option("limit", 10, 4)], bot.asUser(1));
  assertWithinFreeLimits(result);
  assert.equal(countImages(result.final), 10);
  assert.match(allText(result.final), /Recent games/);
  assert.equal(bot.db.rows("SELECT * FROM psn_title_snapshots").length, 10);
});

test("/recent falls back to saved games when PSN is down", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(1, { cache: "fresh", linkedBy: () => discordId(1) });
  await bot.command("recent", [], bot.asUser(1));
  resetThrottlesForTests();
  bot.psn.forceStatus = 503;

  const result = await bot.command("recent", [], bot.asUser(1));
  assertWithinFreeLimits(result);
  const text = allText(result.final);
  assert.match(text, /Cached copy/);
  assert.match(text, /Game 0/);
});

test("/recent asks spammers to slow down", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(1, { cache: "fresh", linkedBy: () => discordId(1) });
  await bot.command("recent", [], bot.asUser(1));
  const again = await bot.command("recent", [], bot.asUser(1));
  assert.match(allText(again.final), /Slow down/);
});

test("/platinums handles an 800-game library within one request", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(1, { cache: "fresh", linkedBy: () => discordId(1), overrides: () => ({ titles: makeTitles(800) }) });

  const result = await bot.command("platinums", [option("limit", 10, 4)], bot.asUser(1));
  assertWithinFreeLimits(result);
  const text = allText(result.final);
  assert.match(text, /Platinum cabinet/);
  assert.match(text, /\*\*10\.\*\*/);
  assert.equal(countImages(result.final), 10, "trophy cabinet gallery");
  assert.ok(bot.db.rows("SELECT * FROM psn_title_snapshots").length <= 100, "stores platinum games only");
});

test("/platinums works for any Online ID without storing a stranger's games", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.psn.add(makeAccount(970, { onlineId: "Stranger" }));

  const result = await bot.command("platinums", [option("username", "Stranger")], bot.asUser(1));
  assertWithinFreeLimits(result);
  assert.match(allText(result.final), /Stranger/);
  assert.equal(bot.db.rows("SELECT * FROM psn_title_snapshots").length, 0);
});

test("/compare draws a head-to-head card", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.psn.add(makeAccount(980, { onlineId: "Alpha" }));
  bot.psn.add(makeAccount(981, { onlineId: "Beta" }));

  const result = await bot.command("compare", [option("username1", "Alpha"), option("username2", "Beta")], bot.asUser(1));
  assertWithinFreeLimits(result);
  const text = allText(result.final);
  assert.match(text, /Alpha vs Beta/);
  assert.match(text, /Head-to-head/);
  assert.ok(/leads|Dead even/.test(text));
  assert.equal(countImages(result.final), 2);
});

test("/movers starts tracking, then ranks weekly gains", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(30, { cache: "fresh" });

  const first = await bot.command("movers");
  assertWithinFreeLimits(first);
  assert.match(allText(first.final), /tracking started/i);

  bot.db.sqlite.prepare("UPDATE psn_trophy_cache SET platinum = platinum + 2, total = total + 2 WHERE psn_id = ?").run(psnId(3));
  const second = await bot.command("movers");
  const text = allText(second.final);
  assert.match(text, /Player3/);
  assert.match(text, /\+2 🏆/);
});

test("/weeklyleaderboard set checks the channel, posts and can be disabled", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.seedAccounts(12, { cache: "fresh" });
  const admin = bot.asUser(1, MANAGE_GUILD);
  const sub = (name, options = []) => [{ name, type: 1, options }];

  const denied = await bot.command("weeklyleaderboard", sub("set", [option("channel", "c1", 7)]), bot.asUser(2));
  assert.match(allText(denied.final), /Manage Server/);

  bot.discord.channelStatus.set("locked", 403);
  const locked = await bot.command("weeklyleaderboard", sub("set", [option("channel", "locked", 7)]), admin);
  assert.match(allText(locked.final), /Send Messages/);

  const set = await bot.command("weeklyleaderboard", sub("set", [option("channel", "c1", 7)]), admin);
  assertWithinFreeLimits(set);
  assert.match(allText(set.final), /every Sunday/);
  assert.equal(bot.discord.posts.at(-1).channelId, "c1", "posted a confirmation in the channel");

  const post = await bot.command("weeklyleaderboard", sub("post"), admin);
  assertWithinFreeLimits(post);
  assert.match(allText(bot.discord.posts.at(-1).body), /Weekly Trophy Standings/);

  const off = await bot.command("weeklyleaderboard", sub("disable"), admin);
  assert.match(allText(off.final), /off/);
});

test("/support shows a link button", async () => {
  const bot = await createBot();
  const result = await bot.command("support");
  assertWithinFreeLimits(result);
  assert.equal(findButtons(result.final)[0].url, "https://example.com/support");
});

test("a slow database still gets an answer via 'thinking…'", async () => {
  const bot = await createBot({ env: { SYNC_REPLY_TIMEOUT_MS: "20" } });
  bot.seedAuth();
  bot.seedAccounts(5, { cache: "fresh" });
  bot.db.realDelayMs = 40;

  const result = await bot.command("leaderboard");
  assert.equal(result.reply.type, 5, "falls back to a deferred reply");
  assert.equal(result.edits.length, 1, "then edits in the leaderboard");
  assert.match(allText(result.final), /Trophy Leaderboard/);
});

test("if Discord rejects the rich layout the user still gets a text answer", async () => {
  const bot = await createBot();
  bot.seedAuth();
  bot.discord.rejectImages = true;
  bot.psn.add(makeAccount(990, { onlineId: "Gamma" }));

  const result = await bot.command("addpsn", [option("username", "Gamma")], bot.asUser(1));
  assert.equal(result.edits.length, 1);
  assert.match(allText(result.final), /Linked \*\*Gamma\*\*/);
});

test("expired PSN login: cached leaderboard still works and lookups explain the problem", async () => {
  const bot = await createBot({ env: { PSN_NPSSO: "expired" } });
  bot.seedAccounts(10, { cache: "stale" });

  const board = await bot.command("leaderboard");
  assertWithinFreeLimits(board);
  assert.match(allText(board.final), /10 ranked/);

  bot.psn.add(makeAccount(995, { onlineId: "Delta" }));
  const add = await bot.command("addpsn", [option("username", "Delta")], bot.asUser(1));
  assert.match(allText(add.final), /PlayStation login is unavailable/);
});

test("the backup PSN account takes over when the primary login fails", async () => {
  const bot = await createBot({ env: { PSN_NPSSO: "expired", PSN_NPSSO_BACKUP: "npsso-backup" } });
  bot.psn.validNpsso.add("npsso-backup");
  bot.psn.add(makeAccount(996, { onlineId: "Epsilon" }));

  const result = await bot.command("addpsn", [option("username", "Epsilon")], bot.asUser(1));
  assert.match(allText(result.final), /Linked \*\*Epsilon\*\*/);
  assert.ok(bot.db.row("SELECT * FROM psn_auth_state WHERE key = 'backup'"), "stored the backup account's tokens");
});

test("requests with a bad signature are rejected", async () => {
  const bot = await createBot();
  const { default: worker } = await import("../src/worker.js");
  const res = await worker.fetch(
    new Request("https://bot.example/", {
      method: "POST",
      headers: { "X-Signature-Ed25519": "00".repeat(64), "X-Signature-Timestamp": "1" },
      body: JSON.stringify({ type: 1 }),
    }),
    bot.env,
    { waitUntil() {} }
  );
  assert.equal(res.status, 401);
});
