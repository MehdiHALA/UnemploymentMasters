import { DEFERRED_WORK_BUDGET_MS } from "./config.js";
import { autocompleteHandlers, componentHandlers, handlers, normalizeSupportUrl } from "./commands.js";
import { premiumAutocompleteHandlers, premiumComponentHandlers, premiumHandlers } from "./premium-commands.js";
import { loadGuildContext } from "./premium.js";
import { ensureSchema } from "./db.js";
import {
  editOriginal,
  editOriginalWithFile,
  interactionResponse,
  InteractionType,
  jsonResponse,
  MessageFlags,
  replaceWithEphemeral,
  ResponseType,
  sendFollowup,
  verifyDiscordRequest,
} from "./discord.js";
import { runScheduled } from "./jobs.js";
import { PsnError } from "./psn.js";
import { BudgetExceededError, createContext, logEvent, sleep, UserError } from "./runtime.js";
import { createTheme, noticeView, supportView } from "./ui.js";

export { commands } from "./commands.js";
export { buildPsnAuthRecord, getPsnAuthReminderDecision, selectPsnAuthAction } from "./psn.js";

export function buildSupportPayload({ supportUrl } = {}) {
  return supportView({ supportUrl: normalizeSupportUrl(supportUrl) });
}

const TIMED_OUT = Symbol("timed-out");

export default {
  async fetch(request, env, executionCtx) {
    if (request.method === "GET") {
      return jsonResponse({ ok: true, service: "psn-trophy-bot" });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.text();
    const valid = await verifyDiscordRequest(
      body,
      request.headers.get("X-Signature-Ed25519"),
      request.headers.get("X-Signature-Timestamp"),
      env.DISCORD_PUBLIC_KEY
    );

    if (!valid) {
      return new Response("invalid request signature", { status: 401 });
    }

    let interaction;
    try {
      interaction = JSON.parse(body);
    } catch {
      return new Response("invalid JSON", { status: 400 });
    }

    switch (interaction.type) {
      case InteractionType.PING:
        return interactionResponse(ResponseType.PONG);
      case InteractionType.APPLICATION_COMMAND:
        return handleCommand(interaction, env, executionCtx);
      case InteractionType.MESSAGE_COMPONENT:
        return handleComponent(interaction, env, executionCtx);
      case InteractionType.AUTOCOMPLETE:
        return handleAutocomplete(interaction, env);
      default:
        return interactionResponse(ResponseType.MESSAGE, noticeView({ tone: "info", title: "That isn't supported yet" }));
    }
  },

  async scheduled(event, env, executionCtx) {
    executionCtx.waitUntil(runScheduled(env, event));
  },
};

function interactionContext(env) {
  const ctx = createContext(env, { workBudgetMs: DEFERRED_WORK_BUDGET_MS });
  ctx.theme = createTheme(env);
  return ctx;
}

function handleCommand(interaction, env, executionCtx) {
  if (!interaction.guild_id) {
    return interactionResponse(
      ResponseType.MESSAGE,
      noticeView({ tone: "info", title: "Use this inside a server", body: "Leaderboards are per server, so commands only work there." })
    );
  }

  const handler = handlers[interaction.data?.name] || premiumHandlers[interaction.data?.name];

  if (!handler) {
    return interactionResponse(ResponseType.MESSAGE, noticeView({ tone: "warning", title: "Unknown command", body: "Try again in a minute." }));
  }

  const ctx = interactionContext(env);

  if (handler.mode === "defer") {
    executionCtx.waitUntil(
      execute(ctx, interaction, handler).then((result) =>
        finish(ctx, interaction, result, { deferType: ResponseType.DEFERRED_MESSAGE, publicDefer: !handler.ephemeral })
      )
    );
    return interactionResponse(ResponseType.DEFERRED_MESSAGE, handler.ephemeral ? { flags: MessageFlags.EPHEMERAL } : undefined);
  }

  return respondFast(ctx, interaction, handler, executionCtx, {
    replyType: ResponseType.MESSAGE,
    deferType: ResponseType.DEFERRED_MESSAGE,
    deferEphemeral: Boolean(handler.ephemeral),
  });
}

function handleComponent(interaction, env, executionCtx) {
  const [namespace, action = "", arg = ""] = String(interaction.data?.custom_id || "").split(":");
  const handler = componentHandlers[namespace] || premiumComponentHandlers[namespace];

  if (!handler || !interaction.guild_id) {
    return interactionResponse(ResponseType.MESSAGE, noticeView({ tone: "info", title: "This button has expired", body: "Run the command again." }));
  }

  const ctx = interactionContext(env);
  const args = { action, arg };

  return respondFast(
    ctx,
    interaction,
    handler,
    executionCtx,
    handler.responseFor(action) === "reply"
      ? { replyType: ResponseType.MESSAGE, deferType: ResponseType.DEFERRED_MESSAGE, deferEphemeral: true, args }
      : { replyType: ResponseType.UPDATE, deferType: ResponseType.DEFERRED_UPDATE, args }
  );
}

async function handleAutocomplete(interaction, env) {
  const handler = autocompleteHandlers[interaction.data?.name] || premiumAutocompleteHandlers[interaction.data?.name];

  if (!handler || !interaction.guild_id) {
    return interactionResponse(ResponseType.AUTOCOMPLETE, { choices: [] });
  }

  const ctx = interactionContext(env);

  try {
    const work = ensureSchema(ctx).then(() => handler(ctx, interaction));
    const choices = await Promise.race([work, sleep(ctx.settings.syncReplyTimeoutMs).then(() => [])]);
    return interactionResponse(ResponseType.AUTOCOMPLETE, { choices });
  } catch (err) {
    console.error("Autocomplete failed:", err);
    return interactionResponse(ResponseType.AUTOCOMPLETE, { choices: [] });
  }
}

// Answers within Discord's 3 s window when the handler is quick (the normal case: one D1
// query). If it is slow, falls back to "thinking…" and edits the message when work finishes.
async function respondFast(ctx, interaction, handler, executionCtx, { replyType, deferType, deferEphemeral = false, args }) {
  const work = execute(ctx, interaction, handler, args);
  const result = await Promise.race([work, sleep(ctx.settings.syncReplyTimeoutMs).then(() => TIMED_OUT)]);

  if (result === TIMED_OUT) {
    executionCtx.waitUntil(work.then((late) => finish(ctx, interaction, late, { deferType, publicDefer: !deferEphemeral })));
    return interactionResponse(
      deferType,
      deferType === ResponseType.DEFERRED_MESSAGE && deferEphemeral ? { flags: MessageFlags.EPHEMERAL } : undefined
    );
  }

  executionCtx.waitUntil(runAfter(ctx, interaction, result.after));

  if (result.file) {
    return fileResponse(result.file);
  }

  if (!result.payload) {
    return interactionResponse(ResponseType.DEFERRED_UPDATE);
  }

  if (result.isError) {
    return interactionResponse(ResponseType.MESSAGE, withFlag(result.payload, MessageFlags.EPHEMERAL));
  }

  const type = result.replyType ?? replyType;
  return interactionResponse(type, type === ResponseType.UPDATE ? withoutFlag(result.payload, MessageFlags.EPHEMERAL) : result.payload);
}

// A private reply carrying a file, sent as the interaction response itself (multipart).
function fileResponse(file) {
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      type: ResponseType.MESSAGE,
      data: { content: file.content, attachments: [{ id: 0, filename: file.filename }], flags: MessageFlags.EPHEMERAL, allowed_mentions: { parse: [] } },
    })
  );
  form.append("files[0]", new Blob([file.data], { type: "text/csv" }), file.filename);
  return new Response(form);
}

