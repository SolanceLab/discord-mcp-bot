#!/usr/bin/env node

/**
 * Discord MCP Server
 *
 * Operates in two modes:
 *
 * 1. DIRECT MODE (default)
 *    - Connects directly to Discord via WebSocket
 *    - Runs all tools locally through discord.js
 *    - Optionally starts HTTP API for multi-client sharing
 *    - Uses lock file to prevent duplicate instances
 *
 * 2. PROXY MODE (when BOT_API_URL is set)
 *    - No Discord connection — just MCP stdio
 *    - Forwards tool calls to a remote HTTP API server
 *    - Lightweight: no lock, no heartbeat, no Discord client
 *    - Used by Claude Desktop/Code when the bot runs in the cloud
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { DiscordClient, MentionEvent } from './discord-client.js';
import { MemoryManager } from './memory.js';
import { ClaudeClient } from './claude.js';
import { createHttpServer } from './http-server.js';
import { logger } from './logger.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ============================================================
// Lock Mechanism — prevents duplicate instances in direct mode
// ============================================================

const LOCK_FILE = '/tmp/discord-mcp-bot.lock';
const PROCESS_PATTERN = 'discord-mcp-bot/dist/mcp-server.js';

/**
 * Kill any orphaned processes matching our pattern, then acquire a lock file.
 * This prevents the "two bots" problem when Claude Desktop restarts the MCP.
 */
function acquireLock(): void {
  // 1. Kill any orphan processes from previous runs
  try {
    const result = execSync(
      `ps aux | grep "${PROCESS_PATTERN}" | grep -v grep | awk '{print $2}'`,
      { encoding: 'utf-8' }
    ).trim();

    if (result) {
      const pids = result.split('\n').filter(p => p && p !== String(process.pid));
      for (const pid of pids) {
        try {
          logger.warn('Lock', `Killing orphan process ${pid}`);
          process.kill(parseInt(pid, 10), 'SIGTERM');
        } catch {
          // Process already dead — ignore
        }
      }
      // Brief pause to let old processes release resources
      if (pids.length > 0) {
        execSync('sleep 1');
      }
    }
  } catch {
    // ps/grep failed — not critical
  }

  // 2. Check existing lock file
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
      const oldPid = lockData.pid;

      // Check if process is still alive
      try {
        process.kill(oldPid, 0); // Signal 0 = just check existence
        // Process exists — kill it
        logger.warn('Lock', `Killing previous instance (PID ${oldPid})`);
        process.kill(oldPid, 'SIGTERM');
        execSync('sleep 1');
      } catch {
        // Process already dead — just clean up the stale lock
        logger.info('Lock', `Removing stale lock (PID ${oldPid} no longer running)`);
      }
    } catch {
      // Corrupt lock file — just remove it
      logger.warn('Lock', 'Removing corrupt lock file');
    }

    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      // Ignore
    }
  }

  // 3. Write our lock
  const lockData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    pattern: PROCESS_PATTERN,
  };
  fs.writeFileSync(LOCK_FILE, JSON.stringify(lockData, null, 2));
  logger.info('Lock', `Acquired lock (PID ${process.pid})`);
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
      // Only remove if it's our lock
      if (lockData.pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
        logger.info('Lock', 'Released lock');
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// ============================================================
// Cleanup Handlers
// ============================================================

function shutdown(signal: string): void {
  logger.info('Shutdown', `Received ${signal}, cleaning up...`);
  logger.stopHeartbeat();
  releaseLock();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.fatal('Process', 'Uncaught exception', { error: err.message, stack: err.stack });
  logger.stopHeartbeat();
  releaseLock();
  process.exit(1);
});

// ============================================================
// Configuration
// ============================================================

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OWNER_USER_ID = process.env.OWNER_USER_ID || '';
const BOT_API_SECRET = process.env.BOT_API_SECRET || '';
const BOT_API_PORT = parseInt(process.env.BOT_API_PORT || '3000', 10);
const BOT_API_URL = process.env.BOT_API_URL || '';
const PROXY_MODE = !!BOT_API_URL;

// ============================================================
// Proxy Helper — forwards tool calls to remote HTTP API
// ============================================================

