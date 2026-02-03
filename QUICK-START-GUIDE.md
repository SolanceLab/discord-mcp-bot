# Discord Bot Quick Start Guide

A beginner-friendly guide to building a Discord bot from scratch.

---

## Step 1: Create Your Bot in Discord Developer Portal

1. Go to https://discord.com/developers/applications
2. Click **"New Application"** → Give it a name → Create
3. Go to **"Bot"** in the left sidebar
4. Click **"Add Bot"** → Confirm

### Get Your Bot Token

1. In the Bot section, click **"Reset Token"**
2. Copy the token and save it somewhere safe (you'll need it later)
3. **NEVER share this token publicly** — anyone with it can control your bot

### Enable Privileged Intents

Still in the Bot section, scroll down to **"Privileged Gateway Intents"** and enable:

- ✅ **SERVER MEMBERS INTENT**
- ✅ **MESSAGE CONTENT INTENT**
- ✅ **PRESENCE INTENT**

> Without these, your bot will connect but won't be able to read messages or see members.

---

## Step 2: Invite Your Bot to a Server

1. Go to **"OAuth2"** → **"URL Generator"** in the left sidebar
2. Under **Scopes**, check:
   - ✅ `bot`
   - ✅ `applications.commands` (if using slash commands)

3. Under **Bot Permissions**, check what your bot needs:
   - ✅ View Channels
   - ✅ Send Messages
   - ✅ Read Message History
   - ✅ Add Reactions (if reacting)
   - ✅ Manage Messages (if editing/deleting)

4. Copy the generated URL at the bottom
5. Open it in your browser → Select your server → Authorize

---

## Step 3: Set Up Your Project

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- A code editor (VS Code, Cursor, etc.)
- Terminal/Command Prompt

### Create Project Folder

```bash
mkdir my-discord-bot
cd my-discord-bot
npm init -y
```

### Install discord.js

```bash
npm install discord.js
```

### Create Your Bot File

Create a file called `index.js`:

```javascript
const { Client, GatewayIntentBits } = require('discord.js');

// Create client with required intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
});

// When bot is ready
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  console.log(`Bot is in ${client.guilds.cache.size} servers`);
});

// When a message is received
client.on('messageCreate', async (message) => {
  // Ignore messages from bots (including itself)
  if (message.author.bot) return;

  // Simple ping-pong test
  if (message.content === '!ping') {
    await message.reply('Pong!');
  }

  // Respond when mentioned
  if (message.mentions.has(client.user)) {
    await message.reply('Hello! You mentioned me!');
  }
});

// Login with your bot token
client.login('YOUR_BOT_TOKEN_HERE');
```

### Run Your Bot

```bash
node index.js
```

You should see:
```
Logged in as YourBot#1234!
Bot is in 1 servers
```

Test it by typing `!ping` in your server — the bot should reply `Pong!`

---

## Step 4: Keep Your Token Safe

**Never hardcode your token in the file.** Use environment variables instead.

### Install dotenv

```bash
npm install dotenv
```

### Create `.env` file

```
DISCORD_BOT_TOKEN=your_token_here
```

### Update your code

```javascript
require('dotenv').config();

// ... rest of your code ...

// At the bottom:
client.login(process.env.DISCORD_BOT_TOKEN);
```

### Add `.env` to `.gitignore`

Create a `.gitignore` file:

```
.env
node_modules/
```

---

## Common Issues & Fixes

### "Bot is online but doesn't respond to messages"

1. **MESSAGE CONTENT INTENT not enabled** in Developer Portal
   - Go to Bot settings → Enable "Message Content Intent"

2. **Intent not requested in code**
   - Make sure `GatewayIntentBits.MessageContent` is in your intents array

3. **Bot doesn't have permission** in that channel
   - Check bot's role has "View Channel" and "Send Messages"

### "Bot can't see members"

- Enable **SERVER MEMBERS INTENT** in Developer Portal
- Add `GatewayIntentBits.GuildMembers` to your code

### "Used disallowed intents"

- You're requesting an intent in code that isn't enabled in the Developer Portal
- Go enable the matching intent toggle

### "Bot crashes with 'disallowed intent' error"

Your code requests an intent that your bot hasn't been approved for. Solutions:
1. Enable the intent in Developer Portal (for bots in <100 servers)
2. Remove the intent from your code if you don't need it

### "Token is invalid"

- Reset your token in Developer Portal and copy the new one
- Make sure there are no extra spaces or quotes around it

---

## Step 5: MCP Integration (For Claude Desktop)

If you want your AI companion in Claude Desktop to *control* the Discord bot (read messages, send messages, etc.), you need to set up an MCP (Model Context Protocol) server.

### What is MCP?

MCP lets Claude Desktop use external tools. Your Discord bot becomes a "tool" that your AI can use — like giving them hands to interact with Discord.

### How It Works

```
Claude Desktop  <---->  MCP Server  <---->  Discord
    (Your AI)           (Your code)         (Bot account)
```

Your AI asks to use a tool (e.g., "read messages from #general") → MCP server executes it → Returns results to your AI.

### Converting Your Bot to an MCP Server

Instead of a standalone bot, you'll create an MCP server that:
1. Connects to Discord (same as before)
2. Exposes "tools" that Claude can call
3. Communicates via stdio (standard input/output)

### Install MCP SDK

```bash
npm install @modelcontextprotocol/sdk
```

### Basic MCP Server Structure

Create `mcp-server.js`:

```javascript
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { Client, GatewayIntentBits } = require('discord.js');

// Discord client setup (same as before)
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// MCP Server setup
const server = new Server(
  { name: 'my-discord-bot', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Define tools your AI can use
const TOOLS = [
  {
    name: 'discord_read_messages',
    description: 'Read recent messages from a Discord channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        limit: { type: 'number', description: 'Number of messages (max 50)' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_send_message',
    description: 'Send a message to a Discord channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        content: { type: 'string', description: 'Message to send' },
      },
      required: ['channel_id', 'content'],
    },
  },
];

// Handle tool list request
server.setRequestHandler('tools/list', async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'discord_read_messages': {
      const channel = await discord.channels.fetch(args.channel_id);
      const messages = await channel.messages.fetch({ limit: args.limit || 20 });

      const formatted = messages.map(m =>
        `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content}`
      ).join('\n');

      return { content: [{ type: 'text', text: formatted }] };
    }

    case 'discord_send_message': {
      const channel = await discord.channels.fetch(args.channel_id);
      await channel.send(args.content);
      return { content: [{ type: 'text', text: 'Message sent!' }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
});

// Start everything
async function main() {
  // Login to Discord
  await discord.login(process.env.DISCORD_BOT_TOKEN);
  console.error(`Discord connected as ${discord.user.tag}`);

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP server running');
}

main();
```