async function execute(ctx, interaction, handler, args) {
  try {
    await ensureSchema(ctx);
    await loadGuildContext(ctx, interaction);
    const result = (await handler.run(ctx, interaction, args)) || {};
    return { ...result, isError: false };
  } catch (err) {
    if (!(err instanceof UserError)) {
      console.error(`Interaction ${interaction.data?.name || interaction.data?.custom_id} failed:`, err);
    }
    return { payload: errorPayload(err), isError: true };
  }
}

// Delivers a result that finished after the initial reply.
async function finish(ctx, interaction, result, { deferType, publicDefer }) {
  if (result.file) {
    await editOriginalWithFile(ctx, interaction, result.file);
  } else if (result.payload) {
    if (deferType === ResponseType.DEFERRED_UPDATE) {
      const ephemeral = result.isError || (Number(result.payload.flags) & MessageFlags.EPHEMERAL) !== 0;
      if (ephemeral) await sendFollowup(ctx, interaction, withFlag(result.payload, MessageFlags.EPHEMERAL));
      else await editOriginal(ctx, interaction, result.payload);
    } else if (result.isError && publicDefer) {
      if (!(await replaceWithEphemeral(ctx, interaction, result.payload))) await editOriginal(ctx, interaction, result.payload);
    } else {
      await editOriginal(ctx, interaction, result.payload);
    }
  }

  await runAfter(ctx, interaction, result.after);
}

async function runAfter(ctx, interaction, after) {
  try {
    if (after) await after();
  } catch (err) {
    if (!(err instanceof BudgetExceededError) && !(err instanceof PsnError)) {
      console.error("Background work after reply failed:", err);
    }
  } finally {
    logEvent("interaction", {
      name: interaction.data?.name || interaction.data?.custom_id,
      subrequests: ctx.budget.used,
      ms: Date.now() - ctx.now,
    });
  }
}

const withFlag = (payload, flag) => ({ ...payload, flags: Number(payload.flags || 0) | flag });
const withoutFlag = (payload, flag) => ({ ...payload, flags: Number(payload.flags || 0) & ~flag });

const PSN_ERRORS = {
  auth: ["PlayStation login is unavailable right now", "Saved stats still work. The bot owner has been notified."],
  rate_limited: ["PlayStation is busy", "The bot hit PSN's request limit. Try again in a few minutes."],
  budget: ["PlayStation is busy", "Lots of lookups right now. Try again in a few minutes."],
  not_found: ["Couldn't find that PSN account", "Check the Online ID and try again."],
  private: ["Those trophies are private", "The player needs to set **Trophies** to **Anyone** in PSN privacy settings."],
  unavailable: ["PlayStation Network didn't answer", "Try again in a few minutes."],
};

function errorPayload(err) {
  if (err instanceof UserError) {
    return noticeView({ tone: err.tone, title: err.title, body: err.body, suggestions: err.suggestions });
  }

  if (err instanceof PsnError) {
    const [title, body] = PSN_ERRORS[err.code] || PSN_ERRORS.unavailable;
    return noticeView({ tone: "warning", title, body });
  }

  if (err instanceof BudgetExceededError) {
    return noticeView({ tone: "warning", title: "The bot is busy", body: "Try again in a moment." });
  }

  return noticeView({ tone: "danger", title: "Something went wrong", body: "Please try again in a moment." });
}
