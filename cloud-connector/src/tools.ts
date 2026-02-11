/**
 * All 28 Discord MCP tools
 *
 * Each tool follows the same pattern:
 * 1. Validate input via Zod
 * 2. Call DiscordClient method
 * 3. Return formatted response
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DiscordClient } from "./discord-client";
import type { Env } from "./types";

function success(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function error(msg: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: msg }) }] };
}

export function registerTools(server: McpServer, env: Env) {
  const discord = new DiscordClient(env);

  // ============================================================
  // MESSAGES (5)
  // ============================================================

  server.tool(
    "discord_read_messages",
    "Read recent messages from a Discord channel. Returns messages with author, content, timestamp, and any attachments.",
    {
      channel_id: z.string().describe("The Discord channel ID to read from"),
      limit: z.number().optional().describe("Number of messages to fetch (max 50, default 20)"),
    },
    async ({ channel_id, limit }) => {
      try {
        const data = await discord.readMessages(channel_id, limit);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_send_message",
    "Send a message to a Discord channel. Optionally reply to a specific message.",
    {
      channel_id: z.string().describe("The Discord channel ID to send to"),
      content: z.string().describe("The message content to send (max 2000 characters)"),
      reply_to_message_id: z.string().optional().describe("Optional message ID to reply to. Creates a threaded reply linking to the original message."),
    },
    async ({ channel_id, content, reply_to_message_id }) => {
      try {
        const data = await discord.sendMessage(channel_id, content, reply_to_message_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_edit_message",
    "Edit a message sent by the bot.",
    {
      channel_id: z.string().describe("The channel ID where the message is"),
      message_id: z.string().describe("The message ID to edit"),
      content: z.string().describe("The new message content"),
    },
    async ({ channel_id, message_id, content }) => {
      try {
        const data = await discord.editMessage(channel_id, message_id, content);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_delete_message",
    "Delete a message from a channel.",
    {
      channel_id: z.string().describe("The channel ID where the message is"),
      message_id: z.string().describe("The message ID to delete"),
    },
    async ({ channel_id, message_id }) => {
      try {
        const data = await discord.deleteMessage(channel_id, message_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_pin_message",
    "Pin a message in a channel.",
    {
      channel_id: z.string().describe("The channel ID where the message is"),
      message_id: z.string().describe("The message ID to pin"),
    },
    async ({ channel_id, message_id }) => {
      try {
        const data = await discord.pinMessage(channel_id, message_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ============================================================
  // DIRECT MESSAGES (3)
  // ============================================================

  server.tool(
    "discord_send_dm",
    "Send a direct message to a user.",
    {
      user_id: z.string().describe("The Discord user ID to DM"),
      content: z.string().describe("The message content to send"),
    },
    async ({ user_id, content }) => {
      try {
        const data = await discord.sendDm(user_id, content);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_get_dm_channel",
    "Get the DM channel ID for a user. Returns the channel ID needed for discord_read_messages on DM conversations.",
    {
      user_id: z.string().describe("The Discord user ID to look up"),
    },
    async ({ user_id }) => {
      const data = await discord.getDMChannel(user_id);
      return success(data);
    }
  );

  server.tool(
    "discord_check_dms",
    "Check for pending direct messages to the bot. Note: In cloud mode, DMs are handled automatically.",
    {},
    async () => {
      return success({
        message: "Not available in cloud connector mode. The cloud bot handles DMs automatically.",
        tip: "Use discord_get_dm_channel with a user ID to get the DM channel, then discord_read_messages to read the conversation."
      });
    }
  );

  // ============================================================
  // ATTACHMENTS (2)
  // ============================================================

  server.tool(
    "discord_send_file",
    "Send a file/attachment to a Discord channel. The file must exist on the server running the bot.",
    {
      channel_id: z.string().describe("The Discord channel ID to send to"),
      file_path: z.string().describe("Path to the file on the bot server"),
      content: z.string().optional().describe("Optional message text to accompany the file"),
    },
    async ({ channel_id, file_path, content }) => {
      try {
        const data = await discord.sendFile(channel_id, file_path, content);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_fetch_attachment",
    "Get the CDN URLs for attachments on a message. Returns fresh URLs that can be used to view or download the files.",
    {
      channel_id: z.string().describe("The channel ID where the message is"),
      message_id: z.string().describe("The message ID with attachments"),
    },
    async ({ channel_id, message_id }) => {
      try {
        const data = await discord.getAttachmentUrls(channel_id, message_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ============================================================
  // REACTIONS (2)
  // ============================================================

  server.tool(
    "discord_add_reaction",
    "Add a reaction to a message.",
    {
      channel_id: z.string().describe("The channel ID where the message is"),
      message_id: z.string().describe("The message ID to react to"),
      emoji: z.string().describe("The emoji to react with (unicode or custom emoji format)"),
    },
    async ({ channel_id, message_id, emoji }) => {
      try {
        const data = await discord.addReaction(channel_id, message_id, emoji);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_get_reactions",
    "Get all reactions on a message with the list of users who reacted.",
    {
      channel_id: z.string().describe("The channel ID where the message is"),
      message_id: z.string().describe("The message ID to get reactions from"),
    },
    async ({ channel_id, message_id }) => {
      try {
        const data = await discord.getReactions(channel_id, message_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ============================================================
  // POLLS (1)
  // ============================================================

  server.tool(
    "discord_create_poll",
    "Create a native Discord poll in a channel.",
    {
      channel_id: z.string().describe("The channel ID to create the poll in"),
      question: z.string().describe("The poll question"),
      options: z.array(z.string()).describe("Array of poll options (max 10)"),
      duration_hours: z.number().optional().describe("Poll duration in hours (1-768, default 24)"),
    },
    async ({ channel_id, question, options, duration_hours }) => {
      try {
        const data = await discord.createPoll(channel_id, question, options, duration_hours);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ============================================================
  // THREADS (1)
  // ============================================================

  server.tool(
    "discord_create_thread",
    "Create a thread in a text channel, optionally from an existing message.",
    {
      channel_id: z.string().describe("The channel ID to create the thread in"),
      name: z.string().describe("The thread name"),
      message_id: z.string().optional().describe("Optional message ID to start the thread from"),
    },
    async ({ channel_id, name, message_id }) => {
      try {
        const data = await discord.createThread(channel_id, name, message_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ============================================================
  // FORUMS (2)
  // ============================================================

  server.tool(
    "discord_create_forum_post",
    "Create a new post in a forum channel.",
    {
      channel_id: z.string().describe("The forum channel ID"),
      title: z.string().describe("Post title (becomes the thread name)"),
      content: z.string().describe("Initial message content for the post"),
      tags: z.array(z.string()).optional().describe("Optional array of tag IDs to apply"),
    },
    async ({ channel_id, title, content, tags }) => {
      try {
        const data = await discord.createForumPost(channel_id, title, content, tags);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_list_forum_threads",
    "List threads in a forum channel.",
    {
      channel_id: z.string().describe("The forum channel ID"),
    },
    async ({ channel_id }) => {
      try {
        const data = await discord.listForumThreads(channel_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ============================================================
  // CHANNELS (6)
  // ============================================================

  server.tool(
    "discord_list_channels",
    "List all channels in a server.",
    {
      server_id: z.string().describe("The Discord server (guild) ID"),
    },
    async ({ server_id }) => {
      try {
        const data = await discord.listChannels(server_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_create_channel",
    "Create a new channel in a server.",
    {
      server_id: z.string().describe("The Discord server (guild) ID"),
      name: z.string().describe("The channel name"),
      type: z.string().optional().describe("Channel type: text, voice, or forum (default: text)"),
      category_id: z.string().optional().describe("Optional category ID to place the channel in"),
    },
    async ({ server_id, name, type, category_id }) => {
      try {
        const data = await discord.createChannel(server_id, name, type, category_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_rename_channel",
    "Rename a channel.",
    {
      channel_id: z.string().describe("The channel ID to rename"),
      name: z.string().describe("The new channel name"),
    },
    async ({ channel_id, name }) => {
      try {
        const data = await discord.renameChannel(channel_id, name);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_set_channel_topic",
    "Set the topic/description of a channel.",
    {
      channel_id: z.string().describe("The channel ID"),
      topic: z.string().describe("The new channel topic"),
    },
    async ({ channel_id, topic }) => {
      try {
        const data = await discord.setChannelTopic(channel_id, topic);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_delete_channel",
    "Delete a channel. This action is irreversible.",
    {
      channel_id: z.string().describe("The channel ID to delete"),
    },
    async ({ channel_id }) => {
      try {
        const data = await discord.deleteChannel(channel_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_move_channel",
    "Move a channel to a different category.",
    {
      channel_id: z.string().describe("The channel ID to move"),
      category_id: z.string().describe("The target category ID"),
    },
    async ({ channel_id, category_id }) => {
      try {
        const data = await discord.moveChannel(channel_id, category_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ============================================================
  // CATEGORIES (1)
  // ============================================================

  server.tool(
    "discord_create_category",
    "Create a new category in a server.",
    {
      server_id: z.string().describe("The Discord server (guild) ID"),
      name: z.string().describe("The category name"),
    },
    async ({ server_id, name }) => {
      try {
        const data = await discord.createCategory(server_id, name);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ============================================================
  // MODERATION (3)
  // ============================================================

  server.tool(
    "discord_timeout_user",
    "Timeout a user in a server (max 28 days).",
    {
      server_id: z.string().describe("The Discord server (guild) ID"),
      user_id: z.string().describe("The user ID to timeout"),
      duration_minutes: z.number().describe("Timeout duration in minutes"),
      reason: z.string().optional().describe("Optional reason for the timeout"),
    },
    async ({ server_id, user_id, duration_minutes, reason }) => {
      try {
        const data = await discord.timeoutUser(server_id, user_id, duration_minutes, reason);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_assign_role",
    "Assign a role to a user.",
    {
      server_id: z.string().describe("The Discord server (guild) ID"),
      user_id: z.string().describe("The user ID"),
      role_id: z.string().describe("The role ID to assign"),
    },
    async ({ server_id, user_id, role_id }) => {
      try {
        const data = await discord.assignRole(server_id, user_id, role_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_remove_role",
    "Remove a role from a user.",
    {
      server_id: z.string().describe("The Discord server (guild) ID"),
      user_id: z.string().describe("The user ID"),
      role_id: z.string().describe("The role ID to remove"),
    },
    async ({ server_id, user_id, role_id }) => {
      try {
        const data = await discord.removeRole(server_id, user_id, role_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ============================================================
  // SEARCH (1)
  // ============================================================

  server.tool(
    "discord_search_messages",
    "Search messages in a channel with filters for author, keyword, date range, and attachments. Scans messages server-side — only matching messages are returned, saving tokens. At least one filter required.",
    {
      channel_id: z.string().describe("The Discord channel ID to search"),
      author_id: z.string().optional().describe("Filter by author's Discord user ID"),
      keyword: z.string().optional().describe("Case-insensitive text search in message content"),
      before: z.string().optional().describe("ISO timestamp — only messages before this date"),
      after: z.string().optional().describe("ISO timestamp — only messages after this date"),
      has_attachment: z.boolean().optional().describe("Filter for messages with (true) or without (false) attachments"),
      limit: z.number().optional().describe("Max results to return (default 20, max 50)"),
      scan_depth: z.number().optional().describe("Messages to scan internally (default 200, max 500)"),
    },
    async ({ channel_id, author_id, keyword, before, after, has_attachment, limit, scan_depth }) => {
      try {
        const data = await discord.searchMessages(channel_id, author_id, keyword, before, after, has_attachment, limit, scan_depth);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ============================================================
  // AWARENESS (5)
  // ============================================================

  server.tool(
    "discord_check_mentions",
    "Check for pending @mentions of the bot. Note: In cloud mode, mentions are handled automatically.",
    {},
    async () => {
      return success({
        message: "Not available in cloud connector mode. The cloud bot handles mentions automatically.",
        tip: "Use discord_read_messages to read recent channel messages and see any mentions in context."
      });
    }
  );

  server.tool(
    "discord_get_history",
    "Get conversation history from a channel, formatted for context.",
    {
      channel_id: z.string().describe("The channel ID to get history from"),
      limit: z.number().optional().describe("Number of messages to fetch"),
    },
    async ({ channel_id, limit }) => {
      try {
        const data = await discord.getHistory(channel_id, limit);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_list_members",
    "List members in a server.",
    {
      server_id: z.string().describe("The Discord server (guild) ID"),
      limit: z.number().optional().describe("Max members to return"),
    },
    async ({ server_id, limit }) => {
      try {
        const data = await discord.listMembers(server_id, limit);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_get_user_info",
    "Get information about a Discord user.",
    {
      user_id: z.string().describe("The Discord user ID"),
    },
    async ({ user_id }) => {
      try {
        const data = await discord.getUserInfo(user_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "discord_list_roles",
    "List all roles in a server.",
    {
      server_id: z.string().describe("The Discord server (guild) ID"),
    },
    async ({ server_id }) => {
      try {
        const data = await discord.listRoles(server_id);
        return success(data);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }
  );
}
