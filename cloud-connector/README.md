# Discord MCP Cloud Connector

A Cloudflare Worker that exposes your Discord bot as a remote MCP server. This lets you use Discord tools from **Claude.ai web/mobile** — no laptop required.

## What This Does

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Claude.ai     │     │  Cloudflare      │     │  Your Fly.io    │
│   (browser/     │ ──► │  Worker          │ ──► │  Discord Bot    │ ──► Discord
│    mobile)      │     │  (MCP adapter)   │     │  (HTTP API)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
      MCP Protocol           HTTP API
```

The Worker acts as a **translator**:
- Speaks MCP protocol to Claude.ai
- Forwards commands to your Fly.io bot's HTTP API
- Returns Discord responses back to Claude

## Prerequisites

**You must have the Fly.io bot running first.** This connector doesn't talk to Discord directly — it forwards everything to your deployed bot.

Make sure your Fly.io bot has:
- HTTP API enabled (`BOT_API_SECRET` set)
- The API accessible at a public URL

## Setup

### 1. Install Dependencies

```bash
cd cloud-connector
npm install
```

### 2. Configure Secrets

Create a `.dev.vars` file for local development:

```env
API_KEY=your_connector_api_key_here
BOT_API_URL=https://your-app.fly.dev
BOT_API_SECRET=your_fly_bot_secret
```

Generate a secure API key:
```bash
node -e "console.log('dmc_' + require('crypto').randomBytes(24).toString('hex'))"
```

### 3. Test Locally

```bash
npm run dev
```

Test the health endpoint:
```bash
curl http://localhost:8787/health
```

### 4. Deploy to Cloudflare

```bash
# Set secrets
npx wrangler secret put API_KEY
npx wrangler secret put BOT_API_URL
npx wrangler secret put BOT_API_SECRET

# Deploy
npm run deploy
```

### 5. Connect to Claude.ai

1. Go to [claude.ai](https://claude.ai) → Settings → Integrations
2. Add a new MCP server:
   - **Name:** Discord Bot
   - **URL:** `https://your-worker.workers.dev/mcp/YOUR_API_KEY`
   - Leave OAuth fields empty

The API key goes in the URL path — Claude.ai's connector UI doesn't have a Bearer token field.

## Authentication

The connector supports two auth methods:

1. **URL path** (recommended for Claude.ai): `/mcp/YOUR_API_KEY`
2. **Bearer header**: `Authorization: Bearer YOUR_API_KEY`

## Available Tools

All 26 Discord tools are available:

| Category | Tools |
|----------|-------|
| Messages | `read_messages`, `send_message`, `edit_message`, `delete_message`, `pin_message` |
| DMs | `send_dm`, `check_dms` (info only) |
| Attachments | `send_file`\*, `fetch_attachment`\* |
| Reactions | `add_reaction`, `get_reactions` |
| Polls | `create_poll` |
| Threads | `create_thread` |
| Forums | `create_forum_post`, `list_forum_threads` |
| Channels | `list_channels`, `create_channel`, `rename_channel`, `set_channel_topic`, `delete_channel`, `move_channel` |
| Categories | `create_category` |
| Moderation | `timeout_user`, `assign_role`, `remove_role` |
| Awareness | `check_mentions` (info only), `get_history`, `list_members`, `get_user_info`, `list_roles` |

**Note:** `check_mentions` and `check_dms` return helpful messages explaining that the cloud bot handles these automatically.

### Known Limitations

- **\*Attachment tools have limited functionality.** The Worker runs on Cloudflare's edge network, not your machine. `send_file` cannot read from your local filesystem — the `file_path` parameter refers to files on the Fly.io bot server only. `fetch_attachment` returns CDN URLs but saving files locally may not work depending on your client. If you need full file operations, consider running a local MCP server alongside this cloud connector for attachment handling.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `API_KEY` | Secret key for authenticating requests to this connector |
| `BOT_API_URL` | Your Fly.io bot's URL (e.g., `https://my-bot.fly.dev`) |
| `BOT_API_SECRET` | The `BOT_API_SECRET` from your Fly.io bot |

## SDK Version Note

This connector pins `@modelcontextprotocol/sdk` to version `1.25.3`. Later versions (1.26+) changed the transport behavior in ways that break stateless Worker patterns. If you upgrade, test thoroughly.

## Architecture Notes

**Why a separate Worker?**

The Fly.io bot already has an HTTP API, but it doesn't speak MCP protocol. Claude.ai's connector feature requires MCP Streamable HTTP. This Worker bridges the gap.

**Stateless Design**

Cloudflare Workers don't share memory across requests. Each request creates a fresh MCP server, pre-initializes it, then handles the tool call. This matches the stateless nature of Workers perfectly.

**Latency**

Expect ~200-400ms round-trip for tool calls (Worker → Fly.io → Discord → back). This is fine for Claude conversations but wouldn't work for real-time applications.
