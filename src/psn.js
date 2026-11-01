import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  NPSSO_EXPIRES_AT_MS,
  NPSSO_REMINDER_THRESHOLDS,
  PSN_ACCESS_TOKEN_REFRESH_GRACE_MS,
  PSN_AUTH_BASE_URL,
  PSN_AUTH_STATE_KEY,
  PSN_CLIENT_BASIC_AUTH,
  PSN_CLIENT_ID,
  PSN_LEGACY_PROFILE_BASE_URL,
  PSN_PROFILE_BASE_URL,
  PSN_REDIRECT_URI,
  PSN_SCOPE,
  PSN_SEARCH_URL,
  PSN_TROPHY_BASE_URL,
  PSN_USERNAME_CACHE_TTL_MS,
} from "./config.js";
import * as db from "./db.js";
import * as pdb from "./db-premium.js";
import { BudgetExceededError, mapLimit, nullableNumber, toNumber, utcDay } from "./runtime.js";

// codes: auth | not_found | private | rate_limited | unavailable | budget
export class PsnError extends Error {
  constructor(code, message, { status, retryAt } = {}) {
    super(message);
    this.name = "PsnError";
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
  }
}

const RATE_WINDOW_MS = 15 * MINUTE_MS;

// ---------------------------------------------------------------------------------------
// Auth. Each configured PSN account ("primary" from PSN_NPSSO, optional "backup" from
// PSN_NPSSO_BACKUP) keeps its own stored tokens and its own rate-limit window.

export function selectPsnAuthAction(record, now = Date.now()) {
  if (record?.access_token && Number(record.access_token_expires_at || 0) > now + PSN_ACCESS_TOKEN_REFRESH_GRACE_MS) {
    return "access";
  }

  if (record?.refresh_token && Number(record.refresh_token_expires_at || 0) > now) {
    return "refresh";
  }

  return "npsso";
}

export function buildPsnAuthRecord(tokens, now = Date.now(), key = PSN_AUTH_STATE_KEY) {
  return {
    key,
    access_token: tokens.accessToken || "",
    access_token_expires_at: now + Math.max(0, Number(tokens.expiresIn || 0)) * 1000,
    id_token: tokens.idToken || "",
    refresh_token: tokens.refreshToken || "",
    refresh_token_expires_at: now + Math.max(0, Number(tokens.refreshTokenExpiresIn || 0)) * 1000,
    scope: tokens.scope || "",
    token_type: tokens.tokenType || "",
    updated_at: now,
  };
}

export function getPsnAuthReminderDecision(storedAuth, now = Date.now(), npssoExpiresAt = NPSSO_EXPIRES_AT_MS) {
  const refreshExpiresAt = Number(storedAuth?.refresh_token_expires_at || 0);

  if (storedAuth?.refresh_token && refreshExpiresAt > 0) {
    return getReminderDecisionForExpiry("refresh", refreshExpiresAt, now);
  }

  return getReminderDecisionForExpiry("npsso", npssoExpiresAt, now);
}

function getReminderDecisionForExpiry(kind, expiresAt, now) {
  const daysRemaining = Math.ceil((expiresAt - now) / DAY_MS);
  let thresholdKey = "";

  if (daysRemaining <= 0) {
    thresholdKey = "expired";
  } else if (NPSSO_REMINDER_THRESHOLDS.includes(daysRemaining)) {
    thresholdKey = `${daysRemaining}d`;
  }

  if (!thresholdKey) {
    return null;
  }

  const expiresDate = new Date(expiresAt).toISOString().slice(0, 10);

  return {
    kind,
    key: `${kind}_${expiresDate}_${thresholdKey}`,
    daysRemaining,
    expiresAt,
  };
}

export function psnAccounts(env) {
  const accounts = [{ key: PSN_AUTH_STATE_KEY, npsso: env.PSN_NPSSO }];
  if (env.PSN_NPSSO_BACKUP) accounts.push({ key: "backup", npsso: env.PSN_NPSSO_BACKUP });
  return accounts;
}

// Tokens survive across requests within an isolate, saving a D1 read on warm requests.
const isolateTokens = new Map();

export function clearIsolateTokensForTests() {
  isolateTokens.clear();
}

function tokensFromRecord(record) {
  return {
    accessToken: record.access_token,
    expiresIn: Math.max(0, Math.floor((Number(record.access_token_expires_at || 0) - Date.now()) / 1000)),
    refreshToken: record.refresh_token,
    refreshTokenExpiresIn: Math.max(0, Math.floor((Number(record.refresh_token_expires_at || 0) - Date.now()) / 1000)),
  };
}