async function proxyRequest(endpoint: string, body: Record<string, any>): Promise<any> {
  const url = `${BOT_API_URL}${endpoint}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BOT_API_SECRET}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg: string;
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error || errorText;
      } catch {
        errorMsg = errorText;
      }
      return { error: `HTTP ${response.status}: ${errorMsg}` };
    }

    return await response.json();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { error: `Proxy request failed: ${msg}` };
  }
}

// ============================================================
// Component Initialization
// ============================================================

// In proxy mode we don't need Discord or Claude clients
const discordClient = PROXY_MODE ? null! : new DiscordClient(OWNER_USER_ID);
const memory = new MemoryManager(path.resolve(__dirname, '../memory-ledger.json'));
const claude = PROXY_MODE ? null! : new ClaudeClient(ANTHROPIC_API_KEY);

// Store pending mentions and DMs for MCP tools (direct mode only)
const pendingMentions: MentionEvent[] = [];
const pendingDMs: MentionEvent[] = [];

// ============================================================
// MCP Server
// ============================================================

const server = new Server(
  {
    name: 'discord-mcp',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ============================================================
// Tool Definitions
// ============================================================

const TOOLS = [
  {
    name: 'discord_read_messages',
    description: 'Read recent messages from a Discord channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The Discord channel ID to read from',
        },
        limit: {
          type: 'number',
          description: 'Number of messages to fetch (max 50, default 20)',
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_send_message',
    description: 'Send a message to a Discord channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The Discord channel ID to send to',
        },
        content: {
          type: 'string',
          description: 'The message content to send',
        },
      },
      required: ['channel_id', 'content'],
    },
  },
  {
    name: 'discord_send_dm',
    description: 'Send a direct message to a Discord user',
    inputSchema: {
      type: 'object' as const,
      properties: {
        user_id: {
          type: 'string',
          description: 'The Discord user ID to DM',
        },
        content: {
          type: 'string',
          description: 'The message content to send',
        },
      },
      required: ['user_id', 'content'],
    },
  },
  {
    name: 'discord_send_file',
    description: 'Send a file attachment to a Discord channel. The file can be provided as a base64-encoded string or a file path.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The Discord channel ID to send to',
        },
        file_data: {
          type: 'string',
          description: 'Base64-encoded file data',
        },
        file_path: {
          type: 'string',
          description: 'Path to a local file to send (alternative to file_data)',
        },
        file_name: {
          type: 'string',
          description: 'The filename to use for the attachment',
        },
        content: {
          type: 'string',
          description: 'Optional message text to accompany the file',
        },
      },
      required: ['channel_id', 'file_name'],
    },
  },
  {
    name: 'discord_check_mentions',
    description: 'Check if anyone has @mentioned the bot since last check',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'discord_check_dms',
    description: 'Check for incoming DM messages sent to the bot since last check',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'discord_get_history',
    description: 'Get conversation history from the memory ledger for a channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The Discord channel ID',
        },
        limit: {
          type: 'number',
          description: 'Number of messages to retrieve (default 20)',
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_list_channels',
    description: 'List all channels in a Discord server, organized by category',
    inputSchema: {
      type: 'object' as const,
      properties: {
        server_id: {
          type: 'string',
          description: 'The Discord server/guild ID',
        },
      },
      required: ['server_id'],
    },
  },
  // ============================================
  // Priority 1: Channel & Category Management
  // ============================================
  {
    name: 'discord_create_channel',
    description: 'Create a new channel in a server',
    inputSchema: {
      type: 'object' as const,
      properties: {
        server_id: {
          type: 'string',
          description: 'The Discord server/guild ID',
        },
        name: {
          type: 'string',
          description: 'Channel name (will be lowercased, spaces become hyphens)',
        },
        type: {
          type: 'string',
          enum: ['text', 'voice', 'forum', 'announcement'],
          description: 'Channel type (default: text)',
        },
        category_id: {
          type: 'string',
          description: 'Optional: Parent category ID to place channel under',
        },
        topic: {
          type: 'string',
          description: 'Optional: Channel topic/description',
        },
        nsfw: {
          type: 'boolean',
          description: 'Optional: Mark channel as age-restricted (default: false)',
        },
      },
      required: ['server_id', 'name'],
    },
  },
  {
    name: 'discord_set_channel_topic',
    description: 'Set or update a channel\'s topic/description',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel ID to update',
        },
        topic: {
          type: 'string',
          description: 'New topic/description (max 1024 characters)',
        },
      },
      required: ['channel_id', 'topic'],
    },
  },
  {
    name: 'discord_rename_channel',
    description: 'Rename an existing channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel ID to rename',
        },
        new_name: {
          type: 'string',
          description: 'New channel name',
        },
      },
      required: ['channel_id', 'new_name'],
    },
  },
  {
    name: 'discord_delete_channel',
    description: 'Delete a channel (use with caution)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel ID to delete',
        },
        reason: {
          type: 'string',
          description: 'Optional: Reason for deletion (appears in audit log)',
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_create_category',
    description: 'Create a new category',
    inputSchema: {
      type: 'object' as const,
      properties: {
        server_id: {
          type: 'string',
          description: 'The Discord server/guild ID',
        },
        name: {
          type: 'string',
          description: 'Category name',
        },
        position: {
          type: 'number',
          description: 'Optional: Position in the channel list (0 = top)',
        },
      },
      required: ['server_id', 'name'],
    },
  },
  {
    name: 'discord_move_channel',
    description: 'Move a channel to a different category or position',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel ID to move',
        },
        category_id: {
          type: 'string',
          description: 'Optional: New parent category ID (null to remove from category)',
        },
        position: {
          type: 'number',
          description: 'Optional: New position within the category',
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_add_reaction',
    description: 'Add a reaction to a message',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel ID containing the message',
        },
        message_id: {
          type: 'string',
          description: 'The message ID to react to',
        },
        emoji: {
          type: 'string',
          description: 'Emoji to react with (unicode emoji or custom emoji string)',
        },
      },
      required: ['channel_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'discord_get_reactions',
    description: 'Get all reactions on a message',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel ID containing the message',
        },
        message_id: {
          type: 'string',
          description: 'The message ID to get reactions from',
        },
      },
      required: ['channel_id', 'message_id'],
    },
  },
  {
    name: 'discord_create_poll',
    description: 'Create a poll in a Discord channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel ID to create the poll in',
        },
        question: {
          type: 'string',
          description: 'The poll question',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of poll options (minimum 2)',
        },
        duration_hours: {
          type: 'number',
          description: 'How long the poll lasts in hours (default 24)',
        },
        allow_multiselect: {
          type: 'boolean',
          description: 'Whether users can select multiple options (default false)',
        },
      },
      required: ['channel_id', 'question', 'options'],
    },
  },
  // ============================================
  // Priority 2: Message Management
  // ============================================
  {
    name: 'discord_edit_message',
    description: 'Edit a message sent by the bot',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel ID containing the message',
        },
        message_id: {
          type: 'string',
          description: 'The message ID to edit',
        },
        new_content: {
          type: 'string',
          description: 'New message content',
        },
      },
      required: ['channel_id', 'message_id', 'new_content'],
    },
  },
  {
    name: 'discord_delete_message',
    description: 'Delete a message (own messages or others with permission)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel ID containing the message',
        },
        message_id: {
          type: 'string',
          description: 'The message ID to delete',
        },
      },
      required: ['channel_id', 'message_id'],
    },
  },
  {
    name: 'discord_pin_message',
    description: 'Pin a message in a channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel ID containing the message',
        },
        message_id: {
          type: 'string',
          description: 'The message ID to pin',
        },
      },
      required: ['channel_id', 'message_id'],
    },
  },
  {
    name: 'discord_create_thread',
    description: 'Create a thread from a message or as a standalone thread',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel ID to create thread in',
        },
        name: {
          type: 'string',
          description: 'Thread name',
        },
        message_id: {
          type: 'string',
          description: 'Optional: Message ID to start thread from',
        },
        auto_archive_duration: {
          type: 'number',
          enum: [60, 1440, 4320, 10080],
          description: 'Optional: Minutes until auto-archive (60, 1440, 4320, 10080)',
        },
      },
      required: ['channel_id', 'name'],
    },
  },
  {
    name: 'discord_create_forum_post',
    description: 'Create a new post in a forum channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The forum channel ID',
        },
        title: {
          type: 'string',
          description: 'Post title (becomes the thread name)',
        },
        content: {
          type: 'string',
          description: 'Initial message content for the post',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: Array of tag IDs to apply to the post',
        },
      },
      required: ['channel_id', 'title', 'content'],
    },
  },
  {
    name: 'discord_list_forum_threads',
    description: 'List threads/posts in a forum channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The forum channel ID',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of threads to return (default 20)',
        },
        include_archived: {
          type: 'boolean',
          description: 'Include archived threads (default false)',
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_fetch_attachment',
    description: 'Download attachment(s) from a Discord message to local filesystem for viewing',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel ID where the message exists',
        },
        message_id: {
          type: 'string',
          description: 'The message ID containing the attachment(s)',
        },
        filename: {
          type: 'string',
          description: 'Specific filename to download if message has multiple attachments. If omitted, downloads all.',
        },
      },
      required: ['channel_id', 'message_id'],
    },
  },
  // ============================================
  // Priority 3: Moderation
  // ============================================
  {
    name: 'discord_timeout_user',
    description: 'Timeout (mute) a user temporarily',
    inputSchema: {
      type: 'object' as const,
      properties: {
        server_id: {
          type: 'string',
          description: 'The server/guild ID',
        },
        user_id: {
          type: 'string',
          description: 'The user ID to timeout',
        },
        duration_minutes: {
          type: 'number',
          description: 'Timeout duration in minutes (max 40320 = 28 days)',
        },
        reason: {
          type: 'string',
          description: 'Optional: Reason for timeout',
        },
      },
      required: ['server_id', 'user_id', 'duration_minutes'],
    },
  },
  {
    name: 'discord_assign_role',
    description: 'Assign a role to a user',
    inputSchema: {
      type: 'object' as const,
      properties: {
        server_id: {
          type: 'string',
          description: 'The server/guild ID',
        },
        user_id: {
          type: 'string',
          description: 'The user ID',
        },
        role_id: {
          type: 'string',
          description: 'The role ID to assign',
        },
        reason: {
          type: 'string',
          description: 'Optional: Reason for role assignment',
        },
      },
      required: ['server_id', 'user_id', 'role_id'],
    },
  },
  {
    name: 'discord_remove_role',
    description: 'Remove a role from a user',
    inputSchema: {
      type: 'object' as const,
      properties: {
        server_id: {
          type: 'string',
          description: 'The server/guild ID',
        },
        user_id: {
          type: 'string',
          description: 'The user ID',
        },
        role_id: {
          type: 'string',
          description: 'The role ID to remove',
        },
        reason: {
          type: 'string',
          description: 'Optional: Reason for role removal',
        },
      },
      required: ['server_id', 'user_id', 'role_id'],
    },
  },
  // ============================================
  // Priority 4: Awareness
  // ============================================
  {
    name: 'discord_list_members',
    description: 'List members in a server',
    inputSchema: {
      type: 'object' as const,
      properties: {
        server_id: {
          type: 'string',
          description: 'The server/guild ID',
        },
        limit: {
          type: 'number',
          description: 'Optional: Max members to return (default 100)',
        },
      },
      required: ['server_id'],
    },
  },
  {
    name: 'discord_get_user_info',
    description: 'Get detailed information about a user',
    inputSchema: {
      type: 'object' as const,
      properties: {
        server_id: {
          type: 'string',
          description: 'The server/guild ID',
        },
        user_id: {
          type: 'string',
          description: 'The user ID',
        },
      },
      required: ['server_id', 'user_id'],
    },
  },
  {
    name: 'discord_list_roles',
    description: 'List all roles in a server',
    inputSchema: {
      type: 'object' as const,
      properties: {
        server_id: {
          type: 'string',
          description: 'The server/guild ID',
        },
      },
      required: ['server_id'],
    },
  },
];

// ============================================================
// Tool-to-Endpoint Map (for proxy mode)
// ============================================================

const TOOL_TO_ENDPOINT: Record<string, string> = {
  discord_read_messages: '/api/read-messages',
  discord_send_message: '/api/send-message',
  discord_send_dm: '/api/send-dm',
  discord_send_file: '/api/send-file',
  discord_get_history: '/api/get-history',
  discord_list_channels: '/api/list-channels',
  discord_create_channel: '/api/create-channel',
  discord_set_channel_topic: '/api/set-channel-topic',
  discord_rename_channel: '/api/rename-channel',
  discord_delete_channel: '/api/delete-channel',
  discord_create_category: '/api/create-category',
  discord_move_channel: '/api/move-channel',
  discord_add_reaction: '/api/add-reaction',
  discord_get_reactions: '/api/get-reactions',
  discord_create_poll: '/api/create-poll',
  discord_edit_message: '/api/edit-message',
  discord_delete_message: '/api/delete-message',
  discord_pin_message: '/api/pin-message',
  discord_create_thread: '/api/create-thread',
  discord_create_forum_post: '/api/create-forum-post',
  discord_list_forum_threads: '/api/list-forum-threads',
  discord_timeout_user: '/api/timeout-user',
  discord_assign_role: '/api/assign-role',
  discord_remove_role: '/api/remove-role',
  discord_list_members: '/api/list-members',
  discord_get_user_info: '/api/get-user-info',
  discord_list_roles: '/api/list-roles',
};

// ============================================================
// Proxy Mode: Tool Call Handler
// ============================================================

/**
 * Handle a tool call by proxying it to the remote HTTP API.
 * Returns the MCP-formatted response.
 */
async function handleProxyToolCall(
  name: string,
  args: Record<string, any> | undefined
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {

  // These tools don't exist in cloud mode — the cloud bot handles them automatically
  if (name === 'discord_check_mentions' || name === 'discord_check_dms') {
    return {
      content: [{
        type: 'text',
        text: 'Not available in cloud proxy mode. The cloud bot handles mentions and DMs automatically (auto-responds to owner, DMs notifications for others).',
      }],
    };
  }

  // discord_fetch_attachment needs special handling in proxy mode
  if (name === 'discord_fetch_attachment') {
    return handleProxyFetchAttachment(args || {});
  }

  // Look up the endpoint
  const endpoint = TOOL_TO_ENDPOINT[name];
  if (!endpoint) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  // Forward to the HTTP API
  const result = await proxyRequest(endpoint, args || {});

  if (result.error) {
    return {
      content: [{ type: 'text', text: `Error: ${result.error}` }],
      isError: true,
    };
  }

  // Format the response based on the tool
  return formatProxyResponse(name, result);
}

/**
 * Handle discord_fetch_attachment in proxy mode.
 * In proxy mode, we fetch CDN URLs from the API and download locally.
 */
async function handleProxyFetchAttachment(
  args: Record<string, any>
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const channelId = args.channel_id as string;
  const messageId = args.message_id as string;
  const filename = args.filename as string | undefined;

  if (!channelId || !messageId) {
    return {
      content: [{ type: 'text', text: 'channel_id and message_id are required.' }],
    };
  }

  // Step 1: Get CDN URLs from the cloud API
  const result = await proxyRequest('/api/get-attachment-urls', {
    channel_id: channelId,
    message_id: messageId,
    filename,
  });

  if (result.error) {
    return {
      content: [{ type: 'text', text: `Error: ${result.error}` }],
    };
  }

  if (!result.attachments || result.attachments.length === 0) {
    return {
      content: [{ type: 'text', text: 'No attachments found on this message.' }],
    };
  }

  // Step 2: Download each file locally
  const cacheDir = process.env.DISCORD_ATTACHMENTS_DIR ||
    path.resolve(__dirname, '../.discord_attachments');

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const downloaded: string[] = [];
  const errors: string[] = [];

  for (const att of result.attachments) {
    const safeName = (att.name || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_');
    const localPath = path.join(cacheDir, `${messageId}_${safeName}`);

    try {
      const resp = await fetch(att.url);
      if (!resp.ok) {
        errors.push(`Failed to download ${att.name}: HTTP ${resp.status}`);
        continue;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(localPath, buffer);
      downloaded.push(localPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to download ${att.name}: ${msg}`);
    }
  }

  if (downloaded.length > 0) {
    const fileList = downloaded.map(p => `  - ${p}`).join('\n');
    let response = `Downloaded ${downloaded.length} attachment(s) locally:\n${fileList}`;
    if (errors.length > 0) {
      response += `\n\nWarnings:\n${errors.map(e => `  - ${e}`).join('\n')}`;
    }
    return { content: [{ type: 'text', text: response }] };
  }

  return {
    content: [{
      type: 'text',
      text: `Failed to download attachments:\n${errors.map(e => `  - ${e}`).join('\n')}`,
    }],
  };
}

