export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export const PSN_AUTH_BASE_URL = "https://ca.account.sony.com/api/authz/v3/oauth";
export const PSN_SEARCH_URL = "https://m.np.playstation.com/api/search/v1/universalSearch";
export const PSN_TROPHY_BASE_URL = "https://m.np.playstation.com/api/trophy/v1";
export const PSN_PROFILE_BASE_URL = "https://m.np.playstation.com/api/userProfile/v1/internal/users";
export const PSN_LEGACY_PROFILE_BASE_URL = "https://us-prof.np.community.playstation.net/userProfile/v1/users";

// Public PlayStation App client credentials (the same ones psn-api uses).
export const PSN_CLIENT_ID = "09515159-7237-4370-9b40-3806e67c0891";
export const PSN_CLIENT_BASIC_AUTH = "Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=";
export const PSN_REDIRECT_URI = "com.scee.psxandroid.scecompcall://redirect";
export const PSN_SCOPE = "psn:mobile.v2.core psn:clientapp";

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// The old hard-coded reminder target (Outplayed Trash). Override with OPS_CHANNEL_ID.
export const DEFAULT_OPS_CHANNEL_ID = "784782670856978468";
// The owner's server, where /admin is registered. Override with OWNER_GUILD_ID.
export const DEFAULT_OWNER_GUILD_ID = "784782670856978464";
// Fallback NPSSO expiry used before a refresh token has been stored.
export const NPSSO_EXPIRES_AT_MS = Date.UTC(2026, 7, 10, 0, 0, 0);
export const NPSSO_LIFETIME_MS = 60 * DAY_MS;
export const NPSSO_REMINDER_THRESHOLDS = [14, 7, 3, 1];

export const PSN_AUTH_STATE_KEY = "primary";
export const PSN_ACCESS_TOKEN_REFRESH_GRACE_MS = 5 * MINUTE_MS;
export const PSN_USERNAME_CACHE_TTL_MS = 30 * DAY_MS;
export const ONLINE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,15}$/;

export const LEADERBOARD_PAGE_SIZE = 10;
export const RECENT_DEFAULT_LIMIT = 5;
export const RECENT_MAX_LIMIT = 10;
export const PLATINUMS_DEFAULT_LIMIT = 5;
export const PLATINUMS_MAX_LIMIT = 10;
export const PLATINUMS_SCAN_TITLES = 200;
export const ALERT_TITLE_SCAN = 10;
export const MAX_ALERTS_PER_ACCOUNT = 3;
// Only platinums earned this recently are announced; older catch-up ones are recorded quietly.
export const ALERT_MAX_AGE_MS = 48 * HOUR_MS;

export const MAX_MILESTONES = 10;
export const RACE_MAX_DAYS = 90;
export const RACE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const TITLE_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const TITLE_SYNC_LIMIT = 20;
export const HISTORY_DAYS = 56;
export const ROLE_RECHECK_MS = 7 * DAY_MS;
export const MAX_ROLE_CHANGES_PER_GUILD = 8;
// Discord leaves a renewing subscription's `ends_at` empty, so an active one keeps the server
// on Platinum for a rolling week, extended by the hourly check and by every command.
export const ENTITLEMENT_GRACE_MS = 7 * DAY_MS;
export const ENTITLEMENT_SYNC_INTERVAL_MS = HOUR_MS;
// Server names for /admin are refreshed daily; servers unseen for 3 days are dropped.
export const DIRECTORY_SYNC_INTERVAL_MS = DAY_MS;
export const DIRECTORY_KEEP_MS = 3 * DAY_MS;

// Weekly posts go out Sundays 16:00 UTC; late runs may catch up for 48 hours.
export const WEEKLY_POST_DAY = 0;
export const WEEKLY_POST_HOUR_UTC = 16;
export const WEEKLY_CATCH_UP_MS = 48 * HOUR_MS;

// Discord must receive the first reply within 3 s; fall back to "thinking…" after this.
export const SYNC_REPLY_TIMEOUT_MS = 2200;
// waitUntil() work is cancelled 30 s after the reply; stop starting new work well before.
export const DEFERRED_WORK_BUDGET_MS = 22 * 1000;

function intSetting(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function getSettings(env = {}) {
  return {
    // Workers Free allows 50 subrequests (fetch + D1) per invocation. Stay under it.
    subrequestBudget: intSetting(env.SUBREQUEST_BUDGET, 45, { min: 10, max: 9000 }),
    // PSN's unofficial limit is ~300 requests / 15 min per account. Keep headroom.
    psnCallsPer15Min: intSetting(env.PSN_CALLS_PER_15_MIN, 240, { min: 10, max: 300 }),
    refreshPerRun: intSetting(env.REFRESH_PER_RUN, 25, { min: 1, max: 500 }),
    cacheTtlMs: intSetting(env.CACHE_TTL_HOURS, 6, { min: 1, max: 72 }) * HOUR_MS,
    maxLinksPerUser: intSetting(env.MAX_LINKS_PER_USER, 3, { min: 1, max: 25 }),
    // Moderators often link accounts for their whole community from one Discord account.
    maxLinksPerModerator: intSetting(env.MAX_LINKS_PER_MODERATOR, 50, { min: 1, max: 500 }),
    syncReplyTimeoutMs: intSetting(env.SYNC_REPLY_TIMEOUT_MS, SYNC_REPLY_TIMEOUT_MS, { min: 10, max: 2800 }),
    opsChannelId: String(env.OPS_CHANNEL_ID || DEFAULT_OPS_CHANNEL_ID),
    supportUrl: env.SUPPORT_URL,

    // Platinum (premium). Not tied to payments until PREMIUM_SKU_ID is set.
    premiumCacheTtlMs: intSetting(env.PREMIUM_CACHE_TTL_HOURS, 2, { min: 1, max: 24 }) * HOUR_MS,
    premiumLinksPerUser: intSetting(env.PREMIUM_LINKS_PER_USER, 6, { min: 1, max: 50 }),
    premiumLinksPerModerator: intSetting(env.PREMIUM_LINKS_PER_MODERATOR, 100, { min: 1, max: 1000 }),
    premiumGuildIds: listSetting(env.PREMIUM_GUILD_IDS),
    premiumSkuId: String(env.PREMIUM_SKU_ID || ""),
    ownerGuildId: String(env.OWNER_GUILD_ID || DEFAULT_OWNER_GUILD_ID),
    ownerUserIds: listSetting(env.OWNER_USER_IDS),
  };
}

function listSetting(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => /^\d{5,25}$/.test(item));
}
