import fs from 'fs/promises';
import path from 'path';
import { MemoryLedger, MemoryEntry, ConversationMessage } from './types.js';

export class MemoryManager {
  private ledgerPath: string;
  private ledger: MemoryLedger;

  constructor(ledgerPath: string = './memory-ledger.json') {
    this.ledgerPath = path.resolve(ledgerPath);
    this.ledger = {};
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
}
