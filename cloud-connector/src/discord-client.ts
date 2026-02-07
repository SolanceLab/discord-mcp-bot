/**
 * Discord API client — thin wrapper around Fly.io HTTP API
 *
 * All methods forward to the existing bot's HTTP endpoints.
 * The bot handles Discord.js, rate limiting, and error handling.
 */

import type { Env } from "./types";

export class DiscordClient {
  private baseUrl: string;
  private secret: string;

  constructor(env: Env) {
    this.baseUrl = env.BOT_API_URL.replace(/\/$/, "");
    this.secret = env.BOT_API_SECRET;
  }

  /**
   * Make an authenticated request to the Fly.io bot API
   */
  async call<T = unknown>(endpoint: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.baseUrl}/api/${endpoint}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.secret}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  // Convenience methods for each endpoint

  async readMessages(channelId: string, limit?: number) {
    return this.call("read-messages", { channel_id: channelId, limit });
  }

  async sendMessage(channelId: string, content: string, replyToMessageId?: string) {
    return this.call("send-message", { channel_id: channelId, content, reply_to_message_id: replyToMessageId });
  }

  async sendDm(userId: string, content: string) {
    return this.call("send-dm", { user_id: userId, content });
  }

  async sendFile(channelId: string, filePath: string, content?: string) {
    return this.call("send-file", { channel_id: channelId, file_path: filePath, content });
  }

  async getHistory(channelId: string, limit?: number) {
    return this.call("get-history", { channel_id: channelId, limit });
  }

  async listChannels(serverId: string) {
    return this.call("list-channels", { server_id: serverId });
  }

  async createChannel(serverId: string, name: string, type?: string, categoryId?: string) {
    return this.call("create-channel", { server_id: serverId, name, type, category_id: categoryId });
  }

  async setChannelTopic(channelId: string, topic: string) {
    return this.call("set-channel-topic", { channel_id: channelId, topic });
  }

  async renameChannel(channelId: string, name: string) {
    return this.call("rename-channel", { channel_id: channelId, name });
  }

  async deleteChannel(channelId: string) {
    return this.call("delete-channel", { channel_id: channelId });
  }

  async createCategory(serverId: string, name: string) {
    return this.call("create-category", { server_id: serverId, name });
  }

  async moveChannel(channelId: string, categoryId: string) {
    return this.call("move-channel", { channel_id: channelId, category_id: categoryId });
  }

  async addReaction(channelId: string, messageId: string, emoji: string) {
    return this.call("add-reaction", { channel_id: channelId, message_id: messageId, emoji });
  }

  async getReactions(channelId: string, messageId: string) {
    return this.call("get-reactions", { channel_id: channelId, message_id: messageId });
  }

  async createPoll(channelId: string, question: string, options: string[], durationHours?: number) {
    return this.call("create-poll", { channel_id: channelId, question, options, duration_hours: durationHours });
  }

  async editMessage(channelId: string, messageId: string, content: string) {
    return this.call("edit-message", { channel_id: channelId, message_id: messageId, content });
  }

  async deleteMessage(channelId: string, messageId: string) {
    return this.call("delete-message", { channel_id: channelId, message_id: messageId });
  }

  async pinMessage(channelId: string, messageId: string) {
    return this.call("pin-message", { channel_id: channelId, message_id: messageId });
  }

  async createThread(channelId: string, name: string, messageId?: string) {
    return this.call("create-thread", { channel_id: channelId, name, message_id: messageId });
  }

  async createForumPost(channelId: string, title: string, content: string, tags?: string[]) {
    return this.call("create-forum-post", { channel_id: channelId, title, content, tags });
  }

  async listForumThreads(channelId: string) {
    return this.call("list-forum-threads", { channel_id: channelId });
  }

  async getAttachmentUrls(channelId: string, messageId: string) {
    return this.call("get-attachment-urls", { channel_id: channelId, message_id: messageId });
  }

  async timeoutUser(serverId: string, userId: string, durationMinutes: number, reason?: string) {
    return this.call("timeout-user", { server_id: serverId, user_id: userId, duration_minutes: durationMinutes, reason });
  }

  async assignRole(serverId: string, userId: string, roleId: string) {
    return this.call("assign-role", { server_id: serverId, user_id: userId, role_id: roleId });
  }

  async removeRole(serverId: string, userId: string, roleId: string) {
    return this.call("remove-role", { server_id: serverId, user_id: userId, role_id: roleId });
  }

  async listMembers(serverId: string, limit?: number) {
    return this.call("list-members", { server_id: serverId, limit });
  }

  async getUserInfo(userId: string) {
    return this.call("get-user-info", { user_id: userId });
  }

  async listRoles(serverId: string) {
    return this.call("list-roles", { server_id: serverId });
  }
}
