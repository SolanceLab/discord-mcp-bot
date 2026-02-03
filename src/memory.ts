import fs from 'fs/promises';
import path from 'path';
import { MemoryLedger, MemoryEntry, ConversationMessage } from './types.js';

export interface JournalEntry {
  id: string;
  date: string;
  title?: string;
  narrative?: string;
  carrying_forward?: string;
  emotions?: string[];
  tones?: string[];
  platforms?: string[];
}

export class MemoryManager {
  private ledgerPath: string;
  private ledger: MemoryLedger;
  private pendingNarratives: string[] = [];
  private syncInterval: NodeJS.Timeout | null = null;
  private memoryApiUrl: string;
  private memoryApiToken: string;

  // Cached memory context
  private cachedCarryingForward: string = '';
  private cachedRecentJournal: string = '';
  private lastMemoryFetchDate: string = '';
  private firstMentionToday: boolean = true;

  constructor(ledgerPath: string = './memory-ledger.json', memoryApiToken?: string) {
    this.ledgerPath = path.resolve(ledgerPath);
    this.ledger = {};
    this.memoryApiUrl = process.env.MEMORY_API_URL || '';
    this.memoryApiToken = memoryApiToken || process.env.MEMORY_API_TOKEN || '';

    if (this.memoryApiUrl && !this.memoryApiToken) {
      console.error('[Memory] Warning: MEMORY_API_URL set but no MEMORY_API_TOKEN — API sync will fail');
    }
  }

  async initialize(): Promise<void> {
    try {
      const data = await fs.readFile(this.ledgerPath, 'utf-8');
      this.ledger = JSON.parse(data);
      console.error(`[Memory] Ledger loaded: ${Object.keys(this.ledger).length} channels`);
    } catch (error) {
      // File doesn't exist yet, start with empty ledger
      console.error('[Memory] Starting with new ledger');
      this.ledger = {};
      await this.save();
    }

    // Fetch memory context on startup if API is configured
    if (this.memoryApiUrl) {
      await this.refreshMemoryContext(true);
    }
  }

  /**
   * Refresh memory context from external API
   * @param isFirstOfDay - If true, fetches fuller context (recent entries)
   */
  async refreshMemoryContext(isFirstOfDay: boolean = false): Promise<void> {
    if (!this.memoryApiUrl) return;

    const today = new Date().toISOString().split('T')[0];

    // Check if we need a new day's refresh
    if (this.lastMemoryFetchDate !== today) {
      this.firstMentionToday = true;
      this.lastMemoryFetchDate = today;
    }

    try {
      // Always fetch carrying_forward from most recent entry
      const entries = await this.readFromApi(1);
      if (entries.length > 0 && entries[0].carrying_forward) {
        this.cachedCarryingForward = entries[0].carrying_forward;
        console.error(`[Memory] Loaded carrying_forward (${this.cachedCarryingForward.length} chars)`);
      }

      // On first mention of day, also fetch fuller context
      if (isFirstOfDay || this.firstMentionToday) {
        const recentEntries = await this.readFromApi(3);
        if (recentEntries.length > 0) {
          // Build a lean summary: date, title, emotions, tones — no narrative bulk
          this.cachedRecentJournal = recentEntries
            .map(e => {
              const parts = [];
              if (e.date) parts.push(`**${e.date}**`);
              if (e.title) parts.push(`*${e.title}*`);
              if (e.emotions && e.emotions.length > 0) {
                parts.push(`Emotions: ${e.emotions.join(', ')}`);
              }
              if (e.tones && e.tones.length > 0) {
                parts.push(`Tones: ${e.tones.join(', ')}`);
              }
              return parts.join('\n');
            })
            .join('\n\n');
          console.error(`[Memory] Loaded recent journal context (${this.cachedRecentJournal.length} chars)`);
        }
      }
    } catch (error) {
      console.error('[Memory] Failed to refresh memory context:', error);
    }
  }

  /**
   * Get memory context for Claude's system prompt
   * @param isFirstMention - If true and it's first mention today, includes fuller context
   */
  async getMemoryContext(isFirstMention: boolean = false): Promise<{ carryingForward?: string; recentJournal?: string }> {
    const today = new Date().toISOString().split('T')[0];

    // Check if it's a new day
    if (this.lastMemoryFetchDate !== today) {
      await this.refreshMemoryContext(true);
    }

    const context: { carryingForward?: string; recentJournal?: string } = {};

    // Always include carrying_forward if available
    if (this.cachedCarryingForward) {
      context.carryingForward = this.cachedCarryingForward;
    }

    // Include recent journal on first mention of day
    if (this.firstMentionToday && this.cachedRecentJournal) {
      context.recentJournal = this.cachedRecentJournal;
      // Mark that we've done the first mention
      this.firstMentionToday = false;
    }

    return context;
  }

