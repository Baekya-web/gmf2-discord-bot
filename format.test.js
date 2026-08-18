const test = require("node:test");
const assert = require("node:assert/strict");
const { formatShareMessage } = require("./format");

const basePayload = () => ({
  type: "manual_apply_share",
  userId: "u1",
  discordDisplayName: "Baekya",
  discordGroupId: "g1",
  guildId: "guild1",
  resultChannelId: "chan1",
  date: "2026-08-18",
  lpDelta: 24,
  rankAfter: { tier: "Gold", division: 3, lp: 42 },
});

// 1. Habit line never appears even when breakdown.habitLP is provided.
test("Habit breakdown line is never rendered (breakdown.habitLP)", () => {
  const msg = formatShareMessage({ ...basePayload(), breakdown: { habitLP: 0 } });
  assert.doesNotMatch(msg, /Habit\s/);
});

// 2. Habit line never appears even when the legacy payload.habitLP fallback is provided.
test("Habit breakdown line is never rendered (payload.habitLP fallback)", () => {
  const msg = formatShareMessage({ ...basePayload(), habitLP: 0 });
  assert.doesNotMatch(msg, /Habit\s/);
});

// 3. shareKind = daily_result -> default title.
test("shareKind daily_result renders the Daily Result title", () => {
  const msg = formatShareMessage({ ...basePayload(), details: { shareKind: "daily_result" } });
  assert.match(msg, /^\*\*\[GMF Daily Result\]\*\*/);
});

// 4. shareKind = daily_result_update -> update title.
test("shareKind daily_result_update renders the Daily Result Update title", () => {
  const msg = formatShareMessage({ ...basePayload(), details: { shareKind: "daily_result_update" } });
  assert.match(msg, /^\*\*\[GMF Daily Result Update\]\*\*/);
});

// 5. shareKind = catch_up_summary -> catch-up title.
test("shareKind catch_up_summary renders the Catch-Up Summary title", () => {
  const msg = formatShareMessage({ ...basePayload(), details: { shareKind: "catch_up_summary" } });
  assert.match(msg, /^\*\*\[GMF Catch-Up Summary\]\*\*/);
});

// 6. shareKind = main_quest_clear -> main quest clear title.
test("shareKind main_quest_clear renders the Main Quest Clear title", () => {
  const msg = formatShareMessage({ ...basePayload(), details: { shareKind: "main_quest_clear" } });
  assert.match(msg, /^\*\*\[GMF Main Quest Clear\]\*\*/);
});

// 7. Missing/unrecognized shareKind falls back to the Daily Result title.
test("missing or unknown shareKind falls back to the Daily Result title", () => {
  const noKind = formatShareMessage(basePayload());
  assert.match(noKind, /^\*\*\[GMF Daily Result\]\*\*/);

  const unknownKind = formatShareMessage({ ...basePayload(), details: { shareKind: "something_new" } });
  assert.match(unknownKind, /^\*\*\[GMF Daily Result\]\*\*/);
});

// 8. coreCompletionLP present -> Core Quest Completion breakdown line shown.
test("coreCompletionLP is rendered when present", () => {
  const msg = formatShareMessage({ ...basePayload(), breakdown: { coreCompletionLP: 3 } });
  assert.match(msg, /Core Quest Completion \+3/);
});

// 9. coreCompletionLP absent -> no line, no crash (forward-compat / no regression).
test("coreCompletionLP line is omitted when absent", () => {
  const msg = formatShareMessage(basePayload());
  assert.doesNotMatch(msg, /Core Quest Completion/);
});

// 10. tokens present -> Tokens line shown.
test("tokens line is rendered when present", () => {
  const msg = formatShareMessage({ ...basePayload(), tokens: 2 });
  assert.match(msg, /^Tokens: \+2$/m);
});

// 11. tokens absent -> no Tokens line (regression safety for existing payloads).
test("tokens line is omitted when absent", () => {
  const msg = formatShareMessage(basePayload());
  assert.doesNotMatch(msg, /Tokens:/);
});

// 12. wakeCheckIn.lp present -> LP shown appended to the Wake line.
test("wakeCheckIn.lp is appended to the Wake line when present", () => {
  const msg = formatShareMessage({
    ...basePayload(),
    details: { wakeCheckIn: { status: "success", checkedAt: "06:35", lp: 1 } },
  });
  assert.match(msg, /^Wake: success · 06:35 \(\+1\)$/m);
});

// 13. wakeCheckIn present without .lp -> renders exactly as before Track A (no regression).
test("Wake line omits the LP suffix when wakeCheckIn.lp is absent", () => {
  const msg = formatShareMessage({
    ...basePayload(),
    details: { wakeCheckIn: { status: "success", checkedAt: "06:35" } },
  });
  assert.match(msg, /^Wake: success · 06:35$/m);
});

// 14. Legacy fallback preserved: no rankAfter/breakdown object, direct payload.tier/payload.lp used.
test("legacy payload.tier/payload.lp fallback still renders the Rank line", () => {
  const msg = formatShareMessage({
    type: "manual_apply_share",
    userId: "u1",
    discordDisplayName: "Baekya",
    discordGroupId: "g1",
    guildId: "guild1",
    resultChannelId: "chan1",
    date: "2026-08-18",
    lpDelta: 10,
    tier: "Silver",
    division: 2,
    lp: 55,
  });
  assert.match(msg, /^Rank: Silver 2 · 55\/100 LP$/m);
});

// 15. Full legacy payload (pre-Track-A shape) renders byte-identical to the pre-Track-A output.
test("legacy payload without any new fields matches the original output exactly", () => {
  const payload = {
    ...basePayload(),
    breakdown: { mainQuestLP: 20, subQuestLP: 3, nutritionLP: 1 },
    details: {
      completedSubQuests: [{ title: "Read paper", lp: 3 }],
      nutrition: { status: "success", calories: 2100, protein: 140 },
    },
    promoted: true,
    rankBefore: { tier: "Gold", division: 4, lp: 95 },
  };
  const expected = [
    "**[GMF Daily Result]**",
    "**Baekya**",
    "",
    "Date: 2026-08-18",
    "LP: +24",
    "Rank: Gold 3 · 42/100 LP",
    "",
    "Breakdown:",
    "Main Quest +20",
    "Sub Quest +3",
    "Nutrition +1",
    "",
    "Sub Quests:",
    "* Read paper (+3)",
    "",
    "Nutrition: success",
    "Calories: 2100 kcal",
    "Protein: 140 g",
    "",
    "Promotion: Gold 4 → Gold 3",
  ].join("\n");
  assert.equal(formatShareMessage(payload), expected);
});

// 16. Minimal payload (only required fields) does not throw and omits all optional sections.
test("minimal payload does not throw and omits optional sections", () => {
  const msg = formatShareMessage({
    type: "manual_apply_share",
    userId: "u1",
    discordGroupId: "g1",
    guildId: "guild1",
    resultChannelId: "chan1",
    date: "2026-08-18",
    lpDelta: 0,
  });
  assert.match(msg, /^\*\*\[GMF Daily Result\]\*\*/);
  assert.doesNotMatch(msg, /Breakdown:/);
  assert.doesNotMatch(msg, /Tokens:/);
  assert.doesNotMatch(msg, /Wake:/);
  assert.doesNotMatch(msg, /Promotion:/);
});
