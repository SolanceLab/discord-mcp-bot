#!/usr/bin/env node

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
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OWNER_USER_ID = process.env.OWNER_USER_ID || '';

// Store pending mentions and DMs for MCP tools
const pendingMentions: MentionEvent[] = [];
const pendingDMs: MentionEvent[] = [];

// Initialize components
const discordClient = new DiscordClient(OWNER_USER_ID);
const memory = new MemoryManager(path.resolve(__dirname, '../memory-ledger.json'));
const claude = new ClaudeClient(ANTHROPIC_API_KEY);

// Create low-level MCP server
const server = new Server(
  {
    name: 'discord-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
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

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

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
            // The snapshot itself contains the message data directly
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
            // If we couldn't extract content, show the raw structure for debugging
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
        const fs = await import('fs/promises');
        try {
          fileBuffer = await fs.readFile(filePath);
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
        formatted += `📁 **${category.name}**\n`;
        for (const channel of category.channels) {
          const icon = channel.type === 'voice' ? '🔊' :
                       channel.type === 'forum' ? '💬' :
                       channel.type === 'announcement' ? '📢' :
                       channel.type === 'stage' ? '🎭' : '#';
          formatted += `   ${icon} ${channel.name} (${channel.id}) [${channel.type}]\n`;
        }
        formatted += '\n';
      }

      // Format uncategorized channels
      if (serverChannels.uncategorized.length > 0) {
        formatted += `📁 **Uncategorized**\n`;
        for (const channel of serverChannels.uncategorized) {
          const icon = channel.type === 'voice' ? '🔊' :
                       channel.type === 'forum' ? '💬' :
                       channel.type === 'announcement' ? '📢' :
                       channel.type === 'stage' ? '🎭' : '#';
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
          `• "${t.name}" (ID: ${t.id}) - ${t.messageCount} messages${t.archived ? ' [archived]' : ''}`
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

// Handle mentions
discordClient.on('mention', async (event: MentionEvent) => {
  console.error(`\n📨 Mention detected from ${event.authorTag} in ${event.channelName}`);

  if (discordClient.isOwner(event.authorId)) {
    // Owner mentioned the bot - auto-respond via API
    console.error(`   👑 Owner mentioned - triggering API response`);

    await discordClient.sendTyping(event.channelId);

    // Get conversation history
    const history = memory.getRecentMessages(event.channelId, 20);

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
      const response = await claude.getResponse(event.content, history);

      // Store response in memory
      await memory.addMessage(event.channelId, {
        role: 'assistant',
        content: response,
        timestamp: new Date().toISOString(),
      });

      // Reply in Discord
      await discordClient.replyToMessage(event.message, response);
      console.error(`   ✅ Responded to owner`);
    } catch (error) {
      console.error(`   ❌ Failed to respond:`, error);
      await discordClient.replyToMessage(
        event.message,
        'I encountered an error processing that message. Try again?'
      );
    }
  } else {
    // Someone else mentioned the bot - DM owner, don't respond
    console.error(`   📩 Non-owner mention - notifying owner via DM`);

    const location = event.guildName
      ? `#${event.channelName} in ${event.guildName}`
      : 'a DM';

    // Build message link: https://discord.com/channels/[server_id]/[channel_id]/[message_id]
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
    console.error(`   ✅ Owner notified via DM`);
  }
});

// Handle incoming DMs
discordClient.on('dm', async (event: MentionEvent) => {
  console.error(`\n💬 DM received from ${event.authorTag}`);

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
  console.error(`   ✅ DM stored and owner notified`);
});

// Handle owner's presence changes
discordClient.on('ownerPresenceChange', (isOnline: boolean) => {
  console.error(`🔄 Owner is now ${isOnline ? 'online' : 'offline'}`);
});

// Main startup
async function main() {
  console.error('🚀 Starting Discord MCP Server...');

  // Validate configuration
  if (!DISCORD_TOKEN) {
    console.error('❌ DISCORD_BOT_TOKEN is required');
    process.exit(1);
  }
  if (!ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY is required');
    process.exit(1);
  }

  // Initialize memory
  await memory.initialize();

  // Login to Discord
  console.error('🔌 Connecting to Discord...');
  await discordClient.login(DISCORD_TOKEN);

  // Start MCP server on stdio
  console.error('🔌 Starting MCP server on stdio...');
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('✅ Discord MCP Server running');
  console.error(`   Owner User ID: ${OWNER_USER_ID}`);
  console.error(`   Responding to owner's mentions automatically`);
  console.error(`   Other mentions will DM owner`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
