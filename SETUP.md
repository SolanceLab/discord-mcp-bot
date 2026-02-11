# Discord MCP Bot Setup Guide

A Discord bot with **four deployment modes**:
1. **Local Direct** — MCP server runs locally, Claude Desktop/Code controls the bot directly
2. **Cloud** — Bot runs 24/7 on Fly.io with HTTP API and auto-responses
3. **Proxy** — Local MCP server forwards tool calls to cloud instance
4. **Cloud Connector** — Cloudflare Worker gives Discord access from Claude.ai web/mobile

---

## How It Works

```
┌────────────────────────────────────────────────────────────────┐
│  MODE 1: Local Direct                                          │
│  Claude Desktop/Code ←→ MCP Server ←→ Discord                  │
│  • You control the bot through Claude                          │
│  • 28 tools: read, send, search, manage channels, moderate     │
│  • Bot auto-responds to @mentions via Claude API               │
│  • Requires your machine to be running                         │
├────────────────────────────────────────────────────────────────┤
│  MODE 2: Cloud (Fly.io)                                        │
│  Discord ←──WebSocket──→ Cloud Server ←──→ HTTP API            │
│  • Bot runs 24/7 on Fly.io (or any cloud provider)             │
│  • HTTP API with bearer token auth + rate limiting             │
│  • Auto-responds to owner @mentions via Claude API             │
├────────────────────────────────────────────────────────────────┤
│  MODE 3: Proxy                                                 │
│  Claude Desktop/Code ←→ MCP Server ──HTTP──→ Cloud Server      │
│  • Best of both: Claude tools + 24/7 cloud uptime              │
│  • Local MCP server forwards tool calls to cloud via HTTP      │
│  • No duplicate Discord connections                            │
├────────────────────────────────────────────────────────────────┤
│  MODE 4: Cloud Connector (Cloudflare Worker)                   │
│  Claude.ai ←──MCP──→ Cloudflare Worker ──HTTP──→ Cloud Server  │
│  • Access Discord from Claude.ai web or mobile app             │
│  • No laptop required — works from phone/tablet                │
│  • See /cloud-connector for setup                              │
└────────────────────────────────────────────────────────────────┘
```

**All modes share:** Discord connection, memory ledger, persona file.

---

## Prerequisites

