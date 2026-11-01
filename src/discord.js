import { DISCORD_API_BASE_URL } from "./config.js";
import { textOnlyFallback } from "./ui.js";

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  AUTOCOMPLETE: 4,
};

export const ResponseType = {
  PONG: 1,
  MESSAGE: 4,
  DEFERRED_MESSAGE: 5,
  DEFERRED_UPDATE: 6,
  UPDATE: 7,
  AUTOCOMPLETE: 8,
};

export const MessageFlags = {
  EPHEMERAL: 1 << 6,
  COMPONENTS_V2: 1 << 15,
};

export const OptionType = {
  SUB_COMMAND: 1,
  SUB_COMMAND_GROUP: 2,
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
  USER: 6,
  CHANNEL: 7,
  ROLE: 8,
};

const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

// ---------------------------------------------------------------------------------------
// Request verification with the runtime's built-in Ed25519 (~0.15 ms of CPU, versus ~5.6 ms
// for the pure-JS tweetnacl it replaces — the Free plan only allows 10 ms per request).

const keyCache = new Map();

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error("invalid hex");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function importPublicKey(publicKeyHex) {
  if (!keyCache.has(publicKeyHex)) {
    const raw = hexToBytes(publicKeyHex);
    const imported = crypto.subtle
      .importKey("raw", raw, { name: "Ed25519" }, false, ["verify"])
      .then((key) => ({ key, algorithm: { name: "Ed25519" } }))
      .catch(() =>
        crypto.subtle
          .importKey("raw", raw, { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }, false, ["verify"])
          .then((key) => ({ key, algorithm: { name: "NODE-ED25519" } }))
      );
    keyCache.set(publicKeyHex, imported);
  }
  return keyCache.get(publicKeyHex);
}

