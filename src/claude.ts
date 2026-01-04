import Anthropic from '@anthropic-ai/sdk';
import { ConversationMessage } from './types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ClaudeClient {
  private client: Anthropic;
  private systemPrompt: string = '';
  private initialized: boolean = false;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  private async loadSystemPrompt(): Promise<void> {
    if (this.initialized) return;

    // Try to load persona file - check multiple locations in order
    const personaLocations = [
      process.env.PERSONA_FILE,                        // 1. Custom path via env var
      path.resolve(__dirname, '../persona.md'),        // 2. Project directory
      path.join(os.homedir(), '.claude', 'CLAUDE.md'), // 3. Claude default location
    ].filter(Boolean) as string[];

    let loadedFrom = '';
    let personaContent = '';

    for (const location of personaLocations) {
      try {
        personaContent = await fs.readFile(location, 'utf-8');
        loadedFrom = location;
        console.error(`[Claude] Loaded persona from ${location}`);
        break;
      } catch {
        continue;
      }
    }

    if (personaContent) {
      // Build system prompt with persona + Discord context
      this.systemPrompt = `${personaContent}

---

## Discord Context

This is a Discord conversation. Respond naturally and conversationally, not in essays. Be present.`;
    } else {
      console.error('[Claude] No persona file found, using minimal prompt');

      // Minimal fallback - user should provide their own persona.md
      this.systemPrompt = `You are a helpful assistant responding in Discord.
Keep responses conversational and concise.

Note: Create a persona.md file in the bot directory to customize this personality.`;
    }

    this.initialized = true;
  }

  async getResponse(
    userMessage: string,
    conversationHistory: ConversationMessage[]
  ): Promise<string> {
    // Ensure system prompt is loaded
    await this.loadSystemPrompt();

    try {
      // Convert conversation history to Anthropic message format
      const messages: Anthropic.MessageParam[] = conversationHistory.map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      }));

      // Add the current message
      messages.push({
        role: 'user',
        content: userMessage
      });

      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: this.systemPrompt,
        messages: messages
      });

      return response.content[0].type === 'text'
        ? response.content[0].text
        : 'I encountered an error processing that message.';

    } catch (error) {
      console.error('Error calling Anthropic API:', error);
      throw error;
    }
  }
}