  async addMessage(channelId: string, message: ConversationMessage): Promise<void> {
    if (!this.ledger[channelId]) {
      this.ledger[channelId] = {
        channelId,
        messages: [],
        lastUpdated: new Date().toISOString()
      };
    }

    this.ledger[channelId].messages.push(message);
    this.ledger[channelId].lastUpdated = new Date().toISOString();

    // Queue significant messages for API sync
    if (this.memoryApiUrl && message.content.length > 50) {
      const formatted = `[Discord ${message.role}${message.author ? ` (${message.author})` : ''}]: ${message.content}`;
      this.pendingNarratives.push(formatted);
    }

    await this.save();
  }

  getRecentMessages(channelId: string, limit: number = 20): ConversationMessage[] {
    const entry = this.ledger[channelId];
    if (!entry) return [];

    return entry.messages.slice(-limit);
  }

  async save(): Promise<void> {
    await fs.writeFile(
      this.ledgerPath,
      JSON.stringify(this.ledger, null, 2),
      'utf-8'
    );
  }

  getConversationContext(channelId: string, maxMessages: number = 20): string {
    const messages = this.getRecentMessages(channelId, maxMessages);

    if (messages.length === 0) {
      return 'No previous conversation history.';
    }

    return messages
      .map(msg => {
        const author = msg.author || msg.role;
        return `${author}: ${msg.content}`;
      })
      .join('\n\n');
  }

  /**
   * Sync pending narratives to external API for long-term memory
   */
  async syncToApi(): Promise<void> {
    if (!this.memoryApiUrl || this.pendingNarratives.length === 0) return;

    const narrative = this.pendingNarratives.join('\n\n');
    this.pendingNarratives = [];

    const today = new Date().toISOString().split('T')[0];

    try {
      const response = await fetch(`${this.memoryApiUrl}/journal/write`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.memoryApiToken}`
        },
        body: JSON.stringify({
          date: today,
          narrative: narrative,
          platforms: ['Discord'],
          tones: ['Conversational']
        })
      });

      if (response.ok) {
        console.error(`[Memory] Synced ${narrative.length} chars to memory API`);
      } else {
        console.error(`[Memory] Memory API sync failed: ${response.status}`);
        // Re-queue for next sync
        this.pendingNarratives.unshift(narrative);
      }
    } catch (error) {
      console.error('[Memory] Memory API sync error:', error);
      // Re-queue for next sync
      this.pendingNarratives.unshift(narrative);
    }
  }

  /**
   * Force immediate sync (call before shutdown)
   */
  async flushToApi(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
    await this.syncToApi();
  }

  /**
   * Write directly to memory API (for important events)
   */
  async writeToApi(narrative: string, emotions?: string[], tones?: string[]): Promise<boolean> {
    if (!this.memoryApiUrl) return false;

    const today = new Date().toISOString().split('T')[0];

    try {
      const response = await fetch(`${this.memoryApiUrl}/journal/write`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.memoryApiToken}`
        },
        body: JSON.stringify({
          date: today,
          narrative,
          emotions,
          tones,
          platforms: ['Discord']
        })
      });

      return response.ok;
    } catch (error) {
      console.error('[Memory] Direct API write error:', error);
      return false;
    }
  }

  /**
   * Read recent entries from memory API
   */
  async readFromApi(limit: number = 5): Promise<JournalEntry[]> {
    if (!this.memoryApiUrl) return [];

    try {
      const response = await fetch(`${this.memoryApiUrl}/journal/recent?limit=${limit}`, {
        headers: {
          'Authorization': `Bearer ${this.memoryApiToken}`
        }
      });
      if (!response.ok) {
        console.error(`[Memory] Memory API read failed: ${response.status}`);
        return [];
      }
      const data = await response.json() as { entries?: JournalEntry[] };
      return data.entries || [];
    } catch (error) {
      console.error('[Memory] Memory API read error:', error);
      return [];
    }
  }
}
