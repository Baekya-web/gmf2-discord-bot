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
} = require("discord.js");

// ===== ENV =====
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || "").trim();
const DISCORD_APP_ID = (process.env.DISCORD_APP_ID || "").trim();
const GUILD_ID = (process.env.GUILD_ID || process.env.DISCORD_GUILD_ID || "").trim();

const SUPABASE_REDEEM_URL = (process.env.SUPABASE_REDEEM_URL || "").trim();
const SUPABASE_LEADERBOARD_URL = (process.env.SUPABASE_LEADERBOARD_URL || "").trim();
const SUPABASE_LINK_STATUS_URL = (process.env.SUPABASE_LINK_STATUS_URL || "").trim();
const BOT_SHARED_SECRET = (process.env.BOT_SHARED_SECRET || "").trim();
const GMF_DISCORD_API_SECRET = (process.env.GMF_DISCORD_API_SECRET || BOT_SHARED_SECRET || "").trim();
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
const missing = [];
if (!DISCORD_TOKEN) missing.push("DISCORD_TOKEN or DISCORD_BOT_TOKEN");
if (!DISCORD_APP_ID) missing.push("DISCORD_APP_ID");
if (!GUILD_ID) missing.push("GUILD_ID or DISCORD_GUILD_ID");
if (!SUPABASE_REDEEM_URL) missing.push("SUPABASE_REDEEM_URL");
if (!BOT_SHARED_SECRET) missing.push("BOT_SHARED_SECRET");
if (!SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");
if (!GMF_DISCORD_API_SECRET) missing.push("GMF_DISCORD_API_SECRET or BOT_SHARED_SECRET");

if (missing.length) {
  console.error("❌ Missing env vars:", missing.join(", "));
  console.error("👉 Check your .env file or Render environment variables.");
  process.exit(1);
}

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

function formatSignedNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return numeric >= 0 ? `+${numeric}` : String(numeric);
}

function formatRank(rank) {
  if (!rank || typeof rank !== "object") return "";
  const parts = [];
  if (rank.tier) parts.push(String(rank.tier));
  if (rank.division !== undefined && rank.division !== null) parts.push(String(rank.division));
  return parts.join(" ");
}

function formatOptionalList(title, items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const lines = ["", `${title}:`];
  for (const item of items) {
    if (!item || !item.title) continue;
    const lpText = item.lp !== undefined && item.lp !== null ? ` (${formatSignedNumber(item.lp)})` : "";
    lines.push(`* ${item.title}${lpText}`);
  }
  return lines.length > 2 ? lines : [];
}

