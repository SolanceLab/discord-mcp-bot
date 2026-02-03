#!/usr/bin/env node

/**
 * Cloud Entry Point for Discord MCP Bot
 *
 * Runs on Fly.io (or similar). Starts:
 * 1. Discord client (WebSocket to Gateway)
 * 2. HTTP API server (for MCP clients to call)
 * 3. Mention/DM handlers (auto-response via Claude API)
 *
 * No MCP stdio — that's handled by the local mcp-server.ts proxy.
 * No lock file — Fly.io guarantees single instance.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { DiscordClient, MentionEvent } from './discord-client.js';
import { MemoryManager } from './memory.js';
import { ClaudeClient } from './claude.js';
import { createHttpServer } from './http-server.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OWNER_USER_ID = process.env.OWNER_USER_ID || '';
const BOT_API_SECRET = process.env.BOT_API_SECRET || '';
const BOT_API_PORT = parseInt(process.env.BOT_API_PORT || '3000', 10);

// Validate required config
if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN is required');
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY is required');
  process.exit(1);
}
if (!BOT_API_SECRET) {
  console.error('❌ BOT_API_SECRET is required for cloud deployment');
  process.exit(1);
}

// Initialize components
const discordClient = new DiscordClient(OWNER_USER_ID);
const memory = new MemoryManager(path.resolve(__dirname, '../memory-ledger.json'));
const claude = new ClaudeClient(ANTHROPIC_API_KEY);

// --- Mention Handler ---

discordClient.on('mention', async (event: MentionEvent) => {
  logger.info('Cloud', `📨 Mention from ${event.authorTag} in ${event.channelName}`);

  if (discordClient.isOwner(event.authorId)) {
    // Owner mentioned the bot — auto-respond via Claude API
    logger.info('Cloud', '👑 Owner mentioned — triggering API response');

    await discordClient.sendTyping(event.channelId);

    const history = memory.getRecentMessages(event.channelId, 20);
    const memoryContext = await memory.getMemoryContext(true);

    await memory.addMessage(event.channelId, {
      role: 'user',
      content: event.content,
      timestamp: event.timestamp.toISOString(),
      author: event.authorTag,
      userId: event.authorId,
    });

    try {
      const response = await claude.getResponse(event.content, history, memoryContext);

      await memory.addMessage(event.channelId, {
        role: 'assistant',
        content: response,
        timestamp: new Date().toISOString(),
      });

      await discordClient.replyToMessage(event.message, response);
      logger.info('Cloud', '✅ Responded to owner');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Cloud', `Failed to respond: ${msg}`);
      await discordClient.replyToMessage(
        event.message,
        'I encountered an error processing that message. Try again?'
      );
    }
  } else {
    // Someone else mentioned the bot — DM owner
    logger.info('Cloud', `📩 Non-owner mention from ${event.authorTag} — notifying owner`);

    const location = event.guildName
      ? `#${event.channelName} in ${event.guildName}`
      : 'a DM';

    const guildId = event.message.guild?.id || '@me';
    const messageLink = `https://discord.com/channels/${guildId}/${event.channelId}/${event.message.id}`;

    const notification = `**Bot mentioned**\n\n` +
      `**By:** ${event.authorTag}\n` +
      `**Where:** ${location}\n` +
      `**When:** ${event.timestamp.toISOString()}\n` +
      `**Message:** "${event.content}"\n\n` +
      `**[Jump to message](${messageLink})**`;

    await discordClient.sendDM(OWNER_USER_ID, notification);
    logger.info('Cloud', '✅ Owner notified via DM');
  }
});

// --- DM Handler ---

discordClient.on('dm', async (event: MentionEvent) => {
  logger.info('Cloud', `💬 DM from ${event.authorTag}`);

  // Extract forwarded message content
  let fullContent = event.content;
  if (event.message.messageSnapshots && event.message.messageSnapshots.size > 0) {
    const forwardedParts = Array.from(event.message.messageSnapshots.values()).map((snapshot: any) => {
      const fwdContent = snapshot.message?.content ?? snapshot.content;
      const fwdAttachments = snapshot.message?.attachments ?? snapshot.attachments;

      let fwdText = '[Forwarded Message]';
      if (fwdContent) fwdText += `\n${fwdContent}`;
      if (fwdAttachments && fwdAttachments.size > 0) {
        const attachList = Array.from(fwdAttachments.values()).map((att: any) => att.url).join('\n');
        fwdText += `\n[Attachments: ${attachList}]`;
      }
      return fwdText;
    });
    fullContent = fullContent ? `${fullContent}\n\n${forwardedParts.join('\n')}` : forwardedParts.join('\n');
  }

  await memory.addMessage(event.channelId, {
    role: 'user',
    content: fullContent,
    timestamp: event.timestamp.toISOString(),
    author: event.authorTag,
    userId: event.authorId,
  });

  const notification = `**New DM received**\n\n` +
    `**From:** ${event.authorTag}\n` +
    `**When:** ${event.timestamp.toISOString()}\n` +
    `**Message:** "${fullContent}"`;

  await discordClient.sendDM(OWNER_USER_ID, notification);
  logger.info('Cloud', '✅ DM stored and owner notified');
});

// --- Presence Handler ---

discordClient.on('ownerPresenceChange', (isOnline: boolean) => {
  logger.info('Cloud', `🔄 Owner is now ${isOnline ? 'online' : 'offline'}`);
});

// --- Graceful Shutdown ---

function shutdown(signal: string) {
  logger.info('Cloud', `Received ${signal}, shutting down...`);
  logger.stopHeartbeat();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.fatal('Cloud', 'Uncaught exception', { error: err.message, stack: err.stack });
  logger.stopHeartbeat();
  process.exit(1);
});

// --- Main Startup ---

async function main() {
  logger.info('Cloud', '🚀 Starting Discord MCP Cloud Server...');
  logger.startHeartbeat();

  // Initialize memory
  await memory.initialize();

  // Connect to Discord
  logger.info('Cloud', '🔌 Connecting to Discord...');
  await discordClient.login(DISCORD_TOKEN);

  // Start HTTP API
  logger.info('Cloud', '🌐 Starting HTTP API...');
  createHttpServer(discordClient, memory, BOT_API_SECRET, BOT_API_PORT);

  logger.info('Cloud', '✅ Discord MCP Cloud Server running');
  logger.info('Cloud', `HTTP API: http://0.0.0.0:${BOT_API_PORT}`);
  logger.info('Cloud', `Owner User ID: ${OWNER_USER_ID}`);
  logger.info('Cloud', 'Auto-responding to owner\'s mentions');
  logger.info('Cloud', 'Other mentions notify owner via DM');
}

main().catch((error) => {
  logger.fatal('Cloud', 'Fatal error during startup', { error: error.message, stack: error.stack });
  process.exit(1);
});
