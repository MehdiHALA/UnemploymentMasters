import assert from "node:assert/strict";
import { test } from "node:test";

import * as ui from "../src/ui.js";
import { allText, validateMessage } from "./helpers/discord-validate.mjs";

const theme = ui.createTheme({});
const now = Date.now();
const longName = "Abcdefghijklmnop"; // 16 characters, the PSN maximum
const longTitle = "The Extraordinarily Long Game Title: Definitive Remastered Collector's Edition — Part Two (PS5)";

function row(rank, extra = {}) {
  return {
    rank,
    psn_id: `p${rank}`,
    discord_id: String(100000000000000000n + BigInt(rank)),
    name: `${longName.slice(0, 13)}${rank}`,
    avatar_url: `https://psn-rsc.prod.dl.playstation.net/avatar/${rank}.png`,
    trophy_level: 999,
    progress: 87,
    tier: 10,
    is_plus: 1,
    platinum: 1500 - rank,
    gold: 12000,
    silver: 34000,
    bronze: 98000,
    total: 145500,
    fetched_at: now,
    ...extra,
  };
}

function title(i) {
  return {
    titleName: `${longTitle} ${i}`,
    titleIconUrl: `https://image.api.playstation.com/trophy/np/NPWR${i}/icon.png`,
    platform: "PS4,PS5",
    progress: 73,
    platinum: 1,
    gold: 12,
    silver: 30,
    bronze: 60,
    total: 103,
    psnUsername: `${longName.slice(0, 14)}${i % 3}`,
    lastUpdatedAt: new Date(now - i * 3600_000).toISOString(),
  };
}

function assertValid(payload, label) {
  assert.deepEqual(validateMessage(payload), [], `${label} must satisfy Discord's limits`);
}

test("every view stays inside Discord's limits with maximum-size data", () => {
  const board = { rows: Array.from({ length: 10 }, (_, i) => row(i + 1)), linkedCount: 99999, rankedCount: 99990, pendingCount: 9, updatedAt: now };
  assertValid(ui.leaderboardMessage(board, { page: 1, pageSize: 10, theme }), "leaderboard page 1");
  assertValid(ui.leaderboardMessage({ ...board, rows: board.rows.map((r) => ({ ...r, rank: r.rank + 9980 })) }, { page: 999, pageSize: 10, theme }), "leaderboard last page");

  const rankRows = [];
  for (const mine of [5, 50, 500]) rankRows.push(row(mine - 1), row(mine, { is_mine: 1 }), row(mine + 1));
  assertValid(ui.rankView({ rows: rankRows, rankedCount: 99990 }, { theme }), "rank");

  assertValid(ui.profileView({ rows: [row(1), row(2, { avatar_url: null }), row(3, { fetched_at: 0, last_error: "private" })], rankedCount: 99990 }, { theme, targetUserId: "123456789012345678" }), "profile");

  const titles = Array.from({ length: 10 }, (_, i) => title(i));
  assertValid(ui.recentView({ titles, names: [longName, longName, longName] }, { theme }), "recent");
  assertValid(ui.platinumsView({ titles, owner: `${longName}, ${longName}, ${longName}`, totalPlatinum: 4500, scanned: 300 }, { theme }), "platinums");

  const player = (name) => ({ onlineId: name, avatarUrl: "https://psn-rsc.prod.dl.playstation.net/a.png", stats: { trophyLevel: 999, platinum: 1500, gold: 1, silver: 2, bronze: 3, total: 1506 }, recent: longTitle });
  assertValid(ui.compareView({ a: player(longName), b: player("Zyxwvutsrqponmlk") }, { theme }), "compare");

  const movers = { hasBaseline: true, baselineAt: now - 86400_000, trackedCount: 99999, movers: Array.from({ length: 10 }, (_, i) => ({ ...row(i + 1), platinum_gain: 99, gold_gain: 999, silver_gain: 999, bronze_gain: 9999, total_gain: 12096 })) };
  assertValid(ui.moversMessage(movers, { theme }), "movers");
  assertValid(ui.weeklyMessage(board, movers, { theme, pageSize: 10 }), "weekly post");
  assertValid(ui.platinumAlertMessage({ owner: longName, avatarUrl: null, titles: titles.slice(0, 3), platinumCount: 1500 }, { theme }), "platinum alert");

  assertValid(ui.supportView({ supportUrl: "https://ko-fi.com/example" }), "support");
  assertValid(ui.noticeView({ tone: "danger", title: "Something failed", body: "Details", suggestions: [longName, longName] }), "notice");
  assertValid(ui.weeklyEnabledView({ channelId: "123", nextPostAt: now }), "weekly enabled");
  assertValid(ui.channelReadyView(), "channel ready");
  assertValid(ui.linkedView({ account: { onlineId: longName, avatarUrl: null }, stats: { trophyLevel: 1, platinum: 0, gold: 0, silver: 0, bronze: 0, total: 0 } }, { theme }), "linked");
});

test("the text-only fallback keeps the words and drops what Discord might reject", () => {
  const titles = Array.from({ length: 10 }, (_, i) => title(i));
  const rich = ui.recentView({ titles, names: ["Someone"] }, { theme });
  const fallback = ui.textOnlyFallback(rich);
  assertValid(fallback, "fallback");
  assert.doesNotMatch(JSON.stringify(fallback), /"media"/);
  assert.match(allText(fallback), /Recent games/);
});

test("names cannot break formatting or ping anyone", () => {
  const payload = ui.leaderboardMessage(
    { rows: [row(1, { name: "**bold**_x_`@everyone`" })], linkedCount: 1, rankedCount: 1, pendingCount: 0, updatedAt: now },
    { page: 1, pageSize: 10, theme }
  );
  assert.match(allText(payload), /\\\*\\\*bold\\\*\\\*\\_x\\_\\`@everyone\\`/);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test("custom trophy emojis can be configured", () => {
  const custom = ui.createTheme({ EMOJI_PLATINUM: "<:plat:123>" });
  const payload = ui.leaderboardMessage({ rows: [row(1)], linkedCount: 1, rankedCount: 1, pendingCount: 0, updatedAt: now }, { page: 1, pageSize: 10, theme: custom });
  assert.match(allText(payload), /<:plat:123> \*\*1,499\*\*/);
});
