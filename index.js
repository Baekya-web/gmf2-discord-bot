/**
 * GMF2 Discord Bot (guild-scoped slash commands + manual share API)
 * - /link code:xxxxxx  -> calls Supabase redeem-link-code Edge Function (x-bot-secret)
 * - /leaderboard       -> calls Supabase leaderboard Edge Function (optional)
 * - POST /discord/share -> sends manual GMF result shares to validated Discord channels
 *
 * Run:
 *   npm install
 *   npm start
 */

require("dotenv").config();

const http = require("node:http");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");

const { formatShareMessage } = require("./format");

// ===== ENV =====
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || "").trim();
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID || "").trim();
const GUILD_ID = (process.env.GUILD_ID || process.env.DISCORD_GUILD_ID || "").trim();

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_LEADERBOARD_URL = (process.env.SUPABASE_LEADERBOARD_URL || "").trim();
const SUPABASE_LINK_STATUS_URL = (process.env.SUPABASE_LINK_STATUS_URL || "").trim();
const BOT_SHARED_SECRET = (process.env.BOT_SHARED_SECRET || "").trim();
const GMF_DISCORD_BOT_SHARE_SECRET = (process.env.GMF_DISCORD_BOT_SHARE_SECRET || "").trim();
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
const DISCORD_ALLOWED_CHANNEL_IDS = parseCsv(process.env.DISCORD_ALLOWED_CHANNEL_IDS || "");
const DISCORD_DEFAULT_RESULT_CHANNEL_ID = (process.env.DISCORD_DEFAULT_RESULT_CHANNEL_ID || "").trim();
const MANUAL_SHARE_TYPE = "manual_apply_share";
const AUTO_APPLY_TYPES = new Set([
  "auto_apply",
  "auto_apply_share",
  "daily_auto_closeout",
]);

// ===== Required env check =====
function validateEnv() {
  const envStatus = {
    hasDiscordToken: Boolean(DISCORD_TOKEN),
    hasClientId: Boolean(DISCORD_CLIENT_ID),
    hasSupabaseUrl: Boolean(SUPABASE_URL),
    hasBotSharedSecret: Boolean(BOT_SHARED_SECRET),
  };

  console.log("[env]", envStatus);

  const missing = [];
  if (!DISCORD_TOKEN) missing.push("DISCORD_TOKEN");
  if (!DISCORD_CLIENT_ID) missing.push("DISCORD_CLIENT_ID");
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!BOT_SHARED_SECRET) missing.push("BOT_SHARED_SECRET");

  if (missing.length) {
    console.error("❌ Missing env vars:", missing.join(", "));
    console.error("👉 Check your .env file or Render environment variables.");
    process.exit(1);
  }
}

validateEnv();

function parseCsv(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function safeJsonParse(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function mask(value, keepStart = 4, keepEnd = 4) {
  if (!value) return "(empty)";
  if (value.length <= keepStart + keepEnd) return "***";
  return `${value.slice(0, keepStart)}…${value.slice(-keepEnd)}`;
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        return resolve(JSON.parse(body));
      } catch {
        return reject(new Error("Malformed JSON request body"));
      }
    });
    req.on("error", reject);
  });
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function validateSharePayload(payload) {
  const requestType = payload.type ? String(payload.type) : "";

  if (AUTO_APPLY_TYPES.has(requestType)) {
    return {
      ok: false,
      status: 403,
      code: "AUTO_APPLY_POSTING_DISABLED",
      message: "Auto apply Discord posting is disabled for MVP.",
    };
  }

  if (requestType !== MANUAL_SHARE_TYPE) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_SHARE_TYPE",
      message: 'Discord share type must be "manual_apply_share".',
    };
  }

  const required = ["userId", "discordDisplayName", "discordGroupId", "guildId", "resultChannelId", "date"];
  const missingFields = required.filter((field) => !payload[field]);
  if (missingFields.length) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_SHARE_PAYLOAD",
      message: `Missing required field(s): ${missingFields.join(", ")}.`,
    };
  }

  if (payload.lpDelta === undefined || payload.lpDelta === null) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_SHARE_PAYLOAD",
      message: "Missing required field(s): lpDelta.",
    };
  }

  return { ok: true };
}

