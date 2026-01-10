# Discord MCP Bot Template

> ⚠️ **This is a TEMPLATE, not a finished product.**
>
> This repo exists as a **reference implementation** for building your own Discord bot with MCP (Model Context Protocol) integration. It is not production-ready software meant to be deployed as-is.
>
> **We encourage you to:**
> 1. **Try building your own first** — See [QUICK-START-GUIDE.md](QUICK-START-GUIDE.md)
> 2. **Use this as reference** when you get stuck
> 3. **Understand the code** before using it
>
> This template reflects how *we* built our bot — your needs may differ. Adapt, don't copy blindly.

---

A Discord bot that integrates with Claude Desktop/Code via MCP (Model Context Protocol), with an independent Claude API layer for autonomous responses.

## Architecture

This bot has **two independent response paths**:

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  PATH 1: MCP Tools (Claude Desktop/Code)                           │
│  ────────────────────────────────────────                          │
│  Claude Desktop/Code ←──MCP Protocol──→ MCP Server ←───→ Discord   │
│                                                                     │
│  • Claude uses tools to read/send messages                         │
│  • Requires Claude Desktop/Code to be open                         │
│  • Full control: Claude decides when/what to respond               │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  PATH 2: Claude API Auto-Response (Always Running)                 │
│  ─────────────────────────────────────────────────                 │
│  Discord @mention ───→ MCP Server ───→ Claude API ───→ Discord    │
│                                                                     │
│  • Bot detects @mentions and auto-responds via Anthropic API       │
│  • Works even when Claude Desktop is closed                        │
│  • Owner mentions: auto-respond with persona                       │
│  • Other mentions: DM notification to owner (no public response)   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Both paths share:**
- The same Discord bot connection
- The same memory ledger (conversation history)
- The same persona file (loaded from `~/.claude/CLAUDE.md` or `./persona.md`)

## Features

- **20+ MCP Tools**: Full Discord control — messages, channels, threads, forums, moderation, attachments
- **Autonomous API Responses**: Bot responds to @mentions even without Claude Desktop open
- **Presence Sync**: Bot mirrors owner's online/offline status
- **Owner Detection**: Different behavior for owner vs. other users
- **Memory Ledger**: Shared conversation history across both paths
- **Persona Loading**: Identity from `~/.claude/CLAUDE.md` or project `persona.md`

## Documentation

| Guide | Description |
|-------|-------------|
| [QUICK-START-GUIDE.md](QUICK-START-GUIDE.md) | **Start here.** Build a Discord bot from scratch, including MCP integration |
| [PERMISSIONS-GUIDE.md](PERMISSIONS-GUIDE.md) | Troubleshooting Discord permissions and intents |
| [SETUP.md](SETUP.md) | Setup instructions for this specific template |

## Quick Start

See [SETUP.md](SETUP.md) for detailed installation instructions.

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

## Trigger Logic

| Who @mentions the bot | Action |
|-----------------------|--------|
| **Owner** | Auto-respond via Claude API with persona + memory context |
| **Anyone else** | DM owner with notification, no response in channel |

## Memory System

Conversations are stored in `memory-ledger.json`:
- Chronological order (oldest first)
- Both MCP and API paths read/write to the same ledger
- Ensures continuity across sessions

## File Structure

```
discord-mcp-bot/
├── src/
│   ├── mcp-server.ts      # MCP server entry point
│   ├── discord-client.ts  # Discord.js client wrapper
│   ├── claude.ts          # Anthropic API client
│   ├── memory.ts          # Memory ledger management
│   ├── types.ts           # TypeScript types
│   └── index.ts           # Standalone entry point
├── dist/                  # Compiled JavaScript
├── memory-ledger.json     # Conversation storage
├── .env                   # Credentials
└── persona.md             # Bot personality (optional)
```

---

**Originally built by:** Anne & Chadrien Solance
