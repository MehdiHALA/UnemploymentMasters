import nacl from "tweetnacl";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const PSN_AUTH_BASE_URL = "https://ca.account.sony.com/api/authz/v3/oauth";
const PSN_SEARCH_BASE_URL = "https://m.np.playstation.com/api/search";
const PSN_TROPHY_BASE_URL = "https://m.np.playstation.com/api/trophy";

const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
};

const InteractionResponseType = {
  PONG: 1,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
};

const CommandOptionType = {
  STRING: 3,
};

export const commands = [
  {
    name: "addpsn",
    description: "Add your PSN username",
    type: 1,
    options: [
      {
        name: "username",
        description: "Your PSN username",
        type: CommandOptionType.STRING,
        required: true,
      },
    ],
  },
  {
    name: "removepsn",
    description: "Remove your PSN username",
    type: 1,
    options: [
      {
        name: "username",
        description: "Your PSN username to remove",
        type: CommandOptionType.STRING,
        required: true,
      },
    ],
  },
  {
    name: "leaderboard",
    description: "Show PSN platinum leaderboard",
    type: 1,
  },
];

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return json({ ok: true, service: "psn-trophy-bot" });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.text();
    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");

    if (!env.DISCORD_PUBLIC_KEY || !verifyDiscordRequest(body, signature, timestamp, env.DISCORD_PUBLIC_KEY)) {
      return new Response("invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(body);

    if (interaction.type === InteractionType.PING) {
      return json({ type: InteractionResponseType.PONG });
    }

    if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
      return json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      });
    }

    ctx.waitUntil(handleCommand(interaction, env));

    return json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });
  },
};

async function handleCommand(interaction, env) {
  try {
    await ensureDatabase(env.DB);

    if (!interaction.guild_id) {
      await editOriginalResponse(interaction, "Use this command inside a server.");
      return;
    }

    const commandName = interaction.data?.name;

    if (commandName === "addpsn") {
      await addPsn(interaction, env);
      return;
    }

    if (commandName === "removepsn") {
      await removePsn(interaction, env);
      return;
    }

    if (commandName === "leaderboard") {
      await leaderboard(interaction, env);
      return;
    }

    await editOriginalResponse(interaction, "Unknown command.");
  } catch (err) {
    console.error("Command failed:", err);
    await editOriginalResponse(interaction, "Something went wrong while handling that command.");
  }
}

async function addPsn(interaction, env) {
  const psnUsername = getStringOption(interaction, "username");

  if (!psnUsername) {
    await editOriginalResponse(interaction, "Please provide a PSN username.");
    return;
  }

  const tokens = await getPsnTokens(env.PSN_NPSSO);
  const psnId = await findPsnAccountId(tokens, psnUsername);

  if (!psnId) {
    await editOriginalResponse(interaction, "Could not find your PSN account.");
    return;
  }

  const guildId = interaction.guild_id;
  const discordId = interaction.member?.user?.id || interaction.user?.id;
  const id = `${guildId}:${discordId}:${psnUsername.toLowerCase()}`;

  await env.DB.prepare(
    `INSERT INTO psn_users (id, discord_id, guild_id, psn_username, psn_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET psn_username = excluded.psn_username, psn_id = excluded.psn_id`
  )
    .bind(id, discordId, guildId, psnUsername, psnId)
    .run();

  await editOriginalResponse(interaction, `PSN user **${psnUsername}** saved!`);
}

async function removePsn(interaction, env) {
  const psnUsername = getStringOption(interaction, "username");

  if (!psnUsername) {
    await editOriginalResponse(interaction, "Please provide a PSN username.");
    return;
  }

  const guildId = interaction.guild_id;
  const discordId = interaction.member?.user?.id || interaction.user?.id;
  const id = `${guildId}:${discordId}:${psnUsername.toLowerCase()}`;

  const existing = await env.DB.prepare("SELECT id FROM psn_users WHERE id = ? AND guild_id = ?")
    .bind(id, guildId)
    .first();

  if (!existing) {
    await editOriginalResponse(interaction, "No matching PSN username found in this server.");
    return;
  }

  await env.DB.prepare("DELETE FROM psn_users WHERE id = ? AND guild_id = ?").bind(id, guildId).run();
  await editOriginalResponse(interaction, `PSN username **${psnUsername}** removed from this server.`);
}