async function verifyLinkedUser(payload) {
  if (!payload.userId) {
    return { ok: false, status: 400, code: "LINK_NOT_FOUND", message: "Discord account is not linked." };
  }

  if (!SUPABASE_LINK_STATUS_URL) {
    // Existing architecture stores links behind Supabase. When this optional URL is not configured,
    // the trusted backend caller must verify linkage before calling this service.
    return { ok: true, skipped: true };
  }

  const res = await fetch(SUPABASE_LINK_STATUS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bot-secret": BOT_SHARED_SECRET,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ userId: payload.userId }),
  });
  const text = await res.text().catch(() => "");
  const data = safeJsonParse(text);

  if (!res.ok || !data.ok || !data.linked) {
    return { ok: false, status: 400, code: "LINK_NOT_FOUND", message: "Discord account is not linked." };
  }

  return { ok: true, discordUserId: data.discordUserId };
}

async function validateTargetChannel(payload) {
  const requestedChannelId = String(payload.resultChannelId || "").trim();
  if (!requestedChannelId) {
    return { ok: false, status: 400, code: "GROUP_NOT_ASSIGNED", message: "Discord group channel is not configured." };
  }

  // ZeroConfig Phase 2: routing is dynamic and DB-linked-destination-driven,
  // so a guildId is required to fetch the live guild instead of a static
  // configured one.
  const requestedGuildId = String(payload.guildId || "").trim();
  if (!requestedGuildId) {
    return { ok: false, status: 400, code: "GROUP_NOT_ASSIGNED", message: "Discord group guild is not configured." };
  }

  // Allowlist semantics: a configured allowlist still restricts routing to
  // those specific channels (operator restriction). An *empty* allowlist no
  // longer means "deny all" -- it means "allow any DB-linked destination",
  // since the guild/channel fetch and live permission check below are now
  // the actual gate, not a static list.
  const allowedChannels = new Set(DISCORD_ALLOWED_CHANNEL_IDS);
  if (DISCORD_DEFAULT_RESULT_CHANNEL_ID) allowedChannels.add(DISCORD_DEFAULT_RESULT_CHANNEL_ID);
  if (allowedChannels.size > 0 && !allowedChannels.has(requestedChannelId)) {
    return { ok: false, status: 400, code: "CHANNEL_NOT_ALLOWED", message: "This channel is not allowed for GMF routing." };
  }

  const guild = await client.guilds.fetch(requestedGuildId).catch(() => null);
  if (!guild) {
    return { ok: false, status: 400, code: "GUILD_NOT_AVAILABLE", message: "Configured Discord guild is unavailable." };
  }

  const channel = await guild.channels.fetch(requestedChannelId).catch(() => null);
  if (!channel) {
    return { ok: false, status: 400, code: "CHANNEL_NOT_FOUND", message: "Discord group channel was not found." };
  }
  if (channel.guildId !== requestedGuildId) {
    return { ok: false, status: 400, code: "CHANNEL_WRONG_GUILD", message: "Discord channel is not in the configured guild." };
  }
  if (typeof channel.isTextBased !== "function" || !channel.isTextBased() || typeof channel.send !== "function") {
    return { ok: false, status: 400, code: "CHANNEL_NOT_ALLOWED", message: "Discord channel cannot receive text messages." };
  }

  const botMember = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages)) {
    return { ok: false, status: 403, code: "MISSING_SEND_PERMISSION", message: "Bot does not have permission to send messages in this channel." };
  }

  return { ok: true, channel, channelId: requestedChannelId };
}

