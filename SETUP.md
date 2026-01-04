# Discord MCP Bot Setup Guide

A Discord bot with **two response paths**:
1. **MCP Tools** — Claude Desktop/Code controls the bot directly
2. **Claude API Auto-Response** — Bot responds to @mentions autonomously (even when Claude Desktop is closed)

---

## How It Works

```
┌────────────────────────────────────────────────────────────────┐
│  PATH 1: MCP Tools                                             │
│  Claude Desktop/Code ←→ MCP Server ←→ Discord                  │
│  • You control the bot through Claude                          │
│  • 20+ tools: read, send, manage channels, moderate, etc.      │
│  • Requires Claude Desktop/Code to be open                     │
├────────────────────────────────────────────────────────────────┤
│  PATH 2: Claude API Auto-Response (Always Running)             │
│  Discord @mention → MCP Server → Claude API → Discord          │
│  • Bot auto-responds when owner @mentions it                   │
│  • Others who @mention → owner gets DM notification            │
│  • Works 24/7 while the MCP server is running                  │
└────────────────────────────────────────────────────────────────┘
```

**Both paths share:** Discord connection, memory ledger, persona file.

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

## MCP Tools Available (20+ Total)

### Core
| Tool | Description |
|------|-------------|
| `discord_read_messages` | Read recent messages (includes attachments) |
| `discord_send_message` | Send a message to a channel |
| `discord_send_dm` | Send a DM to a user |
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

### Tools not appearing in Claude
- Restart Claude Desktop after editing config
- Check the path in `claude_desktop_config.json` is correct
- Check Claude Desktop logs for errors

---

## File Structure

```
discord-mcp-bot/
├── src/                    # Source code (TypeScript)
├── dist/                   # Compiled code (after npm run build)
├── .env                    # Your credentials (create from template)
├── .env.template           # Template for credentials
├── persona.md              # Your bot's personality (create from template)
├── persona.example.md      # Example persona
├── memory-ledger.json      # Conversation history (auto-created)
├── SETUP.md                # This file
└── README.md               # Architecture overview
```

---

## Questions?

Open an issue on GitHub!