/**
 * Format raw HTTP API responses into user-friendly MCP text.
 */
function formatProxyResponse(
  toolName: string,
  result: any
): { content: Array<{ type: string; text: string }> } {

  switch (toolName) {
    case 'discord_read_messages': {
      if (!result.messages || result.messages.length === 0) {
        return { content: [{ type: 'text', text: 'No messages found or channel not accessible.' }] };
      }
      const formatted = result.messages.map((msg: any) => {
        let text = `[${msg.timestamp}] (${msg.id}) ${msg.author}: ${msg.content}`;
        if (msg.attachments && msg.attachments.length > 0) {
          const attachmentList = msg.attachments.map((att: any) => {
            const info = [`  - ${att.name}`];
            if (att.contentType) info.push(`type: ${att.contentType}`);
            if (att.width && att.height) info.push(`${att.width}x${att.height}`);
            info.push(`url: ${att.url}`);
            return info.join(' | ');
          }).join('\n');
          text += `\n[Attachments]\n${attachmentList}`;
        }
        return text;
      }).join('\n\n');
      return { content: [{ type: 'text', text: formatted }] };
    }

    case 'discord_send_message': {
      if (result.success) {
        return { content: [{ type: 'text', text: `Message sent successfully.\nMessage ID: ${result.message_id}` }] };
      }
      return { content: [{ type: 'text', text: 'Failed to send message.' }] };
    }

    case 'discord_send_dm': {
      if (result.success) {
        return { content: [{ type: 'text', text: `DM sent successfully.\nMessage ID: ${result.message_id}` }] };
      }
      return { content: [{ type: 'text', text: 'Failed to send DM.' }] };
    }

    case 'discord_send_file': {
      if (result.success) {
        return { content: [{ type: 'text', text: `File sent successfully.\nMessage ID: ${result.message_id}` }] };
      }
      return { content: [{ type: 'text', text: 'Failed to send file.' }] };
    }

    case 'discord_get_history': {
      if (!result.messages || result.messages.length === 0) {
        return { content: [{ type: 'text', text: 'No conversation history for this channel.' }] };
      }
      const formatted = result.messages.map((msg: any) => {
        const author = msg.author || (msg.role === 'assistant' ? 'Bot' : 'User');
        return `[${msg.timestamp}] ${author}: ${msg.content}`;
      }).join('\n\n');
      return { content: [{ type: 'text', text: formatted }] };
    }

    case 'discord_list_channels': {
      if (!result.serverName) {
        return { content: [{ type: 'text', text: 'Server not found or not accessible.' }] };
      }
      let formatted = `**${result.serverName}** (${result.serverId})\n\n`;
      if (result.categories) {
        for (const category of result.categories) {
          formatted += `**${category.name}**\n`;
          for (const channel of category.channels) {
            const icon = channel.type === 'voice' ? '(voice)' :
                         channel.type === 'forum' ? '(forum)' :
                         channel.type === 'announcement' ? '(announcement)' :
                         channel.type === 'stage' ? '(stage)' : '#';
            formatted += `   ${icon} ${channel.name} (${channel.id}) [${channel.type}]\n`;
          }
          formatted += '\n';
        }
      }
      if (result.uncategorized && result.uncategorized.length > 0) {
        formatted += `**Uncategorized**\n`;
        for (const channel of result.uncategorized) {
          formatted += `   # ${channel.name} (${channel.id}) [${channel.type}]\n`;
        }
      }
      return { content: [{ type: 'text', text: formatted }] };
    }

    case 'discord_create_channel': {
      if (result.success) {
        return { content: [{ type: 'text', text: `Created channel #${result.name} (${result.id})` }] };
      }
      return { content: [{ type: 'text', text: 'Failed to create channel.' }] };
    }

    case 'discord_set_channel_topic': {
      return { content: [{ type: 'text', text: result.success ? 'Channel topic updated.' : 'Failed to update channel topic.' }] };
    }

    case 'discord_rename_channel': {
      return { content: [{ type: 'text', text: result.success ? 'Channel renamed.' : 'Failed to rename channel.' }] };
    }

    case 'discord_delete_channel': {
      return { content: [{ type: 'text', text: result.success ? 'Channel deleted.' : 'Failed to delete channel.' }] };
    }

    case 'discord_create_category': {
      if (result.success) {
        return { content: [{ type: 'text', text: `Created category ${result.name} (${result.id})` }] };
      }
      return { content: [{ type: 'text', text: 'Failed to create category.' }] };
    }

    case 'discord_move_channel': {
      return { content: [{ type: 'text', text: result.success ? 'Channel moved.' : 'Failed to move channel.' }] };
    }

    case 'discord_add_reaction': {
      return { content: [{ type: 'text', text: result.success ? 'Reaction added.' : 'Failed to add reaction.' }] };
    }

    case 'discord_get_reactions': {
      if (!result.reactions) {
        return { content: [{ type: 'text', text: 'Failed to get reactions.' }] };
      }
      if (result.reactions.length === 0) {
        return { content: [{ type: 'text', text: 'No reactions on this message.' }] };
      }
      const formatted = result.reactions.map((r: any) =>
        `${r.emoji}: ${r.count} reaction(s)`
      ).join('\n');
      return { content: [{ type: 'text', text: `Reactions:\n${formatted}` }] };
    }

    case 'discord_create_poll': {
      if (result.success) {
        return { content: [{ type: 'text', text: `Poll created.\nMessage ID: ${result.message_id}` }] };
      }
      return { content: [{ type: 'text', text: 'Failed to create poll.' }] };
    }

    case 'discord_edit_message': {
      return { content: [{ type: 'text', text: result.success ? 'Message edited.' : 'Failed to edit message.' }] };
    }

    case 'discord_delete_message': {
      return { content: [{ type: 'text', text: result.success ? 'Message deleted.' : 'Failed to delete message.' }] };
    }

    case 'discord_pin_message': {
      return { content: [{ type: 'text', text: result.success ? 'Message pinned.' : 'Failed to pin message.' }] };
    }

    case 'discord_create_thread': {
      if (result.success) {
        return { content: [{ type: 'text', text: `Thread created.\nThread ID: ${result.thread_id}` }] };
      }
      return { content: [{ type: 'text', text: 'Failed to create thread.' }] };
    }

    case 'discord_create_forum_post': {
      if (result.success) {
        return { content: [{ type: 'text', text: `Forum post created.\nThread ID: ${result.threadId}\nMessage ID: ${result.messageId}` }] };
      }
      return { content: [{ type: 'text', text: 'Failed to create forum post.' }] };
    }

    case 'discord_list_forum_threads': {
      if (!result.threads || result.threads.length === 0) {
        return { content: [{ type: 'text', text: 'No threads found in this forum channel.' }] };
      }
      const formatted = result.threads.map((t: any) =>
        `- "${t.name}" (ID: ${t.id}) - ${t.messageCount} messages${t.archived ? ' [archived]' : ''}`
      ).join('\n');
      return { content: [{ type: 'text', text: `Found ${result.threads.length} threads:\n\n${formatted}` }] };
    }

    case 'discord_timeout_user': {
      return { content: [{ type: 'text', text: result.success ? 'User timed out.' : 'Failed to timeout user.' }] };
    }

    case 'discord_assign_role': {
      return { content: [{ type: 'text', text: result.success ? 'Role assigned.' : 'Failed to assign role.' }] };
    }

    case 'discord_remove_role': {
      return { content: [{ type: 'text', text: result.success ? 'Role removed.' : 'Failed to remove role.' }] };
    }

    case 'discord_list_members': {
      if (!result.members) {
        return { content: [{ type: 'text', text: 'Server not found or not accessible.' }] };
      }
      const formatted = result.members.map((m: any) =>
        `- ${m.tag} (${m.id})\n  Roles: ${(m.roles || []).join(', ') || 'None'}`
      ).join('\n\n');
      return { content: [{ type: 'text', text: `Members (${result.members.length}):\n\n${formatted}` }] };
    }

    case 'discord_get_user_info': {
      if (!result.id) {
        return { content: [{ type: 'text', text: 'User not found or not accessible.' }] };
      }
      const roles = (result.roles || []).map((r: any) => r.name).join(', ') || 'None';
      const formatted = `**${result.displayName}** (${result.tag})
ID: ${result.id}
Status: ${result.status} (${result.isOnline ? 'online' : 'offline'})
Joined: ${result.joinedAt || 'Unknown'}
Roles: ${roles}`;
      return { content: [{ type: 'text', text: formatted }] };
    }

    case 'discord_list_roles': {
      if (!result.roles) {
        return { content: [{ type: 'text', text: 'Server not found or not accessible.' }] };
      }
      const formatted = result.roles.map((r: any) =>
        `- ${r.name} (${r.id}) [${r.color}] Position: ${r.position}`
      ).join('\n');
      return { content: [{ type: 'text', text: `Roles (${result.roles.length}):\n\n${formatted}` }] };
    }

    default:
      // Fallback: just dump the JSON
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
}

// ============================================================
// MCP Request Handlers
// ============================================================

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ---- PROXY MODE: Forward everything to remote API ----
  if (PROXY_MODE) {
    return handleProxyToolCall(name, args as Record<string, any>);
  }

  // ---- DIRECT MODE: Execute locally via discord.js ----

  if (!discordClient.isReady && name !== 'discord_check_mentions') {
    return {
      content: [{ type: 'text', text: 'Discord client is not ready yet.' }],
    };
  }

  switch (name) {
    case 'discord_read_messages': {
      const channelId = args?.channel_id as string;
      const limit = Math.min((args?.limit as number) ?? 20, 50);

      const messages = await discordClient.getRecentMessages(channelId, limit);

      if (messages.length === 0) {
        return {
          content: [{ type: 'text', text: 'No messages found or channel not accessible.' }],
        };
      }

      const formatted = messages.map(msg => {
        const timestamp = msg.createdAt.toISOString();
        const author = msg.author.tag;
        const messageId = msg.id;

        let text = `[${timestamp}] (${messageId}) ${author}: ${msg.content}`;

        // Include forwarded message content if present (message snapshots)
        if (msg.messageSnapshots && msg.messageSnapshots.size > 0) {
          const forwardedContent = Array.from(msg.messageSnapshots.values()).map((snapshot: any) => {
            let fwdText = `  [Forwarded Message]\n`;
            const fwdContent = snapshot.message?.content ?? snapshot.content;
            const fwdAttachments = snapshot.message?.attachments ?? snapshot.attachments;

            if (fwdContent) {
              fwdText += `  Content: ${fwdContent}\n`;
            }
            if (fwdAttachments && fwdAttachments.size > 0) {
              const attachList = Array.from(fwdAttachments.values()).map((att: any) => {
                return `    - ${att.name} | url: ${att.url}`;
              }).join('\n');
              fwdText += `  Attachments:\n${attachList}`;
            }
            if (!fwdContent && (!fwdAttachments || fwdAttachments.size === 0)) {
              fwdText += `  [Raw snapshot keys: ${Object.keys(snapshot).join(', ')}]`;
            }
            return fwdText;
          }).join('\n');
          text += `\n${forwardedContent}`;
        }

        // Include attachment info if present
        if (msg.attachments.size > 0) {
          const attachmentList = msg.attachments.map(att => {
            const info = [`  - ${att.name}`];
            if (att.contentType) info.push(`type: ${att.contentType}`);
            if (att.width && att.height) info.push(`${att.width}x${att.height}`);
            info.push(`url: ${att.url}`);
            return info.join(' | ');
          }).join('\n');
          text += `\n[Attachments]\n${attachmentList}`;
        }

        return text;
      }).join('\n\n');

      return {
        content: [{ type: 'text', text: formatted }],
      };
    }

    case 'discord_send_message': {
      const channelId = args?.channel_id as string;
      const content = args?.content as string;

      const sent = await discordClient.sendMessage(channelId, content);

      if (sent) {
        await memory.addMessage(channelId, {
          role: 'assistant',
          content: content,
          timestamp: new Date().toISOString(),
        });

        return {
          content: [{ type: 'text', text: `Message sent successfully to channel ${channelId}\nMessage ID: ${sent.id}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to send message. Channel may not be accessible.' }],
      };
    }

    case 'discord_send_dm': {
      const userId = args?.user_id as string;
      const content = args?.content as string;

      const sent = await discordClient.sendDM(userId, content);

      if (sent) {
        return {
          content: [{ type: 'text', text: `DM sent successfully to user ${userId}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to send DM. User may have DMs disabled.' }],
      };
    }

    case 'discord_send_file': {
      const channelId = args?.channel_id as string;
      const fileData = args?.file_data as string | undefined;
      const filePath = args?.file_path as string | undefined;
      const fileName = args?.file_name as string;
      const content = args?.content as string | undefined;

      let fileBuffer: Buffer;

      if (fileData) {
        // Base64-encoded data
        fileBuffer = Buffer.from(fileData, 'base64');
      } else if (filePath) {
        // Read from file path
        const fsPromises = await import('fs/promises');
        try {
          fileBuffer = await fsPromises.readFile(filePath);
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Failed to read file: ${filePath}` }],
          };
        }
      } else {
        return {
          content: [{ type: 'text', text: 'Either file_data or file_path must be provided.' }],
        };
      }

      const sent = await discordClient.sendFile(channelId, fileBuffer, {
        name: fileName,
        content: content,
      });

      if (sent) {
        return {
          content: [{ type: 'text', text: `File "${fileName}" sent successfully to channel ${channelId}\nMessage ID: ${sent.id}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to send file. Channel may not be accessible.' }],
      };
    }

    case 'discord_check_mentions': {
      if (pendingMentions.length === 0) {
        return {
          content: [{ type: 'text', text: 'No pending mentions.' }],
        };
      }

      const mentions = pendingMentions.splice(0, pendingMentions.length);

      const formatted = mentions.map(m => {
        const location = m.guildName
          ? `#${m.channelName} in ${m.guildName}`
          : 'DM';
        return `- ${m.authorTag} in ${location} at ${m.timestamp.toISOString()}:\n  "${m.content}"`;
      }).join('\n\n');

      return {
        content: [{ type: 'text', text: `Pending mentions:\n\n${formatted}` }],
      };
    }

    case 'discord_check_dms': {
      if (pendingDMs.length === 0) {
        return {
          content: [{ type: 'text', text: 'No pending DMs.' }],
        };
      }

      const dms = pendingDMs.splice(0, pendingDMs.length);

      const formatted = dms.map(dm => {
        return `- From: ${dm.authorTag} (${dm.authorId})\n  Channel ID: ${dm.channelId}\n  At: ${dm.timestamp.toISOString()}\n  Message: "${dm.content}"`;
      }).join('\n\n');

      return {
        content: [{ type: 'text', text: `Pending DMs:\n\n${formatted}` }],
      };
    }

    case 'discord_get_history': {
      const channelId = args?.channel_id as string;
      const limit = (args?.limit as number) ?? 20;

      const messages = memory.getRecentMessages(channelId, limit);

      if (messages.length === 0) {
        return {
          content: [{ type: 'text', text: 'No conversation history for this channel.' }],
        };
      }

      const formatted = messages.map(msg => {
        const author = msg.author || (msg.role === 'assistant' ? 'Bot' : 'User');
        return `[${msg.timestamp}] ${author}: ${msg.content}`;
      }).join('\n\n');

      return {
        content: [{ type: 'text', text: formatted }],
      };
    }

    case 'discord_list_channels': {
      const serverId = args?.server_id as string;

      const serverChannels = await discordClient.listServerChannels(serverId);

      if (!serverChannels) {
        return {
          content: [{ type: 'text', text: 'Server not found or not accessible.' }],
        };
      }

      let formatted = `**${serverChannels.serverName}** (${serverChannels.serverId})\n\n`;

      // Format categories and their channels
      for (const category of serverChannels.categories) {
        formatted += `**${category.name}**\n`;
        for (const channel of category.channels) {
          const icon = channel.type === 'voice' ? '(voice)' :
                       channel.type === 'forum' ? '(forum)' :
                       channel.type === 'announcement' ? '(announcement)' :
                       channel.type === 'stage' ? '(stage)' : '#';
          formatted += `   ${icon} ${channel.name} (${channel.id}) [${channel.type}]\n`;
        }
        formatted += '\n';
      }

      // Format uncategorized channels
      if (serverChannels.uncategorized.length > 0) {
        formatted += `**Uncategorized**\n`;
        for (const channel of serverChannels.uncategorized) {
          const icon = channel.type === 'voice' ? '(voice)' :
                       channel.type === 'forum' ? '(forum)' :
                       channel.type === 'announcement' ? '(announcement)' :
                       channel.type === 'stage' ? '(stage)' : '#';
          formatted += `   ${icon} ${channel.name} (${channel.id}) [${channel.type}]\n`;
        }
      }

      return {
        content: [{ type: 'text', text: formatted }],
      };
    }

    // ============================================
    // Priority 1: Channel & Category Management
    // ============================================

    case 'discord_create_channel': {
      const serverId = args?.server_id as string;
      const channelName = args?.name as string;
      const channelType = (args?.type as 'text' | 'voice' | 'forum' | 'announcement') || 'text';
      const categoryId = args?.category_id as string | undefined;
      const topic = args?.topic as string | undefined;
      const nsfw = args?.nsfw as boolean | undefined;

      const result = await discordClient.createChannel(serverId, channelName, channelType, {
        categoryId,
        topic,
        nsfw
      });

      if (result) {
        return {
          content: [{ type: 'text', text: `Created channel #${result.name} (${result.id})` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to create channel. Check permissions and server ID.' }],
      };
    }

    case 'discord_set_channel_topic': {
      const channelId = args?.channel_id as string;
      const topic = args?.topic as string;

      const success = await discordClient.setChannelTopic(channelId, topic);

      if (success) {
        return {
          content: [{ type: 'text', text: `Channel topic updated for ${channelId}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to update channel topic. Check permissions or channel type.' }],
      };
    }

    case 'discord_rename_channel': {
      const channelId = args?.channel_id as string;
      const newName = args?.new_name as string;

      const success = await discordClient.renameChannel(channelId, newName);

      if (success) {
        return {
          content: [{ type: 'text', text: `Channel renamed to #${newName}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to rename channel. Check permissions.' }],
      };
    }

    case 'discord_delete_channel': {
      const channelId = args?.channel_id as string;
      const reason = args?.reason as string | undefined;

      const success = await discordClient.deleteChannel(channelId, reason);

      if (success) {
        return {
          content: [{ type: 'text', text: `Channel ${channelId} deleted.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to delete channel. Check permissions.' }],
      };
    }

    case 'discord_create_category': {
      const serverId = args?.server_id as string;
      const categoryName = args?.name as string;
      const position = args?.position as number | undefined;

      const result = await discordClient.createCategory(serverId, categoryName, position);

      if (result) {
        return {
          content: [{ type: 'text', text: `Created category ${result.name} (${result.id})` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to create category. Check permissions and server ID.' }],
      };
    }

    case 'discord_move_channel': {
      const channelId = args?.channel_id as string;
      const categoryId = args?.category_id as string | null | undefined;
      const position = args?.position as number | undefined;

      const success = await discordClient.moveChannel(channelId, categoryId, position);

      if (success) {
        return {
          content: [{ type: 'text', text: `Channel ${channelId} moved successfully.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to move channel. Check permissions.' }],
      };
    }

    case 'discord_add_reaction': {
      const channelId = args?.channel_id as string;
      const messageId = args?.message_id as string;
      const emoji = args?.emoji as string;

      const success = await discordClient.addReaction(channelId, messageId, emoji);

      if (success) {
        return {
          content: [{ type: 'text', text: `Added reaction ${emoji} to message ${messageId}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to add reaction. Check permissions or message ID.' }],
      };
    }

    case 'discord_get_reactions': {
      const channelId = args?.channel_id as string;
      const messageId = args?.message_id as string;

      const reactions = await discordClient.getReactions(channelId, messageId);

      if (reactions === null) {
        return {
          content: [{ type: 'text', text: 'Failed to get reactions. Check permissions or message ID.' }],
        };
      }

      if (reactions.length === 0) {
        return {
          content: [{ type: 'text', text: 'No reactions on this message.' }],
        };
      }

      const formatted = reactions.map((r: any) =>
        `${r.emoji}: ${r.count} reaction(s)`
      ).join('\n');

      return {
        content: [{ type: 'text', text: `Reactions:\n${formatted}` }],
      };
    }

    case 'discord_create_poll': {
      const channelId = args?.channel_id as string;
      const question = args?.question as string;
      const rawOptions = args?.options as Array<string | { text: string; emoji?: string }>;
      const durationHours = (args?.duration_hours as number) || 24;
      const allowMultiselect = (args?.allow_multiselect as boolean) || false;

      if (!rawOptions || rawOptions.length < 2) {
        return {
          content: [{ type: 'text', text: 'Poll requires at least 2 options.' }],
        };
      }

      // Normalize options to { text, emoji? } format
      const options = rawOptions.map(opt =>
        typeof opt === 'string' ? { text: opt } : opt
      );

      const result = await discordClient.createPoll(channelId, question, options, durationHours, allowMultiselect);

      if (result) {
        return {
          content: [{ type: 'text', text: `Poll created.\nMessage ID: ${result.messageId}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to create poll. Check permissions.' }],
      };
    }

    // ============================================
    // Priority 2: Message Management
    // ============================================

    case 'discord_edit_message': {
      const channelId = args?.channel_id as string;
      const messageId = args?.message_id as string;
      const newContent = args?.new_content as string;

      const success = await discordClient.editMessage(channelId, messageId, newContent);

      if (success) {
        return {
          content: [{ type: 'text', text: `Message ${messageId} edited successfully.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to edit message. Can only edit own messages.' }],
      };
    }

    case 'discord_delete_message': {
      const channelId = args?.channel_id as string;
      const messageId = args?.message_id as string;

      const success = await discordClient.deleteMessage(channelId, messageId);

      if (success) {
        return {
          content: [{ type: 'text', text: `Message ${messageId} deleted.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to delete message. Check permissions.' }],
      };
    }

    case 'discord_pin_message': {
      const channelId = args?.channel_id as string;
      const messageId = args?.message_id as string;

      const success = await discordClient.pinMessage(channelId, messageId);

      if (success) {
        return {
          content: [{ type: 'text', text: `Message ${messageId} pinned.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to pin message. Check permissions or pin limit.' }],
      };
    }

    case 'discord_create_thread': {
      const channelId = args?.channel_id as string;
      const threadName = args?.name as string;
      const messageId = args?.message_id as string | undefined;
      const autoArchiveDuration = args?.auto_archive_duration as 60 | 1440 | 4320 | 10080 | undefined;

      const threadId = await discordClient.createThread(channelId, threadName, messageId, autoArchiveDuration);

      if (threadId) {
        return {
          content: [{ type: 'text', text: `Created thread "${threadName}" (${threadId})` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to create thread. Check permissions.' }],
      };
    }

    case 'discord_create_forum_post': {
      const channelId = args?.channel_id as string;
      const title = args?.title as string;
      const content = args?.content as string;
      const tags = args?.tags as string[] | undefined;

      const result = await discordClient.createForumPost(channelId, title, content, tags);

      if (result) {
        return {
          content: [{
            type: 'text',
            text: `Forum post created: "${title}"\nThread ID: ${result.threadId}\nMessage ID: ${result.messageId}`
          }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to create forum post. Check channel ID and permissions.' }],
      };
    }

    case 'discord_list_forum_threads': {
      const channelId = args?.channel_id as string;
      const limit = (args?.limit as number) || 20;
      const includeArchived = (args?.include_archived as boolean) || false;

      const threads = await discordClient.listForumThreads(channelId, limit, includeArchived);

      if (threads.length > 0) {
        const formatted = threads.map(t =>
          `- "${t.name}" (ID: ${t.id}) - ${t.messageCount} messages${t.archived ? ' [archived]' : ''}`
        ).join('\n');

        return {
          content: [{
            type: 'text',
            text: `Found ${threads.length} threads:\n\n${formatted}`
          }],
        };
      }

      return {
        content: [{ type: 'text', text: 'No threads found in this forum channel.' }],
      };
    }

    case 'discord_fetch_attachment': {
      const channelId = args?.channel_id as string;
      const messageId = args?.message_id as string;
      const filename = args?.filename as string | undefined;

      const result = await discordClient.fetchAttachment(channelId, messageId, filename);

      if (result.downloaded.length > 0) {
        const fileList = result.downloaded.map(p => `  - ${p}`).join('\n');
        let response = `Downloaded ${result.downloaded.length} attachment(s):\n${fileList}`;

        if (result.errors.length > 0) {
          response += `\n\nWarnings:\n${result.errors.map(e => `  - ${e}`).join('\n')}`;
        }

        return {
          content: [{ type: 'text', text: response }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Failed to download attachments:\n${result.errors.map(e => `  - ${e}`).join('\n')}`
        }],
      };
    }

    // ============================================
    // Priority 3: Moderation
    // ============================================

    case 'discord_timeout_user': {
      const serverId = args?.server_id as string;
      const userId = args?.user_id as string;
      const durationMinutes = args?.duration_minutes as number;
      const reason = args?.reason as string | undefined;

      const success = await discordClient.timeoutUser(serverId, userId, durationMinutes, reason);

      if (success) {
        return {
          content: [{ type: 'text', text: `User ${userId} timed out for ${durationMinutes} minutes.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to timeout user. Check permissions.' }],
      };
    }

    case 'discord_assign_role': {
      const serverId = args?.server_id as string;
      const userId = args?.user_id as string;
      const roleId = args?.role_id as string;
      const reason = args?.reason as string | undefined;

      const success = await discordClient.assignRole(serverId, userId, roleId, reason);

      if (success) {
        return {
          content: [{ type: 'text', text: `Role ${roleId} assigned to user ${userId}.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to assign role. Check permissions and role hierarchy.' }],
      };
    }

    case 'discord_remove_role': {
      const serverId = args?.server_id as string;
      const userId = args?.user_id as string;
      const roleId = args?.role_id as string;
      const reason = args?.reason as string | undefined;

      const success = await discordClient.removeRole(serverId, userId, roleId, reason);

      if (success) {
        return {
          content: [{ type: 'text', text: `Role ${roleId} removed from user ${userId}.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to remove role. Check permissions and role hierarchy.' }],
      };
    }

    // ============================================
    // Priority 4: Awareness
    // ============================================

    case 'discord_list_members': {
      const serverId = args?.server_id as string;
      const limit = (args?.limit as number) || 100;

      const members = await discordClient.listMembers(serverId, limit);

      if (!members) {
        return {
          content: [{ type: 'text', text: 'Server not found or not accessible.' }],
        };
      }

      const formatted = members.map(m =>
        `- ${m.tag} (${m.id})\n  Roles: ${m.roles.join(', ') || 'None'}`
      ).join('\n\n');

      return {
        content: [{ type: 'text', text: `Members (${members.length}):\n\n${formatted}` }],
      };
    }

    case 'discord_get_user_info': {
      const serverId = args?.server_id as string;
      const userId = args?.user_id as string;

      const userInfo = await discordClient.getUserInfo(serverId, userId);

      if (!userInfo) {
        return {
          content: [{ type: 'text', text: 'User not found or not accessible.' }],
        };
      }

      const roles = userInfo.roles.map(r => r.name).join(', ') || 'None';
      const formatted = `**${userInfo.displayName}** (${userInfo.tag})
ID: ${userInfo.id}
Status: ${userInfo.status} (${userInfo.isOnline ? 'online' : 'offline'})
Joined: ${userInfo.joinedAt || 'Unknown'}
Roles: ${roles}`;

      return {
        content: [{ type: 'text', text: formatted }],
      };
    }

    case 'discord_list_roles': {
      const serverId = args?.server_id as string;

      const roles = await discordClient.listRoles(serverId);

      if (!roles) {
        return {
          content: [{ type: 'text', text: 'Server not found or not accessible.' }],
        };
      }

      const formatted = roles.map(r =>
        `- ${r.name} (${r.id}) [${r.color}] Position: ${r.position}`
      ).join('\n');

      return {
        content: [{ type: 'text', text: `Roles (${roles.length}):\n\n${formatted}` }],
      };
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// ============================================================
// Event Handlers (direct mode only)
// ============================================================

if (!PROXY_MODE) {

  // Handle mentions
  discordClient.on('mention', async (event: MentionEvent) => {
    logger.info('Discord', `Mention detected from ${event.authorTag} in ${event.channelName}`);

    if (discordClient.isOwner(event.authorId)) {
      // Owner mentioned the bot - auto-respond via API
      logger.info('Discord', 'Owner mentioned - triggering API response');

      await discordClient.sendTyping(event.channelId);

      // Get conversation history
      const history = memory.getRecentMessages(event.channelId, 20);

      // Get memory context for richer responses
      const memoryContext = await memory.getMemoryContext(true);

      // Store owner's message in memory
      await memory.addMessage(event.channelId, {
        role: 'user',
        content: event.content,
        timestamp: event.timestamp.toISOString(),
        author: event.authorTag,
        userId: event.authorId,
      });

      try {
        // Get response from Claude
        const response = await claude.getResponse(event.content, history, memoryContext);

        // Store response in memory
        await memory.addMessage(event.channelId, {
          role: 'assistant',
          content: response,
          timestamp: new Date().toISOString(),
        });

        // Reply in Discord
        await discordClient.replyToMessage(event.message, response);
        logger.info('Discord', 'Responded to owner');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error('Discord', `Failed to respond: ${msg}`);
        await discordClient.replyToMessage(
          event.message,
          'I encountered an error processing that message. Try again?'
        );
      }
    } else {
      // Someone else mentioned the bot - DM owner, don't respond
      logger.info('Discord', `Non-owner mention from ${event.authorTag} - notifying owner via DM`);

      const location = event.guildName
        ? `#${event.channelName} in ${event.guildName}`
        : 'a DM';

      // Build message link
      const guildId = event.message.guild?.id || '@me';
      const messageLink = `https://discord.com/channels/${guildId}/${event.channelId}/${event.message.id}`;

      const notification = `**Bot mentioned**\n\n` +
        `**By:** ${event.authorTag}\n` +
        `**Where:** ${location}\n` +
        `**When:** ${event.timestamp.toISOString()}\n` +
        `**Message:** "${event.content}"\n\n` +
        `**[Jump to message](${messageLink})**`;

      await discordClient.sendDM(OWNER_USER_ID, notification);

      // Also store in pending mentions for MCP tool
      pendingMentions.push(event);
      logger.info('Discord', 'Owner notified via DM');
    }
  });

  // Handle incoming DMs
  discordClient.on('dm', async (event: MentionEvent) => {
    logger.info('Discord', `DM received from ${event.authorTag}`);

    // Extract forwarded message content if present
    let fullContent = event.content;
    if (event.message.messageSnapshots && event.message.messageSnapshots.size > 0) {
      const forwardedParts = Array.from(event.message.messageSnapshots.values()).map((snapshot: any) => {
        const fwdContent = snapshot.message?.content ?? snapshot.content;
        const fwdAttachments = snapshot.message?.attachments ?? snapshot.attachments;

        let fwdText = '[Forwarded Message]';
        if (fwdContent) {
          fwdText += `\n${fwdContent}`;
        }
        if (fwdAttachments && fwdAttachments.size > 0) {
          const attachList = Array.from(fwdAttachments.values()).map((att: any) => att.url).join('\n');
          fwdText += `\n[Attachments: ${attachList}]`;
        }
        return fwdText;
      });
      fullContent = fullContent ? `${fullContent}\n\n${forwardedParts.join('\n')}` : forwardedParts.join('\n');
    }

    // Store in memory for context
    await memory.addMessage(event.channelId, {
      role: 'user',
      content: fullContent,
      timestamp: event.timestamp.toISOString(),
      author: event.authorTag,
      userId: event.authorId,
    });

    // Add to pending DMs for MCP tool access
    pendingDMs.push(event);

    // Also notify owner via DM
    const notification = `**New DM received**\n\n` +
      `**From:** ${event.authorTag}\n` +
      `**When:** ${event.timestamp.toISOString()}\n` +
      `**Message:** "${fullContent}"\n\n` +
      `Use \`discord_check_dms\` to see pending DMs.`;

    await discordClient.sendDM(OWNER_USER_ID, notification);
    logger.info('Discord', 'DM stored and owner notified');
  });

  // Handle owner's presence changes
  discordClient.on('ownerPresenceChange', (isOnline: boolean) => {
    logger.info('Discord', `Owner is now ${isOnline ? 'online' : 'offline'}`);
  });
}

// ============================================================
// Main Startup
// ============================================================

async function main() {

  // ---- PROXY MODE ----
  if (PROXY_MODE) {
    logger.info('MCP', 'Starting Discord MCP Server (PROXY MODE)');
    logger.info('MCP', `API URL: ${BOT_API_URL}`);

    // In proxy mode, just start MCP stdio — no Discord, no lock, no heartbeat
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('MCP', 'Discord MCP Server running (proxy mode)');
    logger.info('MCP', 'All tool calls will be forwarded to remote API');
    return;
  }

  // ---- DIRECT MODE ----
  logger.info('MCP', 'Starting Discord MCP Server (DIRECT MODE)');

  // Validate configuration
  if (!DISCORD_TOKEN) {
    logger.fatal('MCP', 'DISCORD_BOT_TOKEN is required');
    process.exit(1);
  }
  if (!ANTHROPIC_API_KEY) {
    logger.fatal('MCP', 'ANTHROPIC_API_KEY is required');
    process.exit(1);
  }

  // Acquire lock and kill orphans
  acquireLock();

  // Start heartbeat
  logger.startHeartbeat();

  // Initialize memory
  await memory.initialize();

  // Login to Discord
  logger.info('MCP', 'Connecting to Discord...');
  await discordClient.login(DISCORD_TOKEN);
  logger.setDiscordConnected(true);

  // Start HTTP API if secret is configured
  if (BOT_API_SECRET) {
    logger.info('MCP', 'Starting HTTP API server...');
    createHttpServer(discordClient, memory, BOT_API_SECRET, BOT_API_PORT);
  }

  // Start MCP server on stdio
  logger.info('MCP', 'Starting MCP server on stdio...');
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('MCP', 'Discord MCP Server running');
  logger.info('MCP', `Owner User ID: ${OWNER_USER_ID}`);
  logger.info('MCP', 'Responding to owner\'s mentions automatically');
  logger.info('MCP', 'Other mentions will DM owner');
  if (BOT_API_SECRET) {
    logger.info('MCP', `HTTP API: http://0.0.0.0:${BOT_API_PORT}`);
  }
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  logger.fatal('MCP', `Fatal error during startup: ${msg}`, { stack });
  releaseLock();
  process.exit(1);
});
