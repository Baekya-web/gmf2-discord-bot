# GMF2 Discord Bot

## Local run

```bash
npm install
node index.js
```

## `/link` debugging

When `/link code:<code>` reaches this bot process, the terminal should show logs like:

```text
[interaction] { commandName: 'link', ... }
[link] redeem response { status: ..., data: ... }
```

If `[interaction]` does not appear, the Discord slash command is not reaching this bot process. Check `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, the Discord application ID, which bot was invited to the server, and slash command registration.

## Required Render environment variables

Set these for the `/link` flow:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `SUPABASE_URL`
- `BOT_SHARED_SECRET`

`DISCORD_GUILD_ID` (or `GUILD_ID`) only selects slash command registration mode (guild-scoped vs global) -- see "ZeroConfig Phase 2 routing" below. It is not required.

For manual app/Supabase share callbacks, set this separately if that flow is enabled:

- `GMF_DISCORD_BOT_SHARE_SECRET`

`GMF_DISCORD_BOT_SHARE_URL` is **not** a bot-side variable -- do not set it here. It belongs to the gmf2 Supabase Edge Functions (`quest-completed`, `send-daily-log`), which use it to know where to POST share requests to (this bot's `/discord/share` endpoint).

## ZeroConfig Phase 2 routing

Since ZeroConfig Phase 2, this bot no longer restricts `/link` or share routing to a single statically configured guild:

- `/link` runs pre-flight checks (not a DM, channel is text-based, bot has `ViewChannel`+`SendMessages` in that channel) **before** calling `redeem-link-code`. If any check fails, no Supabase `discord_groups` row is created and the user sees a permission-guidance message.
- Share routing (`validateTargetChannel()`) fetches the requested guild/channel live via the Discord API per request (`payload.guildId`/`payload.resultChannelId`, sourced from the gmf2 app's server-canonical `discord_groups` lookup, not client input) and verifies the bot's actual permissions there. `GUILD_ID` is not consulted at runtime.
- `DISCORD_ALLOWED_CHANNEL_IDS`: when set, it's an additional operator restriction (only those channels are ever allowed, even if DB-linked). When **empty**, it no longer means "deny all" -- any DB-linked destination is allowed, gated by the live permission check above.
- `SUPABASE_LINK_STATUS_URL` / `verifyLinkedUser()` remain unusable by this bot (it has no per-user Supabase access token) and should stay unset; see the comment in `.env.example`.