async function handleShareRequest(req, res) {
  if (!GMF_DISCORD_BOT_SHARE_SECRET || getBearerToken(req) !== GMF_DISCORD_BOT_SHARE_SECRET) {
    return jsonResponse(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Unauthorized." });
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    return jsonResponse(res, 400, { ok: false, code: "MALFORMED_JSON", message: "Malformed JSON request body." });
  }

  const requestType = payload.type ? String(payload.type) : "";
  console.log("Share request received", {
    userId: payload.userId || null,
    discordGroupId: payload.discordGroupId || null,
    resultChannelId: payload.resultChannelId ? mask(String(payload.resultChannelId)) : null,
    type: requestType,
  });

  const payloadValidation = validateSharePayload(payload);
  if (!payloadValidation.ok) {
    return jsonResponse(res, payloadValidation.status, {
      ok: false,
      code: payloadValidation.code,
      message: payloadValidation.message,
    });
  }

    if (!client.isReady()) {
    return jsonResponse(res, 503, {
      ok: false,
      code: "BOT_NOT_READY",
      message: "Discord bot is not ready yet.",
    });
  }

  const link = await verifyLinkedUser(payload);
  if (!link.ok) return jsonResponse(res, link.status, { ok: false, code: link.code, message: link.message });

  const target = await validateTargetChannel(payload);
  if (!target.ok) {
    console.log("Share rejected", { code: target.code, channelId: payload.resultChannelId ? mask(String(payload.resultChannelId)) : null });
    return jsonResponse(res, target.status, { ok: false, code: target.code, message: target.message });
  }

  try {
    // The bot is the sole message formatter; payload.content (if the caller
    // sends it) is intentionally never used here -- see format.js.
    const sentMessage = await target.channel.send({ content: formatShareMessage(payload) });
    console.log("Share sent", { userId: payload.userId, channelId: mask(target.channelId), groupId: payload.discordGroupId || null });
    return jsonResponse(res, 200, { ok: true, channelId: target.channelId, messageId: sentMessage.id });
  } catch (e) {
    console.error("Discord send failed", { message: e?.message || String(e), channelId: mask(target.channelId) });
    return jsonResponse(res, 502, { ok: false, code: "DISCORD_SEND_FAILED", message: "Discord message failed to send." });
  }
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        return jsonResponse(res, 200, { ok: true, service: "gmf2-discord-bot" });
      }
      if (req.method === "GET" && (req.url === "/healthz" || req.url === "/health")) {
        return jsonResponse(res, 200, {
          ok: true,
          discordReady: client.isReady(),
          uptime: process.uptime(),
        });
      }
      if (req.method === "POST" && (req.url === "/discord/share" || req.url === "/share")) {
        return handleShareRequest(req, res);
      }
      return jsonResponse(res, 404, { ok: false, code: "NOT_FOUND", message: "Not found." });
    } catch (e) {
      console.error("HTTP handler error", { message: e?.message || String(e) });
      return jsonResponse(res, 500, { ok: false, code: "INTERNAL_ERROR", message: "Internal server error." });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`✅ HTTP server listening on ${HOST}:${PORT}`);
  });

  return server;
}

// ===== Register Slash Commands (guild-scoped for fast iteration) =====
async function registerCommands() {
  console.log("DISCORD_CLIENT_ID:", DISCORD_CLIENT_ID);
  console.log("GUILD_ID:", GUILD_ID);

  const commands = [];

  commands.push(
    new SlashCommandBuilder()
      .setName("link")
      .setDescription("Connect your GMF2 account to Discord")
      .addStringOption((option) =>
        option
          .setName("code")
          .setDescription("GMF2 link code")
          .setRequired(true)
      )
      .toJSON()
  );

  if (SUPABASE_LEADERBOARD_URL) {
    commands.push(
      new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("이번 주 GMF2 LP 랭킹 Top 10을 보여줍니다.")
        .toJSON()
    );
  }

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  const route = GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(DISCORD_CLIENT_ID);

  await rest.put(route, {
    body: commands,
  });

  console.log(
    GUILD_ID ? "✅ Guild slash commands registered:" : "✅ Global slash commands registered:",
    commands.map((c) => c.name).join(", ")
  );
}

