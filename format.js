/**
 * GMF2 Discord Bot — share message formatter (Track A)
 *
 * Moved out of index.js so message formatting can evolve (new payload
 * fields, new shareKind titles) without touching routing/auth code.
 *
 * Habit LP is intentionally never rendered here: GMF2 Rulebook LP module
 * v1.2 §6.3 confirms Habit always awards 0 LP and is not a Tier gate, so a
 * "Habit" breakdown line would be misleading. The Habit *completion list*
 * (which habits were done today) is unrelated to LP and is still shown.
 */

const SHARE_KIND_TITLES = {
  daily_result: "[GMF Daily Result]",
  daily_result_update: "[GMF Daily Result Update]",
  catch_up_summary: "[GMF Catch-Up Summary]",
  main_quest_clear: "[GMF Main Quest Clear]",
};

function resolveShareTitle(shareKind) {
  return SHARE_KIND_TITLES[shareKind] || SHARE_KIND_TITLES.daily_result;
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

  const details = payload.details && typeof payload.details === "object" ? payload.details : {};

  const lines = [`**${resolveShareTitle(details.shareKind)}**`];
  if (payload.discordDisplayName) lines.push(`**${payload.discordDisplayName}**`);
  lines.push("");
  if (payload.date) lines.push(`Date: ${payload.date}`);
  if (payload.lpDelta !== undefined && payload.lpDelta !== null) {
    lines.push(`LP: ${formatSignedNumber(payload.lpDelta)}`);
  }
  // Forward-compatible: only rendered when the caller actually sends tokens.
  if (payload.tokens !== undefined && payload.tokens !== null) {
    lines.push(`Tokens: ${formatSignedNumber(payload.tokens)}`);
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
    // Forward-compatible: only rendered once the caller actually sends it.
    ["Core Quest Completion", breakdown.coreCompletionLP ?? payload.coreCompletionLP],
    ["Nutrition", breakdown.nutritionLP ?? payload.nutritionLP],
    // No "Habit" entry: Rulebook LP module v1.2 §6.3, Habit LP is always 0.
  ].filter(([, value]) => value !== undefined && value !== null);

  if (breakdownLines.length) {
    lines.push("", "Breakdown:");
    for (const [label, value] of breakdownLines) {
      lines.push(`${label} ${formatSignedNumber(value)}`);
    }
  }

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
    // Forward-compatible: only appended once the caller actually sends wakeCheckIn.lp;
    // absent, this renders exactly as it did before Track A (no regression).
    const wakeLp = details.wakeCheckIn.lp;
    const wakeLpText = wakeLp !== undefined && wakeLp !== null ? ` (${formatSignedNumber(wakeLp)})` : "";
    if (wakeParts.length) lines.push("", `Wake: ${wakeParts.join(" · ")}${wakeLpText}`);
  }

  if (payload.promoted) {
    const before = formatRank(payload.rankBefore);
    const after = formatRank(rankAfter);
    if (before || after) lines.push("", `Promotion: ${before || "Before"} → ${after || "After"}`);
  }

  return lines.join("\n").trim();
}

module.exports = { formatShareMessage };
