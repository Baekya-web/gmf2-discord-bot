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

If the bot is registered only to one guild for fast command updates, also set `DISCORD_GUILD_ID`.

For manual app/Supabase share callbacks, set these separately if that flow is enabled:

- `GMF_DISCORD_BOT_SHARE_SECRET`
- `GMF_DISCORD_BOT_SHARE_URL`
