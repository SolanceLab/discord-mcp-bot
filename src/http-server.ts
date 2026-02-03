/**
 * HTTP API Server for Discord MCP Bot
 *
 * Wraps all discordClient methods behind authenticated HTTP endpoints.
 * This enables multiple MCP clients (Desktop, Code, etc.) to share
 * one Discord bot instance via HTTP instead of fighting over stdio.
 *
 * Auth: Bearer token in Authorization header.
 * All endpoints are POST to keep tokens out of URLs/logs.
 */

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { DiscordClient } from './discord-client.js';
import { MemoryManager } from './memory.js';
import { logger } from './logger.js';

// --- Rate Limiter ---

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

class RateLimiter {
  private entries: Map<string, RateLimitEntry> = new Map();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number = 60, windowMs: number = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = this.entries.get(ip);

    if (!entry || now > entry.resetAt) {
      this.entries.set(ip, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.maxRequests - 1, resetAt: now + this.windowMs };
    }

    entry.count++;
    const allowed = entry.count <= this.maxRequests;
    return { allowed, remaining: Math.max(0, this.maxRequests - entry.count), resetAt: entry.resetAt };
  }

  // Clean expired entries periodically
  cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.entries) {
      if (now > entry.resetAt) {
        this.entries.delete(ip);
      }
    }
  }
}

// --- Auth Middleware ---

function createAuthMiddleware(apiSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Health check doesn't need auth
    if (req.path === '/health') {
      next();
      return;
    }

    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Invalid Authorization format. Use: Bearer <token>' });
      return;
    }

    const token = authHeader.slice(7);

    // Constant-time comparison to prevent timing attacks
    const expected = Buffer.from(apiSecret);
    const received = Buffer.from(token);

    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      logger.warn('HTTP', `Unauthorized request from ${req.ip}`, { path: req.path });
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    next();
  };
}

// --- Rate Limit Middleware ---

function createRateLimitMiddleware(limiter: RateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const { allowed, remaining, resetAt } = limiter.check(ip);

    res.setHeader('X-RateLimit-Remaining', remaining.toString());
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000).toString());

    if (!allowed) {
      logger.warn('HTTP', `Rate limited ${ip}`, { path: req.path });
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    next();
  };
}

// --- Server Setup ---