async function getAccountTokens(ctx, account) {
  const now = Date.now();
  const cached = isolateTokens.get(account.key);

  if (cached && cached.expiresAt > now + PSN_ACCESS_TOKEN_REFRESH_GRACE_MS) {
    return cached.tokens;
  }

  const stored = await db.getPsnAuthRecord(ctx, account.key);
  const action = selectPsnAuthAction(stored, now);

  if (action === "access") {
    isolateTokens.set(account.key, { tokens: tokensFromRecord(stored), expiresAt: Number(stored.access_token_expires_at) });
    return tokensFromRecord(stored);
  }

  if (action === "refresh") {
    try {
      const tokens = await exchangeRefreshToken(ctx, stored.refresh_token);
      await rememberTokens(ctx, account.key, tokens);
      return tokens;
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      console.warn(`PSN refresh failed for ${account.key}, trying NPSSO: ${err.message}`);
    }
  }

  if (!account.npsso) {
    throw new PsnError("auth", `PSN account "${account.key}" has no NPSSO configured`);
  }

  const code = await exchangeNpssoForCode(ctx, account.npsso);
  const tokens = await exchangeCodeForTokens(ctx, code);
  await rememberTokens(ctx, account.key, tokens);
  return tokens;
}

async function rememberTokens(ctx, key, tokens) {
  const record = buildPsnAuthRecord(tokens, Date.now(), key);
  await db.psnAuthStatement(ctx, record).run();
  isolateTokens.set(key, { tokens, expiresAt: record.access_token_expires_at });
}

