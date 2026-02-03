import {
  Client,
  GatewayIntentBits,
  Message,
  ActivityType,
  TextChannel,
  DMChannel,
  ChannelType,
  User,
  Guild,
  GuildChannel,
  CategoryChannel,
  ThreadChannel,
  GuildMember,
  Role,
  ForumChannel,
  AttachmentBuilder
} from 'discord.js';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

export interface MentionEvent {
  channelId: string;
  channelName: string;
  guildName: string | null;
  authorId: string;
  authorTag: string;
  content: string;
  timestamp: Date;
  message: Message;
  isDM?: boolean;
}

export interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  position: number;
}

export interface CategoryInfo {
  id: string;
  name: string;
  position: number;
  channels: ChannelInfo[];
}

export interface ServerChannels {
  serverName: string;
  serverId: string;
  categories: CategoryInfo[];
  uncategorized: ChannelInfo[];
}

export interface FileAttachment {
  file: Buffer | string;
  name?: string;
  description?: string;
}

export class DiscordClient extends EventEmitter {
  private client: Client;
  private _isReady: boolean = false;
  private ownerUserId: string;
  private botUserId: string | null = null;
  private processedMessages: Set<string> = new Set();

  constructor(ownerUserId: string) {
    super();
    this.ownerUserId = ownerUserId;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageTyping,
      ],
      // Required for DMs
      partials: [1, 2], // Channel, Message
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.once('ready', () => {
      this._isReady = true;
      this.botUserId = this.client.user?.id || null;
      console.error(`[Discord] Ready as ${this.client.user?.tag}`);
      console.error(`[Discord] Bot User ID: ${this.botUserId}`);
      this.emit('ready');
    });

    this.client.on('presenceUpdate', (oldPresence, newPresence) => {
      if (newPresence.userId !== this.ownerUserId) return;

      const isOnline = newPresence.status === 'online' ||
                       newPresence.status === 'idle' ||
                       newPresence.status === 'dnd';

      this.emit('ownerPresenceChange', isOnline);

      // Update bot presence to mirror owner
      this.updatePresence(isOnline ? 'online' : 'invisible');
    });

    this.client.on('messageCreate', async (message) => {
      // Ignore bot's own messages
      if (message.author.id === this.botUserId) return;

      // Ignore messages from any bot
      if (message.author.bot) return;

      // Check if this is a DM or a mention
      const isDM = message.channel.type === ChannelType.DM;
      const isMentioned = message.mentions.has(this.botUserId || '');

      // Process if it's a DM OR if bot is mentioned in a server
      if (!isDM && !isMentioned) return;

      // Deduplicate - prevent processing same message twice
      if (this.processedMessages.has(message.id)) {
        console.error(`[Discord] Skipping duplicate message ${message.id}`);
        return;
      }
      this.processedMessages.add(message.id);

      // Clean up old message IDs (keep last 100)
      if (this.processedMessages.size > 100) {
        const toDelete = Array.from(this.processedMessages).slice(0, 50);
        toDelete.forEach(id => this.processedMessages.delete(id));
      }

      const mentionEvent: MentionEvent = {
        channelId: message.channelId,
        channelName: isDM ? 'DM' : (message.channel as TextChannel).name,
        guildName: message.guild?.name || null,
        authorId: message.author.id,
        authorTag: message.author.tag,
        content: message.content,
        timestamp: message.createdAt,
        message: message,
        isDM: isDM
      };

      // Emit different events for DMs vs mentions
      if (isDM) {
        this.emit('dm', mentionEvent);
      } else {
        this.emit('mention', mentionEvent);
      }
    });

