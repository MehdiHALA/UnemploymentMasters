// Runs the real Worker against an in-memory SQLite stand-in for D1 and fake PSN / Discord
// APIs, enforcing Workers Free limits (50 subrequests per invocation, shared between fetch
// and D1). Latency is virtual: every call adds its simulated time to the invocation's meter.

import { DatabaseSync } from "node:sqlite";

import worker from "../../src/worker.js";
import { ensureSchema, resetSchemaCacheForTests } from "../../src/db.js";
import { clearIsolateTokensForTests } from "../../src/psn.js";
import { resetThrottlesForTests } from "../../src/commands.js";
import { Budget, createContext } from "../../src/runtime.js";
import { validateMessage } from "./discord-validate.mjs";

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

const LATENCY = {
  // Discord calls the Worker from the US; a D1 database created from Europe adds ~100 ms.
  far: { read: 90, write: 110, psn: 300, discord: 100 },
  near: { read: 25, write: 40, psn: 300, discord: 100 },
};

export class Meter {
  constructor(limit) {
    this.limit = limit;
    this.d1 = 0;
    this.fetches = 0;
    this.psn = 0;
    this.virtualMs = 0;
  }

  get total() {
    return this.d1 + this.fetches;
  }

  charge(kind, ms) {
    if (this.total + 1 > this.limit) {
      throw new Error(kind === "d1" ? "D1_ERROR: Too many API requests by single Worker invocation." : "Too many subrequests.");
    }
    if (kind === "d1") this.d1 += 1;
    else this.fetches += 1;
    this.virtualMs += ms;
  }
}

class FakeStatement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new FakeStatement(this.db, this.sql, params);
  }

  values() {
    return this.params.map((value) => {
      if (value === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
      return typeof value === "boolean" ? Number(value) : value;
    });
  }

  execute() {
    const rows = this.db.sqlite.prepare(this.sql).all(...this.values());
    return { results: rows.map((row) => ({ ...row })), success: true, meta: {} };
  }

  isRead() {
    return /^\s*(select|with)\b/i.test(this.sql) && !/\b(insert|update|delete)\b/i.test(this.sql);
  }

  async first(column) {
    await this.db.charge(this.isRead());
    const row = this.execute().results[0] ?? null;
    return column === undefined ? row : (row?.[column] ?? null);
  }

  async all() {
    await this.db.charge(this.isRead());
    return this.execute();
  }

  async run() {
    await this.db.charge(false);
    return this.execute();
  }
}

export class FakeD1 {
  constructor(latency) {
    this.sqlite = new DatabaseSync(":memory:");
    this.latency = latency;
    this.meter = new Meter(Infinity);
    this.realDelayMs = 0;
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async charge(read) {
    this.meter.charge("d1", read ? this.latency.read : this.latency.write);
    if (this.realDelayMs) await new Promise((resolve) => setTimeout(resolve, this.realDelayMs));
    else await null;
  }

  // D1 batches are transactions: all statements succeed or none do.
  async batch(statements) {
    await this.charge(false);
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }

  // Direct, unmetered access for seeding and assertions.
  rows(sql, ...params) {
    return this.sqlite.prepare(sql).all(...params).map((row) => ({ ...row }));
  }

  row(sql, ...params) {
    return this.rows(sql, ...params)[0] ?? null;
  }
}

// ---------------------------------------------------------------------------------------
// Fake PSN.

export function psnId(index) {
  return `7${String(index).padStart(18, "0")}`;
}

export function discordId(index) {
  return String(100000000000000000n + BigInt(index));
}

export function makeTitles(count, { platinumEvery = 3, newestAt = Date.now() - HOUR, prefix = "Game" } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const hasPlatinum = i % platinumEvery === 0;
    return {
      npServiceName: "trophy2",
      npCommunicationId: `NPWR${String(i).padStart(5, "0")}_00`,
      trophySetVersion: "01.00",
      trophyTitleName: `${prefix} ${i}`,
      trophyTitleIconUrl: `https://image.api.playstation.com/trophy/np/NPWR${String(i).padStart(5, "0")}_00/icon.png`,
      trophyTitlePlatform: i % 2 ? "PS4" : "PS5",
      hasTrophyGroups: false,
      definedTrophies: { platinum: 1, gold: 5, silver: 10, bronze: 30 },
      progress: hasPlatinum ? 100 : 20 + (i % 70),
      earnedTrophies: hasPlatinum ? { platinum: 1, gold: 5, silver: 10, bronze: 30 } : { platinum: 0, gold: 1, silver: 3, bronze: 9 },
      hiddenFlag: false,
      lastUpdatedDateTime: new Date(newestAt - i * HOUR).toISOString(),
    };
  });
}

