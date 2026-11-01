// Platinum (premium) status and per-server branding.
//
// A server has Platinum when any of these is true:
//   - it was granted by the owner (/admin grant) and has not expired (premium_guilds table);
//   - it is listed in PREMIUM_GUILD_IDS (testing);
//   - it has an active Discord server subscription to PREMIUM_SKU_ID, seen with a command or
//     by the hourly background check. This is the payment hook: it stays inert until a SKU
//     is configured.

import { DAY_MS, ENTITLEMENT_GRACE_MS } from "./config.js";
import * as pdb from "./db-premium.js";
import { hasManageGuild } from "./discord.js";
import { createTheme } from "./ui.js";

const CACHE_MS = 60 * 1000;
const TITLES_CACHE_MS = 5 * 60 * 1000;
const brandingCache = new Map();
const titlesCache = new Map();

export function clearPremiumCacheForTests() {
  brandingCache.clear();
  titlesCache.clear();
}

export function forgetGuild(guildId) {
  brandingCache.delete(guildId);
}

export function parseEmojiJson(json) {
  try {
    const value = JSON.parse(json || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function brandingTheme(env, row, premium) {
  if (!premium || !row) return createTheme(env);
  const accent = row.accent_color === null || row.accent_color === undefined ? null : Number(row.accent_color);
  return createTheme(env, { accent: Number.isInteger(accent) ? accent : null, emojis: parseEmojiJson(row.emoji_json) });
}

// Only server subscriptions count: Platinum is sold per server, not per person.
export function isActiveServerEntitlement(entitlement, sku, now) {
  return (
    Boolean(sku) &&
    entitlement.sku_id === sku &&
    !entitlement.deleted &&
    Boolean(entitlement.guild_id) &&
    (!entitlement.starts_at || Date.parse(entitlement.starts_at) <= now) &&
    (!entitlement.ends_at || Date.parse(entitlement.ends_at) > now)
  );
}

export function activeEntitlement(ctx, interaction, now = Date.now()) {
  const sku = ctx.settings.premiumSkuId;
  if (!sku || !interaction.guild_id) return null;
  return (
    (interaction.entitlements || []).find((e) => e.guild_id === interaction.guild_id && isActiveServerEntitlement(e, sku, now)) || null
  );
}

export function entitlementUntil(entitlement, now) {
  const ends = entitlement.ends_at ? Date.parse(entitlement.ends_at) : Number.NaN;
  return Number.isFinite(ends) ? ends : now + ENTITLEMENT_GRACE_MS;
}

async function brandingFor(ctx, guildId, now) {
  const cached = brandingCache.get(guildId);
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = (await pdb.getGuildBranding(ctx, guildId, now)) || {};
  brandingCache.set(guildId, { value, at: now });
  if (brandingCache.size > 2000) brandingCache.clear();
  return value;
}

// Sets ctx.premium, ctx.branding and ctx.theme for an interaction.
export async function loadGuildContext(ctx, interaction) {
  const guildId = interaction.guild_id;
  if (!guildId) {
    ctx.premium = false;
    return ctx;
  }

  const now = Date.now();
  let branding = {};
  try {
    branding = await brandingFor(ctx, guildId, now);
  } catch (err) {
    // Platinum must never break the free features: fall back to the defaults.
    console.error("Platinum status lookup failed:", err);
  }
  const entitlement = activeEntitlement(ctx, interaction, now);
  const stored = Number(branding.premium || 0) === 1;
  ctx.premium = stored || ctx.settings.premiumGuildIds.includes(guildId) || Boolean(entitlement);
  ctx.branding = branding;
  ctx.theme = brandingTheme(ctx.env, branding, ctx.premium);

  // Payment hook: remember paying servers so background jobs treat them as Platinum too.
  // Written at most about once a day; the statement itself never shortens what is stored.
  if (entitlement) {
    const until = entitlementUntil(entitlement, now);
    const storedUntil = branding.expires_at === null || branding.expires_at === undefined ? null : Number(branding.expires_at);
    if (!stored || (storedUntil !== null && storedUntil < until - DAY_MS)) {
      try {
        await pdb.extendEntitlementStatement(ctx, { guildId, note: `sku ${entitlement.sku_id}`, now, expiresAt: until }).run();
        forgetGuild(guildId);
      } catch (err) {
        console.error("Couldn't record a Platinum purchase:", err);
      }
    }
  }

  return ctx;
}

export function linkCap(ctx, interaction) {
  const moderator = hasManageGuild(interaction);
  if (ctx.premium) return moderator ? ctx.settings.premiumLinksPerModerator : ctx.settings.premiumLinksPerUser;
  return moderator ? ctx.settings.maxLinksPerModerator : ctx.settings.maxLinksPerUser;
}

export function monthKey(now) {
  return new Date(now).toISOString().slice(0, 7);
}

// Statements that switch Platinum on for a server: grant, refresh its accounts first, and
// start this month's standings if they have not started yet.
export function grantStatements(ctx, { guildId, days, note, source = "grant", now, startMonthly }) {
  const statements = [
    pdb.grantPremiumStatement(ctx, { guildId, source, note, now, expiresAt: days ? now + days * DAY_MS : null }),
    pdb.prioritizeGuildRefreshStatement(ctx, guildId),
  ];
  if (startMonthly) statements.push(...pdb.monthlyBaselineStatements(ctx, guildId, monthKey(now), now));
  return statements;
}

export function isOwner(ctx, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  if (ctx.settings.ownerUserIds.includes(String(userId))) return true;
  if (interaction.guild_id !== ctx.settings.ownerGuildId) return false;
  try {
    const permissions = BigInt(interaction.member?.permissions || 0);
    return (permissions & (1n << 3n)) === 1n << 3n;
  } catch {
    return false;
  }
}

// Every server that should currently have the Platinum commands registered.
export async function premiumGuildIds(ctx, now) {
  const rows = await pdb.getActivePremiumGuilds(ctx, now);
  return [...new Set([...rows.map((row) => row.guild_id), ...ctx.settings.premiumGuildIds])];
}

// Games this server's members have played, cached briefly so autocomplete doesn't re-read
// every stored game on each keystroke.
export async function guildTitles(ctx, guildId) {
  const now = Date.now();
  const cached = titlesCache.get(guildId);
  if (cached && now - cached.at < TITLES_CACHE_MS) return cached.rows;
  const rows = await pdb.listGuildTitles(ctx, guildId, 2000);
  titlesCache.set(guildId, { rows, at: now });
  if (titlesCache.size > 100) titlesCache.delete(titlesCache.keys().next().value);
  return rows;
}