export async function verifyDiscordRequest(body, signature, timestamp, publicKey) {
  if (!signature || !timestamp || !publicKey) return false;

  try {
    const { key, algorithm } = await importPublicKey(publicKey);
    return await crypto.subtle.verify(algorithm, key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    keyCache.delete(publicKey);
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Interaction helpers.

export function getUserId(interaction) {
  return interaction.member?.user?.id || interaction.user?.id || null;
}

export function getSubcommandGroup(interaction) {
  return interaction.data?.options?.find((option) => option.type === OptionType.SUB_COMMAND_GROUP) || null;
}

export function getSubcommand(interaction) {
  const list = getSubcommandGroup(interaction)?.options || interaction.data?.options;
  return list?.find((option) => option.type === OptionType.SUB_COMMAND) || null;
}

function getOptions(interaction) {
  return getSubcommand(interaction)?.options || interaction.data?.options || [];
}

export function getOption(interaction, name) {
  return getOptions(interaction).find((option) => option.name === name)?.value;
}

export function getStringOption(interaction, name) {
  const value = getOption(interaction, name);
  return typeof value === "string" ? value.trim() : "";
}

export function getIntegerOption(interaction, name) {
  const value = Number(getOption(interaction, name));
  return Number.isInteger(value) ? value : null;
}

export function getFocusedOption(interaction) {
  return getOptions(interaction).find((option) => option.focused) || null;
}

export function hasManageGuild(interaction) {
  try {
    const permissions = BigInt(interaction.member?.permissions || 0);
    return (permissions & MANAGE_GUILD) === MANAGE_GUILD || (permissions & ADMINISTRATOR) === ADMINISTRATOR;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Responses.

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function interactionResponse(type, data) {
  return jsonResponse(data === undefined ? { type } : { type, data });
}

// ---------------------------------------------------------------------------------------
// REST. The interaction reply edit uses the budget reserve so it can always be sent, and
// retries with a text-only version if Discord rejects the rich layout — a user should
// never be left looking at "thinking…".

function webhookUrl(interaction) {
  return `${DISCORD_API_BASE_URL}/webhooks/${interaction.application_id}/${interaction.token}`;
}

async function sendWithFallback(ctx, url, method, payload, transform = (body) => body) {
  for (const body of [payload, textOnlyFallback(payload)]) {
    let res;
    try {
      res = await ctx.fetch(
        url,
        { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(transform(body)) },
        { reserved: true }
      );
    } catch (err) {
      console.error(`Discord ${method} failed: ${err.message}`);
      return false;
    }

    if (res.ok) {
      await res.text().catch(() => "");
      return true;
    }

    const detail = await res.text().catch(() => "");
    console.error(`Discord ${method} failed: ${res.status} ${detail.slice(0, 500)}`);
    if (res.status !== 400) return false;
  }

  return false;
}

// Edits may only set IS_COMPONENTS_V2 / SUPPRESS_EMBEDS, so the ephemeral bit is dropped.
export function editOriginal(ctx, interaction, payload) {
  return sendWithFallback(ctx, `${webhookUrl(interaction)}/messages/@original`, "PATCH", payload, (body) => ({
    ...body,
    flags: Number(body.flags || 0) & ~MessageFlags.EPHEMERAL,
  }));
}

export function sendFollowup(ctx, interaction, payload) {
  return sendWithFallback(ctx, webhookUrl(interaction), "POST", payload);
}

// Swaps a public "thinking…" placeholder for a message only the user can see (for errors).
export async function replaceWithEphemeral(ctx, interaction, payload) {
  try {
    const res = await ctx.fetch(`${webhookUrl(interaction)}/messages/@original`, { method: "DELETE" }, { reserved: true });
    await res.text().catch(() => "");
    if (!res.ok && res.status !== 404) return false;
  } catch {
    return false;
  }

  return sendFollowup(ctx, interaction, { ...payload, flags: Number(payload.flags || 0) | MessageFlags.EPHEMERAL });
}

// ---------------------------------------------------------------------------------------
// Bot-token REST calls (the token never leaves Cloudflare).

async function botRequest(ctx, method, path, body) {
  if (!ctx.env.DISCORD_BOT_TOKEN) return { ok: false, status: 0, error: "missing_bot_token" };
  const res = await ctx.fetch(`${DISCORD_API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${ctx.env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      "X-Audit-Log-Reason": "PSN Trophy Bot",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) return { ok: true, status: res.status, data };
  return { ok: false, status: res.status, error: classifyChannelError(res.status, text), detail: text.slice(0, 300) };
}

export function getApplication(ctx) {
  return botRequest(ctx, "GET", "/applications/@me");
}

export function putCommands(ctx, applicationId, commands, guildId = null) {
  const path = guildId ? `/applications/${applicationId}/guilds/${guildId}/commands` : `/applications/${applicationId}/commands`;
  return botRequest(ctx, "PUT", path, commands);
}

export function getGuild(ctx, guildId) {
  return botRequest(ctx, "GET", `/guilds/${guildId}`);
}

// Servers the bot is in, 200 per page (pass the last id as `after`), with member counts.
export function listBotGuilds(ctx, after = null) {
  const query = new URLSearchParams({ limit: "200", with_counts: "true" });
  if (after) query.set("after", after);
  return botRequest(ctx, "GET", `/users/@me/guilds?${query}`);
}

// Active purchases of one SKU, oldest first, 100 per page (pass the last id as `after`).
export function listEntitlements(ctx, applicationId, skuId, after = null) {
  const query = new URLSearchParams({ sku_ids: skuId, exclude_ended: "true", exclude_deleted: "true", limit: "100" });
  if (after) query.set("after", after);
  return botRequest(ctx, "GET", `/applications/${applicationId}/entitlements?${query}`);
}

export function setMemberRole(ctx, { guildId, userId, roleId, add }) {
  return botRequest(ctx, add ? "PUT" : "DELETE", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
}

// Replaces the "thinking…" reply with a message that carries a file (e.g. a CSV export).
export async function editOriginalWithFile(ctx, interaction, { content, filename, data, type = "text/csv" }) {
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({ content, attachments: [{ id: 0, filename }], allowed_mentions: { parse: [] }, components: [] })
  );
  form.append("files[0]", new Blob([data], { type }), filename);
  try {
    const res = await ctx.fetch(`${webhookUrl(interaction)}/messages/@original`, { method: "PATCH", body: form }, { reserved: true });
    await res.text().catch(() => "");
    return res.ok;
  } catch (err) {
    console.error(`Discord file upload failed: ${err.message}`);
    return false;
  }
}

function classifyChannelError(status, detail) {
  if (status === 404 || /"code":\s*10003\b/.test(detail)) return "unknown_channel";
  if (status === 403 || /"code":\s*(50001|50013)\b/.test(detail)) return "missing_access";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "discord_unavailable";
  return "bad_request";
}

export async function postChannelMessage(ctx, channelId, payload) {
  if (!ctx.env.DISCORD_BOT_TOKEN) {
    return { ok: false, status: 0, error: "missing_bot_token" };
  }

  for (const body of [payload, textOnlyFallback(payload)]) {
    const res = await ctx.fetch(`${DISCORD_API_BASE_URL}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${ctx.env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      await res.text().catch(() => "");
      return { ok: true, status: res.status };
    }

    const detail = await res.text().catch(() => "");
    console.warn(`Discord channel post failed: ${res.status} ${detail.slice(0, 300)}`);
    if (res.status !== 400) {
      return { ok: false, status: res.status, error: classifyChannelError(res.status, detail) };
    }
  }

  return { ok: false, status: 400, error: "bad_request" };
}