async function postToken(ctx, body) {
  const res = await ctx.fetch(`${PSN_AUTH_BASE_URL}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: PSN_CLIENT_BASIC_AUTH,
    },
    body: new URLSearchParams(body).toString(),
  });

  if (!res.ok) {
    await res.text().catch(() => "");
    throw new PsnError("auth", `PSN token exchange failed: ${res.status}`, { status: res.status });
  }

  const raw = await res.json();

  if (!raw?.access_token || !raw?.refresh_token) {
    throw new PsnError("auth", "PSN token exchange returned incomplete tokens.");
  }

  return {
    accessToken: raw.access_token,
    expiresIn: raw.expires_in,
    idToken: raw.id_token,
    refreshToken: raw.refresh_token,
    refreshTokenExpiresIn: raw.refresh_token_expires_in,
    scope: raw.scope,
    tokenType: raw.token_type,
  };
}

function exchangeRefreshToken(ctx, refreshToken) {
  return postToken(ctx, {
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    token_format: "jwt",
    scope: PSN_SCOPE,
  });
}

function exchangeCodeForTokens(ctx, code) {
  return postToken(ctx, {
    code,
    redirect_uri: PSN_REDIRECT_URI,
    grant_type: "authorization_code",
    token_format: "jwt",
  });
}

async function exchangeNpssoForCode(ctx, npsso) {
  const query = new URLSearchParams({
    access_type: "offline",
    client_id: PSN_CLIENT_ID,
    redirect_uri: PSN_REDIRECT_URI,
    response_type: "code",
    scope: PSN_SCOPE,
  });

  const res = await ctx.fetch(`${PSN_AUTH_BASE_URL}/authorize?${query}`, {
    headers: { Cookie: `npsso=${npsso}` },
    redirect: "manual",
  });

  const location = res.headers.get("location") || "";
  await res.text().catch(() => "");
  const queryPart = location.includes("?") ? location.split("?")[1] : "";
  const code = new URLSearchParams(queryPart).get("code");

  if (!code) {
    throw new PsnError("auth", "Could not get a PSN access code. The NPSSO has probably expired.");
  }

  return code;
}

// Picks a working account with rate-limit headroom and reserves up to `wanted` calls.
// Returns the number of PSN calls this invocation may make (0 when every account is
// throttled). Throws PsnError("auth") when no account can log in.
export async function acquirePsn(ctx, wanted) {
  if (wanted <= 0) return 0;

  const session = ctx.memo.psn;
  if (session && session.allowance >= wanted) return session.allowance;

  const authErrors = [];
  ctx.memo.psnAuthErrors = authErrors;

  for (const account of psnAccounts(ctx.env)) {
    if (session && session.key !== account.key) continue;

    let tokens;
    try {
      tokens = session?.tokens || (await getAccountTokens(ctx, account));
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      authErrors.push({ key: account.key, message: err.message });
      continue;
    }

    const granted = await db.reserveRateLimit(ctx, {
      key: `psn:${account.key}`,
      wanted: wanted - (session?.allowance || 0),
      limit: ctx.settings.psnCallsPer15Min,
      windowMs: RATE_WINDOW_MS,
      now: Date.now(),
    });

    if (granted > 0 || session) {
      ctx.memo.psn = { key: account.key, tokens, allowance: (session?.allowance || 0) + granted };
      return ctx.memo.psn.allowance;
    }
  }

  if (!session && authErrors.length === psnAccounts(ctx.env).length) {
    throw new PsnError("auth", authErrors.map((e) => `${e.key}: ${e.message}`).join("; "));
  }

  return session?.allowance || 0;
}

export function psnAllowance(ctx) {
  return ctx.memo.psn?.allowance || 0;
}

async function psnRequest(ctx, url, init = {}) {
  const session = ctx.memo.psn;

  if (!session || session.allowance <= 0) {
    throw new PsnError("budget", "No PSN calls left for this request");
  }

  session.allowance -= 1;
  let res;

  try {
    res = await ctx.fetch(url, {
      method: init.method || "GET",
      headers: {
        Authorization: `Bearer ${session.tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: init.body,
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    throw new PsnError("unavailable", `PSN request failed: ${err.message}`);
  }

  if (res.ok) {
    return res.json();
  }

  await res.text().catch(() => "");

  if (res.status === 401) {
    isolateTokens.delete(session.key);
    session.allowance = 0;
    ctx.memo.psn = null; // the next acquirePsn() logs in again instead of reusing this token
    try {
      await db.expireAccessTokenStatement(ctx, session.key).run();
    } catch {
      // Best effort: the token will be refreshed on expiry anyway.
    }
    throw new PsnError("auth", "PSN rejected the access token", { status: 401 });
  }

  if (res.status === 403) throw new PsnError("private", "PSN profile or trophies are private", { status: 403 });
  if (res.status === 404) throw new PsnError("not_found", "PSN account not found", { status: 404 });

  if (res.status === 429) {
    const header = Number(res.headers.get("X-RateLimit-Next-Available") || 0);
    const retryAt = header > 1e12 ? header : header > 0 ? header * 1000 : Date.now() + RATE_WINDOW_MS;
    session.allowance = 0;
    ctx.memo.psn = null; // lets a backup account take over in the same request
    try {
      await db.rateLimitCooldownStatement(ctx, { key: `psn:${session.key}`, until: retryAt }).run();
    } catch {
      // Best effort.
    }
    throw new PsnError("rate_limited", "PSN rate limit reached", { status: 429, retryAt });
  }

  throw new PsnError("unavailable", `PSN request failed: ${res.status}`, { status: res.status });
}

// ---------------------------------------------------------------------------------------
// PSN endpoints. Each call costs one subrequest and one unit of PSN allowance.

export async function fetchTrophySummary(ctx, accountId) {
  const summary = await psnRequest(ctx, `${PSN_TROPHY_BASE_URL}/users/${encodeURIComponent(accountId)}/trophySummary`);
  return statsFromSummary(summary);
}

export function statsFromSummary(summary) {
  const earned = summary?.earnedTrophies || {};
  const platinum = toNumber(earned.platinum);
  const gold = toNumber(earned.gold);
  const silver = toNumber(earned.silver);
  const bronze = toNumber(earned.bronze);

  return {
    trophyLevel: nullableNumber(summary?.trophyLevel),
    progress: nullableNumber(summary?.progress),
    tier: nullableNumber(summary?.tier),
    platinum,
    gold,
    silver,
    bronze,
    total: platinum + gold + silver + bronze,
  };
}

// Game list, most recently updated first.
export async function fetchTitles(ctx, accountId, { limit, offset = 0 }) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (offset) query.set("offset", String(offset));
  const response = await psnRequest(ctx, `${PSN_TROPHY_BASE_URL}/users/${encodeURIComponent(accountId)}/trophyTitles?${query}`);
  return {
    titles: (response?.trophyTitles || []).map((title) => normalizeTitle(accountId, title)),
    totalItemCount: toNumber(response?.totalItemCount),
  };
}