    this.client.on('error', (error) => {
      console.error('Discord client error:', error);
      this.emit('error', error);
    });
  }

  async login(token: string): Promise<void> {
    await this.client.login(token);
  }

  updatePresence(status: 'online' | 'idle' | 'dnd' | 'invisible'): void {
    this.client.user?.setPresence({
      status: status,
      activities: status === 'online'
        ? [{ name: 'Online', type: ActivityType.Custom }]
        : []
    });
    console.error(`[Discord] Presence updated to: ${status}`);
  }

  async sendMessage(
    channelId: string,
    content: string,
    attachments?: FileAttachment[]
  ): Promise<Message | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) {
        console.error(`Channel ${channelId} not found`);
        return null;
      }

      // Allow text channels, DMs, and all thread types (including forum posts)
      const allowedTypes = [
        ChannelType.GuildText,
        ChannelType.DM,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (allowedTypes.includes(channel.type)) {
        const textChannel = channel as TextChannel | DMChannel | ThreadChannel;

        // Build message options
        const messageOptions: { content?: string; files?: AttachmentBuilder[] } = {};

        if (content) {
          messageOptions.content = content;
        }

        if (attachments && attachments.length > 0) {
          messageOptions.files = attachments.map(att => {
            const builder = new AttachmentBuilder(att.file);
            if (att.name) builder.setName(att.name);
            if (att.description) builder.setDescription(att.description);
            return builder;
          });
        }

        const sent = await textChannel.send(messageOptions);
        console.error(`[Discord] Message sent to ${channelId}${attachments ? ` with ${attachments.length} attachment(s)` : ''}`);
        return sent;
      }

      console.error(`Channel ${channelId} is not a sendable channel type (type: ${channel.type})`);
      return null;
    } catch (error) {
      console.error(`Failed to send message to ${channelId}:`, error);
      return null;
    }
  }

  async replyToMessage(
    message: Message,
    content: string,
    attachments?: FileAttachment[]
  ): Promise<Message | null> {
    try {
      const replyOptions: { content?: string; files?: AttachmentBuilder[] } = {};

      if (content) {
        replyOptions.content = content;
      }

      if (attachments && attachments.length > 0) {
        replyOptions.files = attachments.map(att => {
          const builder = new AttachmentBuilder(att.file);
          if (att.name) builder.setName(att.name);
          if (att.description) builder.setDescription(att.description);
          return builder;
        });
      }

      const sent = await message.reply(replyOptions);
      console.error(`[Discord] Replied to message in ${message.channelId}${attachments ? ` with ${attachments.length} attachment(s)` : ''}`);
      return sent;
    } catch (error) {
      console.error(`Failed to reply to message:`, error);
      return null;
    }
  }

  async sendDM(
    userId: string,
    content: string,
    attachments?: FileAttachment[]
  ): Promise<Message | null> {
    try {
      const user = await this.client.users.fetch(userId);
      if (!user) {
        console.error(`User ${userId} not found`);
        return null;
      }

      const dmChannel = await user.createDM();

      const messageOptions: { content?: string; files?: AttachmentBuilder[] } = {};

      if (content) {
        messageOptions.content = content;
      }

      if (attachments && attachments.length > 0) {
        messageOptions.files = attachments.map(att => {
          const builder = new AttachmentBuilder(att.file);
          if (att.name) builder.setName(att.name);
          if (att.description) builder.setDescription(att.description);
          return builder;
        });
      }

      const sent = await dmChannel.send(messageOptions);
      console.error(`[Discord] DM sent to ${user.tag}${attachments ? ` with ${attachments.length} attachment(s)` : ''}`);
      return sent;
    } catch (error) {
      console.error(`Failed to send DM to ${userId}:`, error);
      return null;
    }
  }

  async sendFile(
    channelId: string,
    file: Buffer | string,
    options?: { name?: string; description?: string; content?: string }
  ): Promise<Message | null> {
    const attachment: FileAttachment = {
      file: file,
      name: options?.name,
      description: options?.description
    };
    return this.sendMessage(channelId, options?.content || '', [attachment]);
  }

  async getRecentMessages(channelId: string, limit: number = 50): Promise<Message[]> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) {
        console.error(`Channel ${channelId} not found`);
        return [];
      }

      // Allow text channels, DMs, and all thread types (including forum posts)
      const allowedTypes = [
        ChannelType.GuildText,
        ChannelType.DM,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (allowedTypes.includes(channel.type)) {
        const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
        const messages = await textChannel.messages.fetch({ limit });
        // Return in chronological order (oldest first)
        return Array.from(messages.values()).reverse();
      }

      console.error(`Channel ${channelId} is not a readable channel type (type: ${channel.type})`);
      return [];
    } catch (error) {
      console.error(`Failed to fetch messages from ${channelId}:`, error);
      return [];
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.DM)) {
        await (channel as TextChannel | DMChannel).sendTyping();
      }
    } catch (error) {
      // Ignore typing errors
    }
  }

  get isReady(): boolean {
    return this._isReady;
  }

  get user(): User | null {
    return this.client.user;
  }

  isOwner(userId: string): boolean {
    return userId === this.ownerUserId;
  }

  async listServerChannels(serverId: string): Promise<ServerChannels | null> {
    try {
      const guild = await this.client.guilds.fetch(serverId);
      if (!guild) {
        console.error(`[Discord] Server ${serverId} not found`);
        return null;
      }

      // Fetch all channels
      const channels = await guild.channels.fetch();

      // Map channel type to readable string
      const getChannelType = (type: ChannelType): string => {
        switch (type) {
          case ChannelType.GuildText: return 'text';
          case ChannelType.GuildVoice: return 'voice';
          case ChannelType.GuildCategory: return 'category';
          case ChannelType.GuildAnnouncement: return 'announcement';
          case ChannelType.GuildForum: return 'forum';
          case ChannelType.GuildStageVoice: return 'stage';
          default: return 'other';
        }
      };

      // Organize by category
      const categories: Map<string, CategoryInfo> = new Map();
      const uncategorized: ChannelInfo[] = [];

      // First pass: collect categories
      channels.forEach(channel => {
        if (channel && channel.type === ChannelType.GuildCategory) {
          categories.set(channel.id, {
            id: channel.id,
            name: channel.name,
            position: channel.position,
            channels: []
          });
        }
      });

      // Second pass: assign channels to categories
      channels.forEach(channel => {
        if (!channel || channel.type === ChannelType.GuildCategory) return;

        const channelInfo: ChannelInfo = {
          id: channel.id,
          name: channel.name,
          type: getChannelType(channel.type),
          position: 'position' in channel ? channel.position : 0
        };

        const parentId = 'parentId' in channel ? channel.parentId : null;

        if (parentId && categories.has(parentId)) {
          categories.get(parentId)!.channels.push(channelInfo);
        } else {
          uncategorized.push(channelInfo);
        }
      });

      // Sort categories and their channels by position
      const sortedCategories = Array.from(categories.values())
        .sort((a, b) => a.position - b.position)
        .map(cat => ({
          ...cat,
          channels: cat.channels.sort((a, b) => a.position - b.position)
        }));

      uncategorized.sort((a, b) => a.position - b.position);

      return {
        serverName: guild.name,
        serverId: guild.id,
        categories: sortedCategories,
        uncategorized
      };
    } catch (error) {
      console.error(`[Discord] Failed to list channels for server ${serverId}:`, error);
      return null;
    }
  }

  // ============================================
  // Priority 1: Channel & Category Management
  // ============================================

  async createChannel(
    serverId: string,
    name: string,
    type: 'text' | 'voice' | 'forum' | 'announcement' = 'text',
    options?: { categoryId?: string; topic?: string; nsfw?: boolean }
  ): Promise<{ id: string; name: string } | null> {
    try {
      const guild = await this.client.guilds.fetch(serverId);
      if (!guild) return null;

      const channelTypeMap: Record<string, ChannelType.GuildText | ChannelType.GuildVoice | ChannelType.GuildForum | ChannelType.GuildAnnouncement> = {
        'text': ChannelType.GuildText,
        'voice': ChannelType.GuildVoice,
        'forum': ChannelType.GuildForum,
        'announcement': ChannelType.GuildAnnouncement
      };
      const channelType = channelTypeMap[type] ?? ChannelType.GuildText;

      const channel = await guild.channels.create({
        name: name,
        type: channelType,
        parent: options?.categoryId,
        topic: options?.topic,
        nsfw: options?.nsfw || false
      });

      console.error(`[Discord] Created channel #${channel.name} (${channel.id})`);
      return { id: channel.id, name: channel.name };
    } catch (error) {
      console.error(`[Discord] Failed to create channel:`, error);
      return null;
    }
  }

  async setChannelTopic(channelId: string, topic: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('setTopic' in channel)) return false;

      await (channel as TextChannel).setTopic(topic);
      console.error(`[Discord] Set topic for channel ${channelId}`);
      return true;
    } catch (error) {
      console.error(`[Discord] Failed to set channel topic:`, error);
      return false;
    }
  }

  async renameChannel(channelId: string, newName: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('setName' in channel)) return false;

      await (channel as GuildChannel).setName(newName);
      console.error(`[Discord] Renamed channel to #${newName}`);
      return true;
    } catch (error) {
      console.error(`[Discord] Failed to rename channel:`, error);
      return false;
    }
  }

  async deleteChannel(channelId: string, reason?: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('delete' in channel)) return false;

      await (channel as GuildChannel).delete(reason);
      console.error(`[Discord] Deleted channel ${channelId}`);
      return true;
    } catch (error) {
      console.error(`[Discord] Failed to delete channel:`, error);
      return false;
    }
  }

  async createCategory(
    serverId: string,
    name: string,
    position?: number
  ): Promise<{ id: string; name: string } | null> {
    try {
      const guild = await this.client.guilds.fetch(serverId);
      if (!guild) return null;

      const category = await guild.channels.create({
        name: name,
        type: ChannelType.GuildCategory,
        position: position
      });

      console.error(`[Discord] Created category ${category.name} (${category.id})`);
      return { id: category.id, name: category.name };
    } catch (error) {
      console.error(`[Discord] Failed to create category:`, error);
      return null;
    }
  }

  async moveChannel(
    channelId: string,
    categoryId?: string | null,
    position?: number
  ): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('setParent' in channel)) return false;

      const guildChannel = channel as GuildChannel;

      if (categoryId !== undefined) {
        await guildChannel.setParent(categoryId);
      }

      if (position !== undefined) {
        await guildChannel.setPosition(position);
      }

      console.error(`[Discord] Moved channel ${channelId}`);
      return true;
    } catch (error) {
      console.error(`[Discord] Failed to move channel:`, error);
      return false;
    }
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);

      // Allow text channels, DMs, and all thread types (including forum posts)
      const allowedTypes = [
        ChannelType.GuildText,
        ChannelType.DM,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (!channel || !allowedTypes.includes(channel.type)) return false;

      const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
      const message = await textChannel.messages.fetch(messageId);
      await message.react(emoji);

      console.error(`[Discord] Added reaction ${emoji} to message ${messageId}`);
      return true;
    } catch (error) {
      console.error(`[Discord] Failed to add reaction:`, error);
      return false;
    }
  }

  async getReactions(channelId: string, messageId: string): Promise<Array<{
    emoji: string;
    count: number;
    users: Array<{ id: string; tag: string }>;
  }> | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);

      const allowedTypes = [
        ChannelType.GuildText,
        ChannelType.DM,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (!channel || !allowedTypes.includes(channel.type)) return null;

      const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
      const message = await textChannel.messages.fetch(messageId);

      if (message.reactions.cache.size === 0) {
        return [];
      }

      const reactions: Array<{
        emoji: string;
        count: number;
        users: Array<{ id: string; tag: string }>;
      }> = [];

      for (const [, reaction] of message.reactions.cache) {
        // Fetch users who reacted (up to 100)
        const users = await reaction.users.fetch({ limit: 100 });

        reactions.push({
          emoji: reaction.emoji.name || reaction.emoji.toString(),
          count: reaction.count,
          users: Array.from(users.values()).map(user => ({
            id: user.id,
            tag: user.tag
          }))
        });
      }

      console.error(`[Discord] Fetched ${reactions.length} reaction types from message ${messageId}`);
      return reactions;
    } catch (error) {
      console.error(`[Discord] Failed to get reactions:`, error);
      return null;
    }
  }

  // ============================================
  // Polls
  // ============================================

  async createPoll(
    channelId: string,
    question: string,
    options: Array<{ text: string; emoji?: string }>,
    durationHours: number = 24,
    allowMultiselect: boolean = false
  ): Promise<{ messageId: string } | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);

      const allowedTypes = [
        ChannelType.GuildText,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (!channel || !allowedTypes.includes(channel.type)) {
        console.error(`[Discord] Channel ${channelId} does not support polls`);
        return null;
      }

      const textChannel = channel as TextChannel | ThreadChannel;

      // Build poll answers (max 10 options)
      const answers = options.slice(0, 10).map(opt => ({
        text: opt.text,
        emoji: opt.emoji ? opt.emoji : undefined
      }));

      const message = await textChannel.send({
        poll: {
          question: { text: question },
          answers: answers,
          duration: Math.min(Math.max(durationHours, 1), 768), // 1 hour to 32 days
          allowMultiselect: allowMultiselect
        }
      });

      console.error(`[Discord] Created poll in ${channelId}: "${question}"`);
      return { messageId: message.id };
    } catch (error) {
      console.error(`[Discord] Failed to create poll:`, error);
      return null;
    }
  }

  // ============================================
  // Priority 2: Message Management
  // ============================================

  async editMessage(channelId: string, messageId: string, newContent: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);

      // Allow text channels, DMs, and all thread types (including forum posts)
      const allowedTypes = [
        ChannelType.GuildText,
        ChannelType.DM,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (!channel || !allowedTypes.includes(channel.type)) return false;

      const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
      const message = await textChannel.messages.fetch(messageId);

      // Can only edit own messages
      if (message.author.id !== this.botUserId) {
        console.error(`[Discord] Cannot edit message - not authored by bot`);
        return false;
      }

      await message.edit(newContent);
      console.error(`[Discord] Edited message ${messageId}`);
      return true;
    } catch (error) {
      console.error(`[Discord] Failed to edit message:`, error);
      return false;
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);

      // Allow text channels, DMs, and all thread types (including forum posts)
      const allowedTypes = [
        ChannelType.GuildText,
        ChannelType.DM,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (!channel || !allowedTypes.includes(channel.type)) return false;

      const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
      const message = await textChannel.messages.fetch(messageId);
      await message.delete();

      console.error(`[Discord] Deleted message ${messageId}`);
      return true;
    } catch (error) {
      console.error(`[Discord] Failed to delete message:`, error);
      return false;
    }
  }

  async pinMessage(channelId: string, messageId: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);

      // Allow text channels, DMs, and all thread types (including forum posts)
      const allowedTypes = [
        ChannelType.GuildText,
        ChannelType.DM,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (!channel || !allowedTypes.includes(channel.type)) return false;

      const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
      const message = await textChannel.messages.fetch(messageId);
      await message.pin();

      console.error(`[Discord] Pinned message ${messageId}`);
      return true;
    } catch (error) {
      console.error(`[Discord] Failed to pin message:`, error);
      return false;
    }
  }

  async createThread(
    channelId: string,
    name: string,
    messageId?: string,
    autoArchiveDuration?: 60 | 1440 | 4320 | 10080
  ): Promise<string | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildText) return null;

      const textChannel = channel as TextChannel;

      let thread: ThreadChannel;
      if (messageId) {
        const message = await textChannel.messages.fetch(messageId);
        thread = await message.startThread({
          name: name,
          autoArchiveDuration: autoArchiveDuration || 1440
        });
      } else {
        thread = await textChannel.threads.create({
          name: name,
          autoArchiveDuration: autoArchiveDuration || 1440
        });
      }

      console.error(`[Discord] Created thread ${thread.name} (${thread.id})`);
      return thread.id;
    } catch (error) {
      console.error(`[Discord] Failed to create thread:`, error);
      return null;
    }
  }

  async createForumPost(
    channelId: string,
    title: string,
    content: string,
    tags?: string[]
  ): Promise<{ threadId: string; messageId: string } | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildForum) {
        console.error(`[Discord] Channel ${channelId} is not a forum channel`);
        return null;
      }

      const forumChannel = channel as ForumChannel;
      const thread = await forumChannel.threads.create({
        name: title,
        message: { content: content },
        appliedTags: tags || []
      });

      console.error(`[Discord] Created forum post "${title}" (${thread.id})`);
      return {
        threadId: thread.id,
        messageId: thread.lastMessageId || thread.id
      };
    } catch (error) {
      console.error(`[Discord] Failed to create forum post:`, error);
      return null;
    }
  }

  async listForumThreads(
    channelId: string,
    limit: number = 20,
    archived: boolean = false
  ): Promise<Array<{
    id: string;
    name: string;
    createdAt: string;
    messageCount: number;
    archived: boolean;
  }>> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildForum) {
        console.error(`[Discord] Channel ${channelId} is not a forum channel`);
        return [];
      }

      const forumChannel = channel as ForumChannel;

      // Fetch active threads
      const activeThreads = await forumChannel.threads.fetchActive();

      // Optionally fetch archived threads
      let archivedThreads: ThreadChannel[] = [];
      if (archived) {
        const fetchedArchived = await forumChannel.threads.fetchArchived({ limit });
        archivedThreads = Array.from(fetchedArchived.threads.values());
      }

      // Combine and format
      const allThreads = [
        ...Array.from(activeThreads.threads.values()),
        ...archivedThreads
      ];

      const result = allThreads.slice(0, limit).map(thread => ({
        id: thread.id,
        name: thread.name,
        createdAt: thread.createdAt?.toISOString() || 'unknown',
        messageCount: thread.messageCount || 0,
        archived: thread.archived || false
      }));

      console.error(`[Discord] Found ${result.length} threads in forum ${channelId}`);
      return result;
    } catch (error) {
      console.error(`[Discord] Failed to list forum threads:`, error);
      return [];
    }
  }

  // ============================================
  // Priority 3: Moderation
  // ============================================

  async timeoutUser(
    serverId: string,
    userId: string,
    durationMinutes: number,
    reason?: string
  ): Promise<boolean> {
    try {
      const guild = await this.client.guilds.fetch(serverId);
      if (!guild) return false;

      const member = await guild.members.fetch(userId);
      const duration = Math.min(durationMinutes, 40320) * 60 * 1000; // Convert to ms, max 28 days

      await member.timeout(duration, reason);
      console.error(`[Discord] Timed out user ${userId} for ${durationMinutes} minutes`);
      return true;
    } catch (error) {
      console.error(`[Discord] Failed to timeout user:`, error);
      return false;
    }
  }

  async assignRole(serverId: string, userId: string, roleId: string, reason?: string): Promise<boolean> {
    try {
      const guild = await this.client.guilds.fetch(serverId);
      if (!guild) return false;

      const member = await guild.members.fetch(userId);
      await member.roles.add(roleId, reason);

      console.error(`[Discord] Assigned role ${roleId} to user ${userId}`);
      return true;
    } catch (error) {
      console.error(`[Discord] Failed to assign role:`, error);
      return false;
    }
  }

  async removeRole(serverId: string, userId: string, roleId: string, reason?: string): Promise<boolean> {
    try {
      const guild = await this.client.guilds.fetch(serverId);
      if (!guild) return false;

      const member = await guild.members.fetch(userId);
      await member.roles.remove(roleId, reason);

      console.error(`[Discord] Removed role ${roleId} from user ${userId}`);
      return true;
    } catch (error) {
      console.error(`[Discord] Failed to remove role:`, error);
      return false;
    }
  }

  // ============================================
  // Priority 4: Awareness
  // ============================================

  async listMembers(serverId: string, limit: number = 100): Promise<Array<{ id: string; tag: string; roles: string[] }> | null> {
    try {
      const guild = await this.client.guilds.fetch(serverId);
      if (!guild) return null;

      const members = await guild.members.fetch({ limit });

      return Array.from(members.values()).map(member => ({
        id: member.id,
        tag: member.user.tag,
        roles: member.roles.cache.map(role => role.name)
      }));
    } catch (error) {
      console.error(`[Discord] Failed to list members:`, error);
      return null;
    }
  }

  async getUserInfo(serverId: string, userId: string): Promise<{
    id: string;
    tag: string;
    displayName: string;
    joinedAt: string | null;
    roles: Array<{ id: string; name: string }>;
    isOnline: boolean;
    status: string;
  } | null> {
    try {
      const guild = await this.client.guilds.fetch(serverId);
      if (!guild) return null;

      const member = await guild.members.fetch(userId);

      return {
        id: member.id,
        tag: member.user.tag,
        displayName: member.displayName,
        joinedAt: member.joinedAt?.toISOString() || null,
        roles: member.roles.cache.map(role => ({ id: role.id, name: role.name })),
        isOnline: member.presence?.status !== 'offline',
        status: member.presence?.status || 'offline'
      };
    } catch (error) {
      console.error(`[Discord] Failed to get user info:`, error);
      return null;
    }
  }

  async listRoles(serverId: string): Promise<Array<{ id: string; name: string; color: string; position: number }> | null> {
    try {
      const guild = await this.client.guilds.fetch(serverId);
      if (!guild) return null;

      const roles = await guild.roles.fetch();

      return Array.from(roles.values())
        .sort((a, b) => b.position - a.position)
        .map(role => ({
          id: role.id,
          name: role.name,
          color: role.hexColor,
          position: role.position
        }));
    } catch (error) {
      console.error(`[Discord] Failed to list roles:`, error);
      return null;
    }
  }

  // ============================================
  // Attachment Handling
  // ============================================

  async fetchAttachment(
    channelId: string,
    messageId: string,
    specificFilename?: string
  ): Promise<{ downloaded: string[]; errors: string[] }> {
    // Use environment variable or default to .discord_attachments in project root
    const cacheDir = process.env.DISCORD_ATTACHMENTS_DIR || path.resolve(__dirname, '../.discord_attachments');
    const downloaded: string[] = [];
    const errors: string[] = [];

    try {
      // Ensure cache directory exists
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      const channel = await this.client.channels.fetch(channelId);

      // Allow text channels, DMs, and all thread types
      const allowedTypes = [
        ChannelType.GuildText,
        ChannelType.DM,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (!channel || !allowedTypes.includes(channel.type)) {
        errors.push('Channel not accessible or not a text-based channel');
        return { downloaded, errors };
      }

      const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
      const message = await textChannel.messages.fetch(messageId);

      if (message.attachments.size === 0) {
        errors.push('Message has no attachments');
        return { downloaded, errors };
      }

      // Filter attachments if specific filename requested
      let attachments = Array.from(message.attachments.values());
      if (specificFilename) {
        attachments = attachments.filter(att => att.name === specificFilename);
        if (attachments.length === 0) {
          errors.push(`No attachment named "${specificFilename}" found`);
          return { downloaded, errors };
        }
      }

      // Download each attachment
      for (const attachment of attachments) {
        const safeName = attachment.name?.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
        const localPath = path.join(cacheDir, `${messageId}_${safeName}`);

        try {
          await this.downloadFile(attachment.url, localPath);
          downloaded.push(localPath);
          console.error(`[Discord] Downloaded attachment to ${localPath}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push(`Failed to download ${attachment.name}: ${errMsg}`);
        }
      }

      return { downloaded, errors };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to fetch message: ${errMsg}`);
      return { downloaded, errors };
    }
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);

      https.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            file.close();
            fs.unlinkSync(destPath);
            this.downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });

        file.on('error', (err) => {
          file.close();
          fs.unlinkSync(destPath);
          reject(err);
        });
      }).on('error', (err) => {
        file.close();
        fs.unlinkSync(destPath);
        reject(err);
      });
    });
  }
}