// ===== Bot client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log("Supabase URL configured:", Boolean(SUPABASE_URL));
  console.log("Leaderboard URL configured:", Boolean(SUPABASE_LEADERBOARD_URL));
  console.log("Link status URL configured:", Boolean(SUPABASE_LINK_STATUS_URL));
  console.log("Allowed Discord channels configured:", DISCORD_ALLOWED_CHANNEL_IDS.size);
  console.log("Default result channel configured:", Boolean(DISCORD_DEFAULT_RESULT_CHANNEL_ID));
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  console.log("[interaction]", {
    commandName: interaction.commandName,
    userId: interaction.user?.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
  });

  // ---------- /link ----------
  if (interaction.commandName === "link") {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const NO_SEND_PERMISSION_MESSAGE =
        "이 채널에 GMF2가 메시지를 보낼 권한이 없습니다.\n\n서버 관리자에게\nView Channel / Send Messages 권한을 요청한 뒤 다시 시도하세요.";

      if (!interaction.guildId || !interaction.channelId || !interaction.guild || !interaction.channel) {
        return interaction.editReply(NO_SEND_PERMISSION_MESSAGE);
      }

      if (
        typeof interaction.channel.isTextBased !== "function" ||
        !interaction.channel.isTextBased()
      ) {
        return interaction.editReply(NO_SEND_PERMISSION_MESSAGE);
      }

      const linkBotMember =
        interaction.guild.members.me ||
        (await interaction.guild.members.fetchMe().catch(() => null));
      const linkPermissions = linkBotMember
        ? interaction.channel.permissionsFor(linkBotMember)
        : null;
      if (
        !linkPermissions?.has(PermissionFlagsBits.ViewChannel) ||
        !linkPermissions?.has(PermissionFlagsBits.SendMessages)
      ) {
        return interaction.editReply(NO_SEND_PERMISSION_MESSAGE);
      }

      const code = interaction.options.getString("code", true).trim();

      const res = await fetch(`${SUPABASE_URL}/functions/v1/redeem-link-code`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bot-secret": BOT_SHARED_SECRET,
        },
        body: JSON.stringify({
          code,
          discordUserId: interaction.user.id,
          discordUsername: interaction.user.tag,
          discordDisplayName: interaction.member?.displayName ?? interaction.user.username,
          guildId: interaction.guildId,
          guildName: interaction.guild?.name ?? "",
          channelId: interaction.channelId,
          channelName: interaction.channel?.name ?? "",
        }),
      });

      const data = await res.json().catch(() => null);
      console.log("[link] redeem response", {
        status: res.status,
        data,
      });

      if (!res.ok || !data?.ok) {
        return interaction.editReply(
          `GMF2 연결 실패: ${data?.error ?? `HTTP ${res.status}`}`
        );
      }

      const linkedGuildName = interaction.guild?.name ?? "";
      const linkedChannelName = interaction.channel?.name ?? "";

      return interaction.editReply(
        `✓ GMF2 연결 완료\n\n서버: ${linkedGuildName}\n공유 채널: #${linkedChannelName}\n\n이 채널이 현재 기본 공유 위치로 설정되었습니다.\n이제 GMF2 앱으로 돌아가세요.`
      );
    } catch (error) {
      console.error("[link] failed", error);
      const content = "GMF2 연결 실패: 잠시 후 다시 시도해주세요.";

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(content);
        } else {
          await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
      } catch (replyError) {
        console.error("[link] failed to send error reply", replyError);
      }
      return;
    }
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // ---------- /leaderboard ----------
    if (interaction.commandName === "leaderboard") {
      if (!SUPABASE_LEADERBOARD_URL) {
        return interaction.editReply(
          "❌ leaderboard 기능이 아직 설정되지 않았어요."
        );
      }

      const res = await fetch(SUPABASE_LEADERBOARD_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bot-secret": BOT_SHARED_SECRET,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({}),
      });

      const text = await res.text().catch(() => "");
      const data = safeJsonParse(text);

      if (!res.ok || !data.ok) {
        console.log("Leaderboard failed:", res.status, data.error || "unknown");
        return interaction.editReply(
          `❌ leaderboard 조회 실패: ${data.error ?? `HTTP ${res.status}`}`
        );
      }

      const lb = Array.isArray(data.leaderboard) ? data.leaderboard : [];
      if (lb.length === 0) {
        return interaction.editReply("이번 주 기록이 아직 없습니다.");
      }

      const lines = lb.slice(0, 10).map((row, i) => {
        const name = row.display_name ?? row.displayName ?? "Unknown";
        const lp = row.total_lp ?? row.totalLp ?? 0;
        return `${i + 1}. **${name}** — ${lp} LP`;
      });

      return interaction.editReply(
        `🏆 **Weekly Leaderboard (Top 10)**\n${lines.join("\n")}`
      );
    }

    return interaction.editReply("알 수 없는 커맨드입니다.");
  } catch (e) {
    console.error("interaction error:", e);

    const msg =
      e && typeof e === "object" && "message" in e
        ? e.message
        : String(e);

    if (!interaction.deferred && !interaction.replied) {
      return interaction.reply({
        content: `❌ 에러: ${msg}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.editReply(`❌ 에러: ${msg}`);
  }
});

// ===== Start =====
(async function startDiscordBot() {
  startHttpServer();

  console.log("Discord login started");
  client.login(DISCORD_TOKEN).catch((e) => {
    console.error("❌ Discord login error:", e?.message || String(e));
    console.error("HTTP server remains online; /healthz will report discordReady: false.");
  });

  registerCommands().catch((e) => {
    console.error("❌ Slash command registration error:", e?.message || String(e));
  });
})();