export function normalizeTitle(psnId, title, psnUsername = "") {
  const earned = title?.earnedTrophies || {};
  const defined = title?.definedTrophies || {};
  const platinum = toNumber(earned.platinum);
  const gold = toNumber(earned.gold);
  const silver = toNumber(earned.silver);
  const bronze = toNumber(earned.bronze);
  const npCommunicationId = title?.npCommunicationId || "unknown";

  return {
    id: `${psnId}:${npCommunicationId}`,
    psnId,
    psnUsername,
    npCommunicationId,
    npServiceName: title?.npServiceName || "",
    titleName: title?.trophyTitleName || "Unknown game",
    titleIconUrl: title?.trophyTitleIconUrl || "",
    platform: title?.trophyTitlePlatform || "",
    progress: toNumber(title?.progress),
    platinum,
    gold,
    silver,
    bronze,
    total: platinum + gold + silver + bronze,
    definedTotal: toNumber(defined.platinum) + toNumber(defined.gold) + toNumber(defined.silver) + toNumber(defined.bronze),
    hasPlatinum: toNumber(defined.platinum) > 0,
    lastUpdatedAt: title?.lastUpdatedDateTime || "",
  };
}

// One player's progress in one game. Returns null when they have never played it.
export async function fetchTitleEarnings(ctx, accountId, npCommunicationId, npServiceName) {
  const query = new URLSearchParams({ npServiceName: npServiceName || "trophy2" });
  try {
    const response = await psnRequest(
      ctx,
      `${PSN_TROPHY_BASE_URL}/users/${encodeURIComponent(accountId)}/npCommunicationIds/${encodeURIComponent(npCommunicationId)}/trophyGroups?${query}`
    );
    const earned = response?.earnedTrophies || {};
    const counts = ["platinum", "gold", "silver", "bronze"].map((key) => toNumber(earned[key]));
    return {
      progress: toNumber(response?.progress),
      platinum: counts[0],
      earnedTotal: counts.reduce((sum, value) => sum + value, 0),
      lastUpdatedAt: response?.lastUpdatedDateTime || "",
    };
  } catch (err) {
    if (err instanceof PsnError && err.code === "not_found") return null;
    throw err;
  }
}

// Share of players who earned this game's platinum (e.g. 2.3 for 2.3%), or null.
export async function fetchPlatinumRarity(ctx, accountId, npCommunicationId, npServiceName) {
  const query = new URLSearchParams({ npServiceName: npServiceName || "trophy2" });
  const response = await psnRequest(
    ctx,
    `${PSN_TROPHY_BASE_URL}/users/${encodeURIComponent(accountId)}/npCommunicationIds/${encodeURIComponent(npCommunicationId)}/trophyGroups/all/trophies?${query}`
  );
  const platinum = (response?.trophies || []).find((trophy) => trophy.trophyType === "platinum");
  const rate = Number.parseFloat(platinum?.trophyEarnedRate);
  return Number.isFinite(rate) ? rate : null;
}

export async function fetchProfile(ctx, accountId) {
  const profile = await psnRequest(ctx, `${PSN_PROFILE_BASE_URL}/${encodeURIComponent(accountId)}/profiles`);
  return {
    onlineId: profile?.onlineId || "",
    avatarUrl: pickAvatar(profile?.avatars, "url"),
    isPlus: profile?.isPlus === undefined ? null : Boolean(profile.isPlus),
  };
}

function pickAvatar(avatars, field) {
  if (!Array.isArray(avatars) || avatars.length === 0) return null;
  const order = ["xl", "l", "m", "s"];
  const sorted = [...avatars].sort((a, b) => order.indexOf(String(a?.size).toLowerCase()) - order.indexOf(String(b?.size).toLowerCase()));
  return sorted.find((avatar) => avatar?.[field])?.[field] || null;
}

// Exact Online ID lookup. Returns null when the account does not exist.
async function lookupOnlineId(ctx, onlineId) {
  const fields = "accountId,onlineId,avatarUrls,plus";
  try {
    const response = await psnRequest(
      ctx,
      `${PSN_LEGACY_PROFILE_BASE_URL}/${encodeURIComponent(onlineId)}/profile2?${new URLSearchParams({ fields })}`
    );
    const profile = response?.profile;
    if (!profile?.accountId) return null;
    return {
      psnId: String(profile.accountId),
      onlineId: profile.onlineId || onlineId,
      avatarUrl: pickAvatar(profile.avatarUrls, "avatarUrl"),
      isPlus: profile.plus === undefined ? null : Boolean(profile.plus),
    };
  } catch (err) {
    if (err instanceof PsnError && err.code === "not_found") return null;
    throw err;
  }
}

