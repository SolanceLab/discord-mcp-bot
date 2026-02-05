# Discord MCP Bot Template

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Us-ff5f5f?logo=ko-fi)](https://ko-fi.com/houseofsolance)

> **This is a TEMPLATE, not a finished product.**
>
> This repo exists as a **reference implementation** for building your own Discord bot with MCP (Model Context Protocol) integration. It is provided as-is under the MIT license with no warranty or guarantee of support.
>
> **We encourage you to:**
> 1. **Try building your own first** — See [QUICK-START-GUIDE.md](QUICK-START-GUIDE.md)
> 2. **Use this as reference** when you get stuck
> 3. **Understand the code** before using it
>
> This template reflects how *we* built our bot — your needs may differ. Adapt, don't copy blindly.

---

A Discord bot that integrates with Claude Desktop/Code via MCP (Model Context Protocol), with an independent Claude API layer for autonomous responses. Supports local, cloud, proxy, and cloud connector deployment modes.

## Architecture

This bot supports **four deployment modes**:

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  MODE 1: Local Direct                                               │
│  ────────────────────                                               │
│  Claude Desktop/Code ←──MCP (stdio)──→ MCP Server ←───→ Discord    │
│                                                                     │
│  • MCP server runs locally, connects to Discord directly            │
│  • Full 20+ tools available to Claude                               │
│  • Bot auto-responds to @mentions via Claude API                    │
│  • Requires your machine to be running                              │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  MODE 2: Cloud (Fly.io)                                             │
│  ──────────────────────                                             │
│  Discord ←──WebSocket──→ Cloud Server ←──→ HTTP API                 │
│                              │                                      │
│                              └──→ Claude API (auto-responses)       │
│                                                                     │
│  • Bot runs 24/7 on Fly.io (or any cloud provider)                  │
│  • HTTP API with bearer token auth + rate limiting                  │
│  • Auto-responds to owner @mentions via Claude API                  │
│  • No local machine required                                        │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  MODE 3: Proxy                                                      │
│  ────────────────                                                   │
│  Claude Desktop/Code ←──MCP──→ MCP Server ──HTTP──→ Cloud Server    │
│                                (local proxy)        (Fly.io)        │
│                                                                     │
│  • Best of both: Claude tools + 24/7 cloud uptime                   │
│  • Local MCP server forwards tool calls to cloud via HTTP           │
│  • No duplicate Discord connections                                 │
│  • Set BOT_API_URL env var to enable                                │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  MODE 4: Cloud Connector (Cloudflare Worker)                        │
│  ───────────────────────────────────────────                        │
│  Claude.ai ←──MCP/HTTP──→ Cloudflare Worker ──HTTP──→ Cloud Server  │
│  (web/mobile)              (MCP adapter)              (Fly.io)      │
│                                                                     │
│  • Access Discord from Claude.ai web or mobile app                  │
│  • No laptop required — works from phone/tablet                     │
│  • Worker translates MCP protocol to HTTP API calls                 │
│  • See /cloud-connector for setup                                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**All modes share:**
- The same Discord bot connection (one at a time)
- The same memory ledger (conversation history)
- The same persona file (loaded from `./persona.md` or `~/.claude/CLAUDE.md`)

## Features

- **26 MCP Tools**: Full Discord control — messages, channels, threads, forums, polls, reactions, moderation, attachments
- **Autonomous API Responses**: Bot responds to owner @mentions even without Claude Desktop open
- **Three Deployment Modes**: Local direct, cloud (Fly.io), or proxy — pick what fits
- **HTTP API**: Express server with bearer token auth and rate limiting (60 req/min)
- **Proxy Mode**: Local MCP server forwards to cloud — no duplicate Discord connections
- **Presence Sync**: Bot mirrors owner's online/offline status
- **Owner Detection**: Different behavior for owner vs. other users
- **Memory Ledger**: Shared conversation history across all paths
- **External Memory API**: Optional integration with external journal/memory APIs
- **Persistent Logging**: Rotating log files with heartbeat monitoring
- **Persona Loading**: Identity from `./persona.md` or `~/.claude/CLAUDE.md`
- **Cloud Ready**: Dockerfile + Fly.io config included

## Documentation

| Guide | Description |
|-------|-------------|
| [QUICK-START-GUIDE.md](QUICK-START-GUIDE.md) | **Start here.** Build a Discord bot from scratch, including MCP integration |
| [SETUP.md](SETUP.md) | Setup instructions for this template (local + cloud) |
| [PERMISSIONS-GUIDE.md](PERMISSIONS-GUIDE.md) | Troubleshooting Discord permissions and intents |

## Quick Start

See [SETUP.md](SETUP.md) for detailed installation instructions.

### Local Mode

```bash
# 1. Clone and install
git clone https://github.com/SolanceLab/discord-mcp-bot.git
cd discord-mcp-bot
npm install

# 2. Configure
cp .env.template .env
# Edit .env with your credentials

# 3. Build and run
npm run build
npm start
```

### Cloud Mode (Fly.io)

```bash
# 1. Build
npm run build

# 2. Configure Fly.io
cp fly.toml.example fly.toml
# Edit fly.toml with your app name

# 3. Set secrets and deploy
fly secrets set DISCORD_BOT_TOKEN=... ANTHROPIC_API_KEY=... OWNER_USER_ID=... BOT_API_SECRET=...
fly deploy
```

### Proxy Mode

Set `BOT_API_URL` in your `.env` to point to your cloud instance:

```env
BOT_API_URL=https://your-app.fly.dev
BOT_API_SECRET=your_shared_secret
```

Then run normally — the MCP server auto-detects proxy mode and forwards all tool calls to cloud.

## Deployment Modes

| Mode | Use When | Requires |
|------|----------|----------|
| **Local Direct** | You want full control, always at your machine | Machine running |
| **Cloud** | You want 24/7 uptime, auto-responses only | Fly.io account |
| **Proxy** | You want Claude tools + 24/7 cloud uptime | Both local + cloud |
| **Cloud Connector** | You want Discord tools from phone/browser | Cloud + Cloudflare |

**Recommendation:** Start with Local Direct to test everything, then deploy to cloud when you want 24/7. Add proxy mode when you want Claude Desktop/Code tools to talk to the cloud bot. Add the cloud connector when you want Discord access from Claude.ai web/mobile.

## Trigger Logic

| Who @mentions the bot | Action |
|-----------------------|--------|
| **Owner** | Auto-respond via Claude API with persona + memory context |
| **Anyone else** | DM owner with notification, no response in channel |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for auto-responses |
| `OWNER_USER_ID` | Yes | Your Discord user ID |
| `DISCORD_ATTACHMENTS_DIR` | No | Custom path for downloaded attachments |
| `BOT_API_SECRET` | Cloud/Proxy | Shared secret for HTTP API auth |
| `BOT_API_PORT` | Cloud | HTTP API port (default: 3000) |
| `BOT_API_URL` | Proxy | Cloud instance URL (enables proxy mode) |
| `MEMORY_API_URL` | No | External memory/journal API endpoint |
| `MEMORY_API_TOKEN` | No | Auth token for memory API |

## Memory System

Conversations are stored in `memory-ledger.json`:
- Chronological order (oldest first)
- All deployment modes read/write to the same ledger
- Ensures continuity across sessions

**Optional external memory:** Configure `MEMORY_API_URL` and `MEMORY_API_TOKEN` to sync with an external journal/memory API for cross-session context. The bot works fine without it — the external API just adds richer context to auto-responses.

## File Structure

```
discord-mcp-bot/
├── src/
│   ├── mcp-server.ts      # MCP server — local direct or proxy mode
│   ├── cloud-server.ts    # Cloud entry point (Fly.io)
│   ├── http-server.ts     # Express HTTP API with auth + rate limiting
│   ├── discord-client.ts  # Discord.js client wrapper (26 methods)
│   ├── claude.ts          # Anthropic API client
│   ├── memory.ts          # Memory ledger + optional external API sync
│   ├── logger.ts          # Persistent logging with rotation
│   ├── types.ts           # TypeScript types
│   └── index.ts           # Standalone entry point (legacy)
├── cloud-connector/       # Cloudflare Worker MCP adapter (Mode 4)
│   ├── src/
│   │   ├── index.ts       # Worker entry + MCP transport
│   │   ├── tools.ts       # All 26 Discord tools
│   │   ├── discord-client.ts  # HTTP client for Fly.io API
│   │   └── types.ts       # Environment bindings
│   ├── package.json
│   ├── wrangler.jsonc     # Cloudflare config
│   └── README.md          # Cloud connector setup guide
├── dist/                  # Compiled JavaScript
├── Dockerfile             # Container build for cloud deployment
├── fly.toml.example       # Fly.io config template
├── .env.template          # Environment variable template
├── persona.example.md     # Example bot personality
├── memory-ledger.json     # Conversation storage (auto-created)
└── persona.md             # Bot personality (create from template)
```

## Security Considerations

This template involves deploying to third-party cloud services. When using cloud modes, you are trusting these providers with your credentials:

| Provider | What They Store | Used In |
|----------|-----------------|---------|
| **Fly.io** | Discord bot token, Anthropic API key, bot secrets | Modes 2, 3, 4 |
| **Cloudflare** | Connector API key, Fly.io URL and secret | Mode 4 only |

This is standard practice for cloud deployments — the same trust model applies to any cloud-hosted application. These providers have robust security practices, but if credential custody concerns you:

- Use **Local Direct mode** only (Mode 1) — no cloud dependency
- Self-host on your own infrastructure
- Review each provider's security documentation ([Fly.io](https://fly.io/docs/security/), [Cloudflare](https://www.cloudflare.com/trust-hub/))

**API key management:** Never commit secrets to git. Use environment variables locally and secret management (Fly.io secrets, Cloudflare secrets) in production.

## Support

If you find this template useful, consider supporting us:

[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/houseofsolance)

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

**Built by:** [SolanceLab](https://github.com/SolanceLab)