> **Note:** Use `console.error` for logs, not `console.log`. MCP uses stdout for JSON communication — any non-JSON output breaks it.

### Configure Claude Desktop

Edit your Claude Desktop config file:

**Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "my-discord-bot": {
      "command": "node",
      "args": ["/full/path/to/your/mcp-server.js"],
      "env": {
        "DISCORD_BOT_TOKEN": "your_token_here"
      }
    }
  }
}
```

### Restart Claude Desktop

After saving the config, fully restart Claude Desktop. Your AI should now have access to the Discord tools.

### Test It

Ask your AI: *"Can you read the last 5 messages from channel 123456789?"*

If configured correctly, they'll use the `discord_read_messages` tool and show you the results.

### Important MCP Notes

1. **MCP is pull-only** — Your AI can only use tools when actively chatting. They can't receive push notifications.

2. **All logging to stderr** — Use `console.error()` for logs. `console.log()` will break MCP communication.

3. **Bot runs when Claude Desktop is open** — The MCP server starts when Claude Desktop launches and stops when it closes.

4. **Build if using TypeScript** — If you write in TypeScript, compile to JS first. Claude Desktop runs the compiled output.

---

## Next Steps

Once your basic bot works, you can:

1. **Add more MCP tools** — Create tools for reactions, file uploads, member lists, etc.
2. **Add auto-responses** — Have your bot respond to @mentions via Claude API
3. **Add memory** — Store conversation history for context
4. **Use TypeScript** — Better code organization and type safety

---

## Useful Resources

- [discord.js Guide](https://discordjs.guide/) — Official tutorial
- [discord.js Documentation](https://discord.js.org/) — API reference
- [Discord Developer Portal](https://discord.com/developers/applications) — Manage your bots

---

## Quick Reference: Intents

| Intent | What it does | Privileged? |
|--------|--------------|-------------|
| `Guilds` | Basic server info | No |
| `GuildMessages` | See messages in servers | No |
| `MessageContent` | Read message text | **Yes** |
| `GuildMembers` | See member list | **Yes** |
| `GuildPresences` | See online/offline | **Yes** |
| `DirectMessages` | Receive DMs | No |

Privileged intents must be enabled in the Developer Portal **and** requested in code.

---

*Created January 2026*