export function createHttpServer(
  discordClient: DiscordClient,
  memory: MemoryManager,
  apiSecret: string,
  port: number = 3000
) {
  const app = express();
  const rateLimiter = new RateLimiter(60, 60_000); // 60 requests per minute

  // Cleanup rate limiter every 5 minutes
  setInterval(() => rateLimiter.cleanup(), 5 * 60_000);

  // Middleware
  app.use(express.json({ limit: '10mb' })); // 10mb for file uploads (base64)
  app.use(createRateLimitMiddleware(rateLimiter));
  app.use(createAuthMiddleware(apiSecret));

  // --- Health Check (no auth required) ---

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      discord: discordClient.isReady ? 'connected' : 'disconnected',
      uptime: process.uptime(),
    });
  });

  // --- Message Tools ---

  app.post('/api/read-messages', async (req: Request, res: Response) => {
    try {
      const { channel_id, limit = 20 } = req.body;
      if (!channel_id) {
        res.status(400).json({ error: 'channel_id required' });
        return;
      }

      const messages = await discordClient.getRecentMessages(channel_id, Math.min(limit, 50));

      const formatted = messages.map(msg => ({
        id: msg.id,
        author: msg.author.tag,
        authorId: msg.author.id,
        content: msg.content,
        timestamp: msg.createdAt.toISOString(),
        attachments: msg.attachments.map(att => ({
          name: att.name,
          url: att.url,
          contentType: att.contentType,
          width: att.width,
          height: att.height,
        })),
      }));

      res.json({ messages: formatted });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/send-message', async (req: Request, res: Response) => {
    try {
      const { channel_id, content } = req.body;
      if (!channel_id || !content) {
        res.status(400).json({ error: 'channel_id and content required' });
        return;
      }

      const sent = await discordClient.sendMessage(channel_id, content);
      if (sent) {
        await memory.addMessage(channel_id, {
          role: 'assistant',
          content,
          timestamp: new Date().toISOString(),
        });
        res.json({ success: true, message_id: sent.id });
      } else {
        res.status(500).json({ error: 'Failed to send message' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/send-dm', async (req: Request, res: Response) => {
    try {
      const { user_id, content } = req.body;
      if (!user_id || !content) {
        res.status(400).json({ error: 'user_id and content required' });
        return;
      }

      const sent = await discordClient.sendDM(user_id, content);
      if (sent) {
        res.json({ success: true, message_id: sent.id });
      } else {
        res.status(500).json({ error: 'Failed to send DM' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/send-file', async (req: Request, res: Response) => {
    try {
      const { channel_id, file_data, file_name, content } = req.body;
      if (!channel_id || !file_data || !file_name) {
        res.status(400).json({ error: 'channel_id, file_data (base64), and file_name required' });
        return;
      }

      const fileBuffer = Buffer.from(file_data, 'base64');
      const sent = await discordClient.sendFile(channel_id, fileBuffer, {
        name: file_name,
        content,
      });

      if (sent) {
        res.json({ success: true, message_id: sent.id });
      } else {
        res.status(500).json({ error: 'Failed to send file' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Channel Management ---

  app.post('/api/list-channels', async (req: Request, res: Response) => {
    try {
      const { server_id } = req.body;
      if (!server_id) {
        res.status(400).json({ error: 'server_id required' });
        return;
      }

      const channels = await discordClient.listServerChannels(server_id);
      if (channels) {
        res.json(channels);
      } else {
        res.status(404).json({ error: 'Server not found' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/create-channel', async (req: Request, res: Response) => {
    try {
      const { server_id, name, type = 'text', category_id, topic, nsfw } = req.body;
      if (!server_id || !name) {
        res.status(400).json({ error: 'server_id and name required' });
        return;
      }

      const result = await discordClient.createChannel(server_id, name, type, {
        categoryId: category_id,
        topic,
        nsfw,
      });

      if (result) {
        res.json({ success: true, ...result });
      } else {
        res.status(500).json({ error: 'Failed to create channel' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/set-channel-topic', async (req: Request, res: Response) => {
    try {
      const { channel_id, topic } = req.body;
      if (!channel_id || topic === undefined) {
        res.status(400).json({ error: 'channel_id and topic required' });
        return;
      }

      const success = await discordClient.setChannelTopic(channel_id, topic);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/rename-channel', async (req: Request, res: Response) => {
    try {
      const { channel_id, new_name } = req.body;
      if (!channel_id || !new_name) {
        res.status(400).json({ error: 'channel_id and new_name required' });
        return;
      }

      const success = await discordClient.renameChannel(channel_id, new_name);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/delete-channel', async (req: Request, res: Response) => {
    try {
      const { channel_id, reason } = req.body;
      if (!channel_id) {
        res.status(400).json({ error: 'channel_id required' });
        return;
      }

      const success = await discordClient.deleteChannel(channel_id, reason);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/create-category', async (req: Request, res: Response) => {
    try {
      const { server_id, name, position } = req.body;
      if (!server_id || !name) {
        res.status(400).json({ error: 'server_id and name required' });
        return;
      }

      const result = await discordClient.createCategory(server_id, name, position);
      if (result) {
        res.json({ success: true, ...result });
      } else {
        res.status(500).json({ error: 'Failed to create category' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/move-channel', async (req: Request, res: Response) => {
    try {
      const { channel_id, category_id, position } = req.body;
      if (!channel_id) {
        res.status(400).json({ error: 'channel_id required' });
        return;
      }

      const success = await discordClient.moveChannel(channel_id, category_id, position);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Reactions & Polls ---

  app.post('/api/add-reaction', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id, emoji } = req.body;
      if (!channel_id || !message_id || !emoji) {
        res.status(400).json({ error: 'channel_id, message_id, and emoji required' });
        return;
      }

      const success = await discordClient.addReaction(channel_id, message_id, emoji);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/get-reactions', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id } = req.body;
      if (!channel_id || !message_id) {
        res.status(400).json({ error: 'channel_id and message_id required' });
        return;
      }

      const reactions = await discordClient.getReactions(channel_id, message_id);
      if (reactions !== null) {
        res.json({ reactions });
      } else {
        res.status(500).json({ error: 'Failed to fetch reactions' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/create-poll', async (req: Request, res: Response) => {
    try {
      const { channel_id, question, options, duration_hours = 24, allow_multiselect = false } = req.body;
      if (!channel_id || !question || !options || options.length < 2) {
        res.status(400).json({ error: 'channel_id, question, and options (min 2) required' });
        return;
      }

      const result = await discordClient.createPoll(channel_id, question, options, duration_hours, allow_multiselect);
      if (result) {
        res.json({ success: true, ...result });
      } else {
        res.status(500).json({ error: 'Failed to create poll' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Message Management ---

  app.post('/api/edit-message', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id, new_content } = req.body;
      if (!channel_id || !message_id || !new_content) {
        res.status(400).json({ error: 'channel_id, message_id, and new_content required' });
        return;
      }

      const success = await discordClient.editMessage(channel_id, message_id, new_content);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/delete-message', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id } = req.body;
      if (!channel_id || !message_id) {
        res.status(400).json({ error: 'channel_id and message_id required' });
        return;
      }

      const success = await discordClient.deleteMessage(channel_id, message_id);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/pin-message', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id } = req.body;
      if (!channel_id || !message_id) {
        res.status(400).json({ error: 'channel_id and message_id required' });
        return;
      }

      const success = await discordClient.pinMessage(channel_id, message_id);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Threads & Forums ---

  app.post('/api/create-thread', async (req: Request, res: Response) => {
    try {
      const { channel_id, name, message_id, auto_archive_duration } = req.body;
      if (!channel_id || !name) {
        res.status(400).json({ error: 'channel_id and name required' });
        return;
      }

      const threadId = await discordClient.createThread(channel_id, name, message_id, auto_archive_duration);
      if (threadId) {
        res.json({ success: true, thread_id: threadId });
      } else {
        res.status(500).json({ error: 'Failed to create thread' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/create-forum-post', async (req: Request, res: Response) => {
    try {
      const { channel_id, title, content, tags } = req.body;
      if (!channel_id || !title || !content) {
        res.status(400).json({ error: 'channel_id, title, and content required' });
        return;
      }

      const result = await discordClient.createForumPost(channel_id, title, content, tags);
      if (result) {
        res.json({ success: true, ...result });
      } else {
        res.status(500).json({ error: 'Failed to create forum post' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/list-forum-threads', async (req: Request, res: Response) => {
    try {
      const { channel_id, limit = 20, include_archived = false } = req.body;
      if (!channel_id) {
        res.status(400).json({ error: 'channel_id required' });
        return;
      }

      const threads = await discordClient.listForumThreads(channel_id, limit, include_archived);
      res.json({ threads });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Attachments ---

  app.post('/api/get-attachment-urls', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id, filename } = req.body;
      if (!channel_id || !message_id) {
        res.status(400).json({ error: 'channel_id and message_id required' });
        return;
      }

      // Access the underlying discord.js client to fetch the specific message
      const channel = await (discordClient as any).client.channels.fetch(channel_id);
      if (!channel || !('messages' in channel)) {
        res.status(404).json({ error: 'Channel not found or not readable' });
        return;
      }

      const message = await (channel as any).messages.fetch(message_id);
      if (!message || message.attachments.size === 0) {
        res.status(404).json({ error: 'No attachments found on this message' });
        return;
      }

      let attachments = Array.from(message.attachments.values()) as any[];
      if (filename) {
        attachments = attachments.filter((att: any) => att.name === filename);
      }

      // Return fresh CDN URLs (not base64 -- keeps response size small)
      const urls = attachments.map((att: any) => ({
        name: att.name,
        url: att.url,
        contentType: att.contentType || 'application/octet-stream',
        size: att.size,
        width: att.width,
        height: att.height,
      }));

      res.json({ attachments: urls });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Moderation ---

  app.post('/api/timeout-user', async (req: Request, res: Response) => {
    try {
      const { server_id, user_id, duration_minutes, reason } = req.body;
      if (!server_id || !user_id || !duration_minutes) {
        res.status(400).json({ error: 'server_id, user_id, and duration_minutes required' });
        return;
      }

      const success = await discordClient.timeoutUser(server_id, user_id, duration_minutes, reason);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/assign-role', async (req: Request, res: Response) => {
    try {
      const { server_id, user_id, role_id, reason } = req.body;
      if (!server_id || !user_id || !role_id) {
        res.status(400).json({ error: 'server_id, user_id, and role_id required' });
        return;
      }

      const success = await discordClient.assignRole(server_id, user_id, role_id, reason);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/remove-role', async (req: Request, res: Response) => {
    try {
      const { server_id, user_id, role_id, reason } = req.body;
      if (!server_id || !user_id || !role_id) {
        res.status(400).json({ error: 'server_id, user_id, and role_id required' });
        return;
      }

      const success = await discordClient.removeRole(server_id, user_id, role_id, reason);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Awareness ---

  app.post('/api/list-members', async (req: Request, res: Response) => {
    try {
      const { server_id, limit = 100 } = req.body;
      if (!server_id) {
        res.status(400).json({ error: 'server_id required' });
        return;
      }

      const members = await discordClient.listMembers(server_id, limit);
      if (members) {
        res.json({ members });
      } else {
        res.status(404).json({ error: 'Server not found' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/get-user-info', async (req: Request, res: Response) => {
    try {
      const { server_id, user_id } = req.body;
      if (!server_id || !user_id) {
        res.status(400).json({ error: 'server_id and user_id required' });
        return;
      }

      const userInfo = await discordClient.getUserInfo(server_id, user_id);
      if (userInfo) {
        res.json(userInfo);
      } else {
        res.status(404).json({ error: 'User not found' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/list-roles', async (req: Request, res: Response) => {
    try {
      const { server_id } = req.body;
      if (!server_id) {
        res.status(400).json({ error: 'server_id required' });
        return;
      }

      const roles = await discordClient.listRoles(server_id);
      if (roles) {
        res.json({ roles });
      } else {
        res.status(404).json({ error: 'Server not found' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Memory / History ---

  app.post('/api/get-history', async (req: Request, res: Response) => {
    try {
      const { channel_id, limit = 20 } = req.body;
      if (!channel_id) {
        res.status(400).json({ error: 'channel_id required' });
        return;
      }

      const messages = memory.getRecentMessages(channel_id, limit);
      res.json({ messages });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Start Server ---

  const server = app.listen(port, '0.0.0.0', () => {
    logger.info('HTTP', `API server listening on port ${port}`);
    logger.info('HTTP', `Health check: http://0.0.0.0:${port}/health`);
    logger.info('HTTP', `${Object.keys(ENDPOINT_MAP).length} endpoints available`);
  });

  return server;
}

// Endpoint map for documentation / MCP client reference
const ENDPOINT_MAP = {
  'read-messages': '/api/read-messages',
  'send-message': '/api/send-message',
  'send-dm': '/api/send-dm',
  'send-file': '/api/send-file',
  'list-channels': '/api/list-channels',
  'create-channel': '/api/create-channel',
  'set-channel-topic': '/api/set-channel-topic',
  'rename-channel': '/api/rename-channel',
  'delete-channel': '/api/delete-channel',
  'create-category': '/api/create-category',
  'move-channel': '/api/move-channel',
  'add-reaction': '/api/add-reaction',
  'get-reactions': '/api/get-reactions',
  'create-poll': '/api/create-poll',
  'edit-message': '/api/edit-message',
  'delete-message': '/api/delete-message',
  'pin-message': '/api/pin-message',
  'create-thread': '/api/create-thread',
  'create-forum-post': '/api/create-forum-post',
  'list-forum-threads': '/api/list-forum-threads',
  'timeout-user': '/api/timeout-user',
  'assign-role': '/api/assign-role',
  'remove-role': '/api/remove-role',
  'list-members': '/api/list-members',
  'get-user-info': '/api/get-user-info',
  'list-roles': '/api/list-roles',
  'get-history': '/api/get-history',
} as const;

export { ENDPOINT_MAP };