async function searchOnlineId(ctx, term) {
  const response = await psnRequest(ctx, PSN_SEARCH_URL, {
    method: "POST",
    body: JSON.stringify({ searchTerm: term, domainRequests: [{ domain: "SocialAllAccounts" }] }),
  });

  const results = response?.domainResponses?.find((item) => item.domain === "SocialAllAccounts")?.results || [];
  const accounts = results
    .map((result) => result?.socialMetadata)
    .filter((meta) => meta?.accountId && meta?.onlineId)
    .map((meta) => ({
      psnId: String(meta.accountId),
      onlineId: meta.onlineId,
      avatarUrl: meta.avatarUrl || null,
      isPlus: meta.isPsPlus === undefined ? null : Boolean(meta.isPsPlus),
    }));

  return {
    exact: accounts.find((account) => account.onlineId.toLowerCase() === term.toLowerCase()) || null,
    suggestions: accounts.slice(0, 5).map((account) => account.onlineId),
  };
}

// Resolves an Online ID to an account. Never guesses: a fuzzy match is only offered as a
// suggestion. Uses the username cache first so repeat lookups cost no PSN calls.
export async function resolveAccount(ctx, onlineId, { allowPsn = true } = {}) {
  const normalized = onlineId.toLowerCase();
  const cached = await db.getUsernameCache(ctx, normalized);

  if (cached && Date.now() - toNumber(cached.fetched_at) < PSN_USERNAME_CACHE_TTL_MS) {
    return { found: true, psnId: String(cached.psn_id), onlineId: cached.psn_username, avatarUrl: null, isPlus: null, fromCache: true };
  }

  if (!allowPsn) return { found: false, suggestions: [] };

  let lookupFailed = false;
  try {
    const exact = await lookupOnlineId(ctx, onlineId);
    if (exact) return { found: true, ...exact };
  } catch (err) {
    if (!(err instanceof PsnError) || !["unavailable", "private"].includes(err.code)) throw err;
    lookupFailed = true;
  }

  if (psnAllowance(ctx) <= 0) {
    if (lookupFailed) throw new PsnError("unavailable", "PSN lookup failed");
    return { found: false, suggestions: [] };
  }

  const search = await searchOnlineId(ctx, onlineId);
  if (search.exact) return { found: true, ...search.exact };
  return { found: false, suggestions: search.suggestions };
}

// ---------------------------------------------------------------------------------------
// Refreshing cached trophy summaries (used by the cron job, /profile and leaderboard top-ups).

function backoffFor(error, failCount, now) {
  if (error.code === "private") return now + 12 * HOUR_MS;
  if (error.code === "not_found") return now + DAY_MS;
  return now + Math.min(6 * HOUR_MS, 30 * MINUTE_MS * 2 ** Math.min(failCount, 4));
}

// Refreshes as many of `accounts` as the PSN allowance permits, writing all results in one
// batch. Stops early on auth/rate-limit/budget problems without penalising accounts.
export async function refreshAccounts(ctx, accounts, { now = Date.now(), concurrency = 6 } = {}) {
  const usable = accounts.slice(0, psnAllowance(ctx));
  const results = await mapLimit(usable, concurrency, (account) => fetchTrophySummary(ctx, account.psn_id));
  const statements = [];
  const refreshed = [];
  let stopError = null;

  results.forEach((result, index) => {
    const account = usable[index];

    if (result.ok) {
      // Accounts linked in a Platinum server refresh more often and keep a daily history.
      const premium = Number(account.is_premium || 0) === 1;
      const ttl = premium ? ctx.settings.premiumCacheTtlMs : ctx.settings.cacheTtlMs;
      const jitter = Math.floor(Math.random() * 0.1 * ttl);
      statements.push(
        db.statsStatement(ctx, {
          psnId: account.psn_id,
          name: account.psn_username,
          stats: result.value,
          now,
          nextRefreshAt: now + ttl + jitter,
        })
      );
      if (premium) statements.push(pdb.historyStatement(ctx, { psnId: account.psn_id, day: utcDay(now), stats: result.value }));
      refreshed.push({ ...account, stats: result.value });
      return;
    }

    const error = result.error;

    if (error instanceof PsnError && ["private", "not_found", "unavailable"].includes(error.code)) {
      statements.push(
        db.refreshFailureStatement(ctx, {
          psnId: account.psn_id,
          error: error.code,
          nextRefreshAt: backoffFor(error, toNumber(account.fail_count), now),
        })
      );
      return;
    }

    stopError = stopError || error;
  });

  if (statements.length > 0) {
    await ctx.db.batch(statements, { reserved: true });
  }

  return { refreshed, stopError };
}