- **Node.js 18+** — [Download](https://nodejs.org/)
- **Claude Desktop or Claude Code** — [Download](https://claude.ai/download)
- **Discord Account** — to create a bot
- **Anthropic API Key** — from [console.anthropic.com](https://console.anthropic.com)

---

## Step 1: Create Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"** → name it → **Create**
3. Go to **Bot** tab → **Add Bot**
4. Under **Privileged Gateway Intents**, enable ALL THREE:
   - ✅ Presence Intent
   - ✅ Server Members Intent
   - ✅ Message Content Intent
5. Click **Reset Token** → copy and save it securely

---

## Step 2: Invite Bot to Your Server

1. Go to **OAuth2 → URL Generator**
2. **Scopes**: Select `bot`
3. **Bot Permissions**: Select these:

   **General:**
   - ✅ View Channels
   - ✅ Manage Channels
   - ✅ Manage Roles

   **Text:**
   - ✅ Send Messages
   - ✅ Send Messages in Threads
   - ✅ Create Public Threads
   - ✅ Create Private Threads
   - ✅ Manage Messages
   - ✅ Manage Threads
   - ✅ Read Message History
   - ✅ Add Reactions

   **Members:**
   - ✅ Moderate Members

4. Copy the generated URL → open it → select your server → **Authorize**

---

## Step 3: Get Your Discord User ID

1. Open Discord
2. Go to **Settings → Advanced → Enable Developer Mode**
3. Right-click your username anywhere → **Copy User ID**
4. Save this ID (you'll need it for the config)

---

## Step 4: Configure the Bot

1. Copy the template files:
   ```bash
   cp .env.template .env
   cp persona.example.md persona.md
   ```

2. Edit `.env` with your values:
   ```env
   DISCORD_BOT_TOKEN=your_bot_token_here
   ANTHROPIC_API_KEY=your_anthropic_api_key_here
   OWNER_USER_ID=your_discord_user_id_here
   ```

3. Edit `persona.md` with your bot's personality — this is what the API auto-response uses

---

## Step 5: Install & Build

```bash
npm install
npm run build
```

---

## Step 6: Configure Claude Desktop/Code

Find your config file:
- **Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add this (create the file if it doesn't exist):

```json
{
  "mcpServers": {
    "discord-bot": {
      "command": "node",
      "args": ["/FULL/PATH/TO/discord-mcp-bot/dist/mcp-server.js"]
    }
  }
}
```

**Important:** Replace `/FULL/PATH/TO/` with the actual absolute path.

Restart Claude Desktop/Code.

---

## Step 7: Test

1. Open Discord and find your bot (should show online)
2. @mention the bot in any channel
3. **If you're the owner**: Bot should auto-respond
4. **If testing with another account**: You should get a DM notification

In Claude Desktop, try:
- "Read the last 10 messages from #general"
- "Send 'Hello!' to #general"

---

## MCP Tools Available (28 Total)

### Core
| Tool | Description |
|------|-------------|
| `discord_read_messages` | Read recent messages (includes attachments) |
| `discord_send_message` | Send a message to a channel |
| `discord_send_dm` | Send a DM to a user |
| `discord_get_dm_channel` | Get DM channel ID for a user |
| `discord_send_file` | Send a file/attachment to a channel |
| `discord_check_mentions` | Check pending @mentions |
| `discord_check_dms` | Check pending DMs |
| `discord_get_history` | Get conversation history |
| `discord_list_channels` | List server channels |

### Channel Management
| Tool | Description |
|------|-------------|
| `discord_create_channel` | Create text/voice/forum channels |
| `discord_rename_channel` | Rename a channel |
| `discord_delete_channel` | Delete a channel |
| `discord_create_category` | Create a category |
| `discord_move_channel` | Move channel between categories |
| `discord_set_channel_topic` | Set channel description |

### Message & Thread Management
| Tool | Description |
|------|-------------|
| `discord_add_reaction` | React to a message |
| `discord_get_reactions` | Get all reactions on a message with user lists |
| `discord_create_poll` | Create a native Discord poll |
| `discord_edit_message` | Edit bot's own messages |
| `discord_delete_message` | Delete messages |
| `discord_pin_message` | Pin a message |
| `discord_create_thread` | Create thread in text channel |
| `discord_create_forum_post` | Create post in forum channel |
| `discord_list_forum_threads` | List threads in a forum |
| `discord_fetch_attachment` | Download attachments locally |

### Moderation
| Tool | Description |
|------|-------------|
| `discord_timeout_user` | Timeout a user (max 28 days) |
| `discord_assign_role` | Assign a role to a user |
| `discord_remove_role` | Remove a role from a user |

### Awareness
| Tool | Description |
|------|-------------|
| `discord_list_members` | List server members |
| `discord_get_user_info` | Get user details |
| `discord_list_roles` | List server roles |

---

## The Claude API Layer

This is what makes the bot "alive" even when Claude Desktop is closed.

**How it works:**
- When someone @mentions the bot, the MCP server intercepts it
- If it's the **owner** (your user ID): calls Claude API with your persona + conversation history → responds in Discord
- If it's **anyone else**: sends you a DM notification with a link to the message

**Persona loading priority:**
1. `./persona.md` in the project folder
2. `~/.claude/CLAUDE.md` (global Claude identity file)
3. Fallback minimal prompt

**Memory:**
- All conversations are stored in `memory-ledger.json`
- Both MCP path and API path share the same memory
- History is included in API calls for context

---

## Step 8: Cloud Deployment (Optional)

If you want your bot running 24/7 without keeping your machine on, deploy to the cloud.

### Prerequisites

- [Fly.io CLI](https://fly.io/docs/getting-started/installing-flyctl/) installed
- Fly.io account (free tier works)

### Deploy to Fly.io

1. Build the project:
   ```bash
   npm run build
   ```

2. Copy and edit the Fly.io config:
   ```bash
   cp fly.toml.example fly.toml
   ```
   Edit `fly.toml` — change `app = "your-discord-bot-app-name"` to your app name.

3. Create the app (first time only):
   ```bash
   fly apps create your-discord-bot-app-name
   ```

4. Set secrets:
   ```bash
   fly secrets set \
     DISCORD_BOT_TOKEN=your_token \
     ANTHROPIC_API_KEY=your_key \
     OWNER_USER_ID=your_user_id \
     BOT_API_SECRET=your_secret
   ```

   Generate `BOT_API_SECRET` with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

5. Deploy:
   ```bash
   fly deploy
   ```

6. Check it's running:
   ```bash
   fly status
   fly logs
   ```

### Important Notes

- **Only one instance** — The bot maintains a single Discord WebSocket connection. `fly.toml.example` is configured for `max_machines_running = 1`.
- **Always running** — `auto_stop_machines = "off"` keeps the bot alive 24/7 for the Discord WebSocket.
- **Stop local first** — Before deploying, stop any local instance to avoid duplicate connections.

---

## Step 9: Proxy Mode (Optional)

Proxy mode gives you the best of both worlds: Claude Desktop/Code tools + 24/7 cloud uptime. Your local MCP server becomes a thin HTTP client that forwards all tool calls to your cloud instance.

### Configure

Add these to your `.env`:

```env
BOT_API_URL=https://your-app.fly.dev
BOT_API_SECRET=your_shared_secret
```

The `BOT_API_SECRET` must match what you set as a Fly.io secret.

### How It Works

When `BOT_API_URL` is set, the MCP server automatically switches to proxy mode:
- All 28 tools are still available to Claude
- Tool calls are forwarded to the cloud instance via HTTP
- Attachment downloads go through the cloud (CDN URLs fetched remotely, saved locally)
- No local Discord connection — the cloud instance handles that

### When to Use Each Mode

| Scenario | Mode |
|----------|------|
| Testing and development | Local Direct |
| 24/7 bot with auto-responses only | Cloud |
| 24/7 bot + Claude Desktop/Code tools | Proxy + Cloud |
| Discord access from phone/browser | Cloud Connector + Cloud |

---

## File Structure

```
discord-mcp-bot/
├── src/
│   ├── mcp-server.ts      # MCP server — local direct or proxy mode
│   ├── cloud-server.ts    # Cloud entry point (Fly.io)
│   ├── http-server.ts     # Express HTTP API with auth + rate limiting
│   ├── discord-client.ts  # Discord.js client wrapper (28 methods)
│   ├── claude.ts          # Anthropic API client
│   ├── memory.ts          # Memory ledger + optional external API sync
│   ├── logger.ts          # Persistent logging with rotation
│   ├── types.ts           # TypeScript types
│   └── index.ts           # Standalone entry point (legacy)
├── dist/                  # Compiled JavaScript
├── Dockerfile             # Container build for cloud deployment
├── fly.toml.example       # Fly.io config template
├── .env                   # Your credentials (create from template)
├── .env.template          # Template for credentials
├── persona.md             # Your bot's personality (create from template)
├── persona.example.md     # Example persona
├── memory-ledger.json     # Conversation history (auto-created)
├── SETUP.md               # This file
└── README.md              # Architecture overview
```

---

## Troubleshooting

### Bot doesn't respond to @mentions
- Check the bot is online (green dot in Discord)
- Verify your user ID is correct in `.env`
- Check that Message Content Intent is enabled in Discord Developer Portal

### "Discord client not ready"
- Wait a few seconds after starting
- Check your bot token is correct

### Multiple responses / duplicate messages
- Kill old processes: `pkill -f "mcp-server.js"`
- Restart Claude Desktop
- If using cloud: make sure local instance is stopped

### Tools not appearing in Claude
- Restart Claude Desktop after editing config
- Check the path in `claude_desktop_config.json` is correct
- Check Claude Desktop logs for errors

### Cloud bot not responding
- Check logs: `fly logs`
- Verify secrets are set: `fly secrets list`
- Check health: `curl https://your-app.fly.dev/health`

### Proxy mode not connecting
- Verify `BOT_API_URL` is correct in `.env`
- Verify `BOT_API_SECRET` matches between local `.env` and Fly.io secrets
- Check cloud instance is running: `fly status`

---

## Questions?

Open an issue on [GitHub](https://github.com/SolanceLab/discord-mcp-bot/issues)!