async function leaderboard(interaction, env) {
  const guildId = interaction.guild_id;
  const tokens = await getPsnTokens(env.PSN_NPSSO);
  const { results: rows } = await env.DB.prepare("SELECT * FROM psn_users WHERE guild_id = ?")
    .bind(guildId)
    .all();

  const results = [];

  for (const row of rows || []) {
    try {
      const summary = await getUserTrophyProfileSummary(tokens, row.psn_id);
      const earned = summary.earnedTrophies || {};

      results.push({
        username: row.psn_username,
        platinum: earned.platinum || 0,
        gold: earned.gold || 0,
        silver: earned.silver || 0,
        bronze: earned.bronze || 0,
      });
    } catch (err) {
      console.warn(`Failed to fetch trophy summary for ${row.id}: ${err.message}`);
    }
  }

  if (results.length === 0) {
    await editOriginalResponse(interaction, "No data found for this server.");
    return;
  }

  results.sort(
    (a, b) =>
      b.platinum - a.platinum ||
      b.gold - a.gold ||
      b.silver - a.silver ||
      b.bronze - a.bronze
  );

  const message = results
    .map(
      (user, index) =>
        `${index + 1}. **${user.username}** - Platinum ${user.platinum} | Gold ${user.gold} | Silver ${user.silver} | Bronze ${user.bronze}`
    )
    .join("\n");

  await editOriginalResponse(interaction, `**PSN Trophy Leaderboard** (This Server)\n${message}`);
}

async function ensureDatabase(db) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS psn_users (
        id TEXT PRIMARY KEY,
        discord_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        psn_username TEXT NOT NULL,
        psn_id TEXT NOT NULL
      )`
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_psn_users_guild_id ON psn_users (guild_id)"),
  ]);
}

async function getPsnTokens(npsso) {
  if (!npsso) {
    throw new Error("Missing PSN_NPSSO");
  }

  const code = await exchangeNpssoForAccessCode(npsso);
  return exchangeAccessCodeForAuthTokens(code);
}

async function exchangeNpssoForAccessCode(npsso) {
  const queryString = new URLSearchParams({
    access_type: "offline",
    client_id: "09515159-7237-4370-9b40-3806e67c0891",
    redirect_uri: "com.scee.psxandroid.scecompcall://redirect",
    response_type: "code",
    scope: "psn:mobile.v2.core psn:clientapp",
  }).toString();

  const res = await fetch(`${PSN_AUTH_BASE_URL}/authorize?${queryString}`, {
    headers: { Cookie: `npsso=${npsso}` },
    redirect: "manual",
  });

  const location = res.headers.get("location");

  if (!location || !location.includes("?code=")) {
    throw new Error("Could not retrieve PSN access code. Refresh PSN_NPSSO.");
  }

  return new URLSearchParams(location.split("redirect/")[1]).get("code");
}

async function exchangeAccessCodeForAuthTokens(accessCode) {
  const res = await fetch(`${PSN_AUTH_BASE_URL}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=",
    },
    body: new URLSearchParams({
      code: accessCode,
      redirect_uri: "com.scee.psxandroid.scecompcall://redirect",
      grant_type: "authorization_code",
      token_format: "jwt",
    }).toString(),
  });

  if (!res.ok) {
    throw new Error(`PSN token exchange failed: ${res.status}`);
  }

  const raw = await res.json();

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

async function findPsnAccountId(tokens, username) {
  const response = await psnFetch(
    `${PSN_SEARCH_BASE_URL}/v1/universalSearch`,
    tokens,
    {
      method: "POST",
      body: JSON.stringify({
        searchTerm: username,
        domainRequests: [{ domain: "SocialAllAccounts" }],
      }),
    }
  );

  return response?.domainResponses
    ?.find((item) => item.domain === "SocialAllAccounts")
    ?.results?.[0]?.socialMetadata?.accountId;
}

async function getUserTrophyProfileSummary(tokens, accountId) {
  return psnFetch(`${PSN_TROPHY_BASE_URL}/v1/users/${accountId}/trophySummary`, tokens);
}

async function psnFetch(url, tokens, options = {}) {
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body,
  });

  if (!res.ok) {
    throw new Error(`PSN request failed: ${res.status}`);
  }

  return res.json();
}

async function editOriginalResponse(interaction, content) {
  const res = await fetch(
    `${DISCORD_API_BASE_URL}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: truncateDiscordMessage(content) }),
    }
  );

  if (!res.ok) {
    console.error(`Failed to edit Discord response: ${res.status}`);
  }
}

function getStringOption(interaction, name) {
  return interaction.data?.options?.find((option) => option.name === name)?.value?.trim();
}

function verifyDiscordRequest(body, signature, timestamp, publicKey) {
  if (!signature || !timestamp || !publicKey) return false;

  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(timestamp + body),
      hexToUint8Array(signature),
      hexToUint8Array(publicKey)
    );
  } catch {
    return false;
  }
}

function hexToUint8Array(hex) {
  const matches = hex.match(/.{1,2}/g) || [];
  return new Uint8Array(matches.map((byte) => Number.parseInt(byte, 16)));
}

function truncateDiscordMessage(message) {
  return message.length <= 1900 ? message : `${message.slice(0, 1897)}...`;
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}