export function makeAccount(index, overrides = {}) {
  return {
    psnId: psnId(index),
    onlineId: `Player${index}`,
    avatarUrl: `https://psn-rsc.prod.dl.playstation.net/avatar/${index}.png`,
    isPlus: index % 2 === 0,
    private: false,
    level: 100 + (index % 600),
    progress: index % 100,
    tier: 1 + (index % 10),
    trophies: { platinum: (index * 7) % 120, gold: 50 + (index % 90), silver: 150 + (index % 200), bronze: 600 + index },
    titles: makeTitles(12),
    ...overrides,
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function createPsnWorld() {
  const world = {
    accounts: new Map(),
    validNpsso: new Set(["npsso-primary"]),
    validAccess: new Map(),
    validRefresh: new Map(),
    issued: 0,
    apiCalls: 0,
    callsByOwner: new Map(),
    authCalls: 0,
    forceStatus: null,
    perOwnerLimit: 300,

    add(account) {
      world.accounts.set(account.psnId, account);
      return account;
    },

    byName(name) {
      return [...world.accounts.values()].find((account) => account.onlineId.toLowerCase() === String(name).toLowerCase()) || null;
    },

    issue(owner) {
      world.issued += 1;
      const access = `access-${owner}-${world.issued}`;
      const refresh = `refresh-${owner}-${world.issued}`;
      world.validAccess.set(access, owner);
      world.validRefresh.set(refresh, owner);
      return { access_token: access, refresh_token: refresh, expires_in: 3599, refresh_token_expires_in: 5183999, id_token: "id", scope: "psn:mobile.v2.core psn:clientapp", token_type: "bearer" };
    },

    auth(url, init) {
      world.authCalls += 1;

      if (url.pathname.endsWith("/authorize")) {
        const npsso = /npsso=([^;]+)/.exec(init.headers?.Cookie || "")?.[1];
        const location = world.validNpsso.has(npsso)
          ? `com.scee.psxandroid.scecompcall://redirect/?code=code-${npsso}`
          : "com.scee.psxandroid.scecompcall://redirect/?error=login_required";
        return new Response(null, { status: 302, headers: { location } });
      }

      const form = new URLSearchParams(init.body);
      if (form.get("grant_type") === "refresh_token") {
        const owner = world.validRefresh.get(form.get("refresh_token"));
        return owner ? json(world.issue(owner)) : json({ error: "invalid_grant" }, 400);
      }

      const code = form.get("code") || "";
      const npsso = code.replace(/^code-/, "");
      return world.validNpsso.has(npsso) ? json(world.issue(npsso)) : json({ error: "invalid_grant" }, 400);
    },

    api(url, init) {
      const token = String(init.headers?.Authorization || "").replace(/^Bearer /, "");
      const owner = world.validAccess.get(token);
      if (!owner) return json({ error: { code: 2241024, message: "Authentication required" } }, 401);

      world.apiCalls += 1;
      const used = (world.callsByOwner.get(owner) || 0) + 1;
      world.callsByOwner.set(owner, used);
      if (used > world.perOwnerLimit) {
        return json({ error: { message: "Too many requests" } }, 429, { "X-RateLimit-Next-Available": String(Math.floor(Date.now() / 1000) + 600) });
      }
      if (world.forceStatus) return json({ error: { message: "forced" } }, world.forceStatus);

      const path = url.pathname;
      let match = path.match(/\/api\/trophy\/v1\/users\/([^/]+)\/trophySummary$/);
      if (match) {
        const account = world.accounts.get(decodeURIComponent(match[1]));
        if (!account) return json({ error: { message: "not found" } }, 404);
        if (account.private) return json({ error: { code: 2240526, message: "Not permitted by access control" } }, 403);
        return json({ accountId: account.psnId, trophyLevel: String(account.level), progress: account.progress, tier: account.tier, earnedTrophies: account.trophies });
      }

      match = path.match(/\/api\/trophy\/v1\/users\/([^/]+)\/trophyTitles$/);
      if (match) {
        const account = world.accounts.get(decodeURIComponent(match[1]));
        if (!account) return json({ error: { message: "not found" } }, 404);
        if (account.private) return json({ error: { message: "Not permitted by access control" } }, 403);
        const limit = Number(url.searchParams.get("limit") || 100);
        const offset = Number(url.searchParams.get("offset") || 0);
        const titles = account.titles.slice(offset, offset + limit);
        return json({ trophyTitles: titles, totalItemCount: account.titles.length, ...(offset + limit < account.titles.length ? { nextOffset: offset + limit } : {}) });
      }

      match = path.match(/\/api\/userProfile\/v1\/internal\/users\/([^/]+)\/profiles$/);
      if (match) {
        const account = world.accounts.get(decodeURIComponent(match[1]));
        if (!account) return json({ error: { message: "not found" } }, 404);
        return json({ onlineId: account.onlineId, aboutMe: "", avatars: [{ size: "s", url: `${account.avatarUrl}?s` }, { size: "l", url: account.avatarUrl }], languages: ["en"], isPlus: account.isPlus, isOfficiallyVerified: false, isMe: false });
      }

      match = path.match(/\/userProfile\/v1\/users\/([^/]+)\/profile2$/);
      if (match) {
        const account = world.byName(decodeURIComponent(match[1]));
        if (!account) return json({ error: { code: 2105356, message: "User not found" } }, 404);
        return json({ profile: { onlineId: account.onlineId, accountId: account.psnId, npId: "x", avatarUrls: [{ size: "l", avatarUrl: account.avatarUrl }], plus: account.isPlus ? 1 : 0, aboutMe: "" } });
      }

      if (path.endsWith("/api/search/v1/universalSearch")) {
        const term = String(JSON.parse(init.body || "{}").searchTerm || "").toLowerCase();
        const results = [...world.accounts.values()]
          .filter((account) => account.onlineId.toLowerCase().includes(term.slice(0, 4)))
          .slice(0, 8)
          .map((account) => ({ id: account.psnId, type: "SocialAllAccounts", socialMetadata: { accountId: account.psnId, onlineId: account.onlineId, avatarUrl: account.avatarUrl, isPsPlus: account.isPlus } }));
        return json({ domainResponses: [{ domain: "SocialAllAccounts", results }] });
      }

      return json({ error: { message: "unknown endpoint" } }, 404);
    },
  };
  return world;
}

// ---------------------------------------------------------------------------------------
// Fake Discord.

function hasImages(payload) {
  return JSON.stringify(payload).includes('"media"');
}

export function createDiscord() {
  const discord = {
    edits: [],
    followups: [],
    deletes: [],
    posts: [],
    rejected: [],
    channelStatus: new Map(),
    rejectImages: false,

    handle(url, method, init) {
      const body = init.body ? JSON.parse(init.body) : null;
      const parts = url.pathname.split("/").filter(Boolean);

      if (parts[2] === "webhooks") {
        const token = parts[4];
        if (method === "DELETE") {
          discord.deletes.push({ token });
          return new Response(null, { status: 204 });
        }
        const errors = validateMessage(body, { edit: method === "PATCH" });
        if (discord.rejectImages && hasImages(body)) errors.push("simulated: Discord rejected the media");
        if (errors.length > 0) {
          discord.rejected.push({ token, errors });
          return json({ message: errors.join("; "), code: 50035 }, 400);
        }
        (method === "PATCH" ? discord.edits : discord.followups).push({ token, body });
        return json({ id: "message" });
      }

      if (parts[2] === "channels" && method === "POST") {
        const channelId = parts[3];
        const status = discord.channelStatus.get(channelId) || 200;
        if (status === 404) return json({ message: "Unknown Channel", code: 10003 }, 404);
        if (status !== 200) return json({ message: "Missing Access", code: 50001 }, status);
        const errors = validateMessage(body);
        if (discord.rejectImages && hasImages(body)) errors.push("simulated: Discord rejected the media");
        if (errors.length > 0) {
          discord.rejected.push({ channelId, errors });
          return json({ message: errors.join("; "), code: 50035 }, 400);
        }
        discord.posts.push({ channelId, body });
        return json({ id: "post" });
      }

      return json({ message: "Unknown route" }, 404);
    },
  };
  return discord;
}

// ---------------------------------------------------------------------------------------
// The bot under test.

const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export async function createBot({ latency = "far", limit = 50, env: envOverrides = {} } = {}) {
  resetSchemaCacheForTests();
  clearIsolateTokensForTests();
  resetThrottlesForTests();

  const timing = LATENCY[latency];
  const db = new FakeD1(timing);
  const psn = createPsnWorld();
  const discord = createDiscord();
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const env = {
    DB: db,
    DISCORD_PUBLIC_KEY: hex(await crypto.subtle.exportKey("raw", keys.publicKey)),
    DISCORD_BOT_TOKEN: "bot-token",
    PSN_NPSSO: "npsso-primary",
    SUPPORT_URL: "https://example.com/support",
    ...envOverrides,
  };

  let meter = new Meter(Infinity);
  let tokenCounter = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method || "GET").toUpperCase();
    const isDiscord = url.hostname === "discord.com";
    meter.charge("fetch", isDiscord ? timing.discord : timing.psn);
    await null;

    if (isDiscord) return discord.handle(url, method, init);
    if (url.hostname === "ca.account.sony.com") return psn.auth(url, init);
    meter.psn += 1;
    return psn.api(url, init);
  };

  await ensureSchema(createContext(env, { budget: new Budget(10_000, 0) }));

  function useMeter() {
    meter = new Meter(limit);
    db.meter = meter;
    return meter;
  }

  async function invoke(interaction) {
    const used = useMeter();
    tokenCounter += 1;
    const token = `token-${tokenCounter}`;
    const body = JSON.stringify({
      id: `interaction-${tokenCounter}`,
      application_id: "app",
      token,
      version: 1,
      guild_id: "g1",
      member: { user: { id: discordId(0), username: "tester" }, permissions: "0" },
      ...interaction,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = hex(await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(timestamp + body)));
    const promises = [];
    const res = await worker.fetch(
      new Request("https://bot.example/interactions", {
        method: "POST",
        headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp },
        body,
      }),
      env,
      { waitUntil: (promise) => promises.push(promise) }
    );

    const reply = await res.json();
    const replyErrors = [];
    if ([4, 7].includes(reply.type)) replyErrors.push(...validateMessage(reply.data));
    if (reply.type === 5 && Number(reply.data?.flags || 0) & ~64) replyErrors.push("deferred reply may only set EPHEMERAL");

    await Promise.all(promises);

    const edits = discord.edits.filter((edit) => edit.token === token).map((edit) => edit.body);
    const followups = discord.followups.filter((followup) => followup.token === token).map((followup) => followup.body);
    const final = followups.at(-1) || edits.at(-1) || ([4, 7].includes(reply.type) ? reply.data : null);

    return { reply, replyErrors, meter: used, edits, followups, final, deleted: discord.deletes.some((d) => d.token === token) };
  }

  const bot = {
    env,
    db,
    psn,
    discord,
    meter: () => meter,

    asUser(index, permissions = "0") {
      return { member: { user: { id: discordId(index), username: `user${index}` }, permissions } };
    },

    command(name, options = [], extra = {}) {
      return invoke({ type: 2, data: { id: `cmd-${name}`, name, type: 1, options }, ...extra });
    },

    component(customId, extra = {}) {
      return invoke({ type: 3, data: { custom_id: customId, component_type: 2 }, message: { id: "message" }, ...extra });
    },

    autocomplete(name, options, extra = {}) {
      return invoke({ type: 4, data: { id: `cmd-${name}`, name, type: 1, options }, ...extra });
    },

    async cron(scheduledTime = Date.now()) {
      const used = useMeter();
      const promises = [];
      await worker.scheduled({ cron: "*/5 * * * *", scheduledTime }, env, { waitUntil: (promise) => promises.push(promise) });
      const [report] = await Promise.all(promises);
      return { meter: used, report };
    },

    seedAuth({ owner = "npsso-primary", key = "primary", accessValidMs = 50 * 60 * 1000 } = {}) {
      const tokens = psn.issue(owner);
      const now = Date.now();
      db.sqlite
        .prepare(
          `INSERT OR REPLACE INTO psn_auth_state (key, access_token, access_token_expires_at, id_token, refresh_token, refresh_token_expires_at, scope, token_type, updated_at)
           VALUES (?, ?, ?, 'id', ?, ?, 'psn:mobile.v2.core psn:clientapp', 'bearer', ?)`
        )
        .run(key, tokens.access_token, now + accessValidMs, tokens.refresh_token, now + 30 * DAY, now);
      return tokens;
    },

    // Links `count` accounts in a guild. cache: "fresh" | "stale" | "none".
    seedAccounts(count, { guildId = "g1", cache = "stale", start = 0, linkedBy = (i) => discordId(i + 1), overrides = () => ({}) } = {}) {
      const now = Date.now();
      const insertUser = db.sqlite.prepare(
        "INSERT INTO psn_users (id, discord_id, guild_id, psn_username, psn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const insertCache = db.sqlite.prepare(
        `INSERT INTO psn_trophy_cache (psn_id, psn_username, trophy_level, progress, tier, platinum, gold, silver, bronze, total,
           fetched_at, tracked, next_refresh_at, alert_platinum, alert_synced_at, avatar_url, profile_checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(psn_id) DO NOTHING`
      );

      const accounts = [];
      for (let i = start; i < start + count; i += 1) {
        const account = psn.add(makeAccount(i, overrides(i)));
        accounts.push(account);
        const owner = linkedBy(i);
        insertUser.run(`${guildId}:${owner}:${account.onlineId.toLowerCase()}`, owner, guildId, account.onlineId, account.psnId, now);
        const t = account.trophies;
        const fetchedAt = cache === "fresh" ? now - HOUR : cache === "stale" ? now - 7 * HOUR : 0;
        const nextRefresh = cache === "fresh" ? now + 5 * HOUR : 0;
        insertCache.run(
          account.psnId,
          account.onlineId,
          account.level,
          account.progress,
          account.tier,
          t.platinum,
          t.gold,
          t.silver,
          t.bronze,
          t.platinum + t.gold + t.silver + t.bronze,
          fetchedAt,
          nextRefresh,
          fetchedAt ? t.platinum : null,
          fetchedAt,
          cache === "none" ? null : account.avatarUrl,
          cache === "none" ? 0 : now
        );
      }
      return accounts;
    },

    setWeeklyChannel(guildId, channelId, lastPostAt = null) {
      db.sqlite
        .prepare(
          `INSERT INTO guild_settings (guild_id, leaderboard_channel_id, weekly_leaderboard_enabled, last_weekly_post_at, updated_at)
           VALUES (?, ?, 1, ?, 0)
           ON CONFLICT(guild_id) DO UPDATE SET leaderboard_channel_id = excluded.leaderboard_channel_id, weekly_leaderboard_enabled = 1, last_weekly_post_at = excluded.last_weekly_post_at`
        )
        .run(guildId, channelId, lastPostAt);
    },
  };

  return bot;
}

export const option = (name, value, type = 3, extra = {}) => ({ name, type, value, ...extra });
