/**
 * GMF2 Discord Bot (guild-scoped slash commands)
 * - /link code:xxxxxx  -> calls Supabase redeem-link-code Edge Function (x-bot-secret)
 * - /leaderboard       -> calls Supabase leaderboard Edge Function (optional)
 *
 * Run:
 *   npm install
 *   npm start
 */

require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

// ===== ENV =====
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || "").trim();
const DISCORD_APP_ID = (process.env.DISCORD_APP_ID || "").trim();
const GUILD_ID = (process.env.GUILD_ID || "").trim();

const SUPABASE_REDEEM_URL = (process.env.SUPABASE_REDEEM_URL || "").trim();
const SUPABASE_LEADERBOARD_URL = (process.env.SUPABASE_LEADERBOARD_URL || "").trim();
const BOT_SHARED_SECRET = (process.env.BOT_SHARED_SECRET || "").trim();
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();

// ===== Required env check =====
const missing = [];
if (!DISCORD_TOKEN) missing.push("DISCORD_TOKEN");
if (!DISCORD_APP_ID) missing.push("DISCORD_APP_ID");
if (!GUILD_ID) missing.push("GUILD_ID");
if (!SUPABASE_REDEEM_URL) missing.push("SUPABASE_REDEEM_URL");
if (!BOT_SHARED_SECRET) missing.push("BOT_SHARED_SECRET");
if (!SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");

if (missing.length) {
  console.error("❌ Missing env vars:", missing.join(", "));
  console.error("👉 Check your .env file or Render environment variables.");
  process.exit(1);
}

function safeJsonParse(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function mask(value, keep = 8) {
  if (!value) return "(empty)";
  return value.slice(0, keep);
}

// ===== Register Slash Commands (guild-scoped for fast iteration) =====
async function registerCommands() {
  console.log("DISCORD_TOKEN prefix:", mask(DISCORD_TOKEN));
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
  console.log("Redeem URL:", SUPABASE_REDEEM_URL);
  console.log(
    "Leaderboard URL:",
    SUPABASE_LEADERBOARD_URL || "(not set)"
  );
  console.log("SUPABASE_ANON_KEY prefix:", mask(SUPABASE_ANON_KEY, 10));
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
        console.log("Redeem failed:", res.status, text);
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
        console.log("Leaderboard failed:", res.status, text);
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
(async () => {
  try {
    await registerCommands();
    await client.login(DISCORD_TOKEN);
  } catch (e) {
    console.error("❌ Startup error:", e);
    process.exit(1);
  }
})();