function formatShareMessage(payload) {
  const rankAfter = payload.rankAfter && typeof payload.rankAfter === "object"
    ? payload.rankAfter
    : {
        tier: payload.tier,
        division: payload.division,
        lp: payload.lp ?? payload.currentLp,
      };

  const lines = ["**[GMF Daily Result]**"];
  if (payload.discordDisplayName) lines.push(`**${payload.discordDisplayName}**`);
  lines.push("");
  if (payload.date) lines.push(`Date: ${payload.date}`);
  if (payload.lpDelta !== undefined && payload.lpDelta !== null) {
    lines.push(`LP: ${formatSignedNumber(payload.lpDelta)}`);
  }

  const rankLabel = formatRank(rankAfter) || formatRank(payload);
  const lp = rankAfter.lp ?? payload.lp ?? payload.currentLp;
  if (rankLabel || lp !== undefined) {
    lines.push(`Rank: ${rankLabel || "Rank"}${lp !== undefined ? ` · ${lp}/100 LP` : ""}`);
  }

  const breakdown = payload.breakdown || {};
  const breakdownLines = [
    ["Main Quest", breakdown.mainQuestLP ?? payload.mainQuestLP],
    ["Sub Quest", breakdown.subQuestLP ?? payload.subQuestLP],
    ["Nutrition", breakdown.nutritionLP ?? payload.nutritionLP],
    ["Habit", breakdown.habitLP ?? payload.habitLP],
  ].filter(([, value]) => value !== undefined && value !== null);

  if (breakdownLines.length) {
    lines.push("", "Breakdown:");
    for (const [label, value] of breakdownLines) {
      lines.push(`${label} ${formatSignedNumber(value)}`);
    }
  }

  const details = payload.details && typeof payload.details === "object" ? payload.details : {};
  lines.push(...formatOptionalList("Sub Quests", details.completedSubQuests));
  lines.push(...formatOptionalList("Habits", details.completedHabits));

  if (details.nutrition && typeof details.nutrition === "object") {
    lines.push("", `Nutrition: ${details.nutrition.status || "Unknown"}`);
    if (details.nutrition.calories !== undefined && details.nutrition.calories !== null) {
      lines.push(`Calories: ${details.nutrition.calories} kcal`);
    }
    if (details.nutrition.protein !== undefined && details.nutrition.protein !== null) {
      lines.push(`Protein: ${details.nutrition.protein} g`);
    }
  }

  if (details.wakeCheckIn && typeof details.wakeCheckIn === "object") {
    const wakeParts = [details.wakeCheckIn.status, details.wakeCheckIn.checkedAt].filter(Boolean);
    if (wakeParts.length) lines.push("", `Wake: ${wakeParts.join(" · ")}`);
  }

  if (payload.promoted) {
    const before = formatRank(payload.rankBefore);
    const after = formatRank(rankAfter);
    if (before || after) lines.push("", `Promotion: ${before || "Before"} → ${after || "After"}`);
  }

  return lines.join("\n").trim();
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

  const allowedChannels = new Set(DISCORD_ALLOWED_CHANNEL_IDS);
  if (DISCORD_DEFAULT_RESULT_CHANNEL_ID) allowedChannels.add(DISCORD_DEFAULT_RESULT_CHANNEL_ID);
  if (!allowedChannels.has(requestedChannelId)) {
    return { ok: false, status: 400, code: "CHANNEL_NOT_ALLOWED", message: "This channel is not allowed for GMF routing." };
  }

  if (payload.guildId && String(payload.guildId).trim() !== GUILD_ID) {
    return { ok: false, status: 400, code: "CHANNEL_WRONG_GUILD", message: "Discord channel is not in the configured guild." };
  }

  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) {
    return { ok: false, status: 500, code: "CHANNEL_WRONG_GUILD", message: "Configured Discord guild is unavailable." };
  }

  const channel = await guild.channels.fetch(requestedChannelId).catch(() => null);
  if (!channel) {
    return { ok: false, status: 400, code: "CHANNEL_NOT_FOUND", message: "Discord group channel was not found." };
  }
  if (channel.guildId !== GUILD_ID) {
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
  if (getBearerToken(req) !== GMF_DISCORD_API_SECRET) {
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
  console.log("DISCORD_APP_ID:", DISCORD_APP_ID);
  console.log("GUILD_ID:", GUILD_ID);

  const commands = [];

  commands.push(
    new SlashCommandBuilder()
      .setName("link")
      .setDescription("GMF2 앱 계정을 연결합니다.")
      .addStringOption((option) =>
        option
          .setName("code")
          .setDescription("앱에서 받은 6자리 코드")
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

  await rest.put(Routes.applicationGuildCommands(DISCORD_APP_ID, GUILD_ID), {
    body: commands,
  });

  console.log(
    "✅ Slash commands registered:",
    commands.map((c) => c.name).join(", ")
  );
}

// ===== Bot client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log("Redeem URL configured:", Boolean(SUPABASE_REDEEM_URL));
  console.log("Leaderboard URL configured:", Boolean(SUPABASE_LEADERBOARD_URL));
  console.log("Link status URL configured:", Boolean(SUPABASE_LINK_STATUS_URL));
  console.log("Allowed Discord channels configured:", DISCORD_ALLOWED_CHANNEL_IDS.size);
  console.log("Default result channel configured:", Boolean(DISCORD_DEFAULT_RESULT_CHANNEL_ID));
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await interaction.deferReply({ ephemeral: true });

    // ---------- /link ----------
    if (interaction.commandName === "link") {
      const code = interaction.options.getString("code", true).trim();

      if (!/^\d{6}$/.test(code)) {
        return interaction.editReply(
          "❌ 코드 형식이 잘못됐어요. 6자리 숫자를 입력하세요."
        );
      }

      const payload = {
        code,
        discordUserId: interaction.user.id,
        discordUsername: interaction.user.username,
        discordDisplayName: interaction.member?.displayName ?? null,
      };

      const res = await fetch(SUPABASE_REDEEM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bot-secret": BOT_SHARED_SECRET,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(payload),
      });

      const text = await res.text().catch(() => "");
      const data = safeJsonParse(text);

      if (!res.ok || !data.ok) {
        const short = text.length > 1800 ? text.slice(0, 1800) + "..." : text;
        console.log("Redeem failed:", res.status, data.error || "unknown");
        return interaction.editReply(
          `❌ 연결 실패 (HTTP ${res.status})\n\`\`\`\n${short}\n\`\`\``
        );
      }

      return interaction.editReply(
        `✅ 연결 완료! (GMF user: ${data.gmfUserId ?? "unknown"})`
      );
    }

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
        ephemeral: true,
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