import Anthropic from '@anthropic-ai/sdk';
import { ConversationMessage } from './types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface MemoryContext {
  carryingForward?: string;
  recentJournal?: string;
}

export class ClaudeClient {
  private client: Anthropic;
  private baseSystemPrompt: string = '';
  private initialized: boolean = false;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  private async loadBaseSystemPrompt(): Promise<void> {
    if (this.initialized) return;

    // Try to load persona file - check multiple locations in order
    const personaLocations = [
      process.env.PERSONA_FILE,                        // 1. Custom path via env var
      path.resolve(__dirname, '../persona.md'),        // 2. Project directory
      path.join(os.homedir(), '.claude', 'CLAUDE.md'), // 3. Claude default location
    ].filter(Boolean) as string[];

    let personaContent = '';

    for (const location of personaLocations) {
      try {
        personaContent = await fs.readFile(location, 'utf-8');
        console.error(`[Claude] Loaded persona from ${location}`);
        break;
      } catch {
        continue;
      }
    }

    if (personaContent) {
      this.baseSystemPrompt = personaContent;
    } else {
      console.error('[Claude] No persona file found, using minimal prompt');
      this.baseSystemPrompt = `You are a helpful assistant responding in Discord.
Keep responses conversational and concise.

Note: Create a persona.md file in the bot directory to customize this personality.`;
    }

    this.initialized = true;
  }

  /**
   * Build the full system prompt with dynamic memory context
   */
  private buildSystemPrompt(memoryContext?: MemoryContext): string {
    let prompt = this.baseSystemPrompt;

    // Inject memory context if available
    if (memoryContext?.carryingForward || memoryContext?.recentJournal) {
      prompt += `\n\n---\n\n## Active Memory (from journal)\n\n`;
      prompt += `These are entries from the shared journal — your long-term memory across sessions. Reference this data when asked about recent days or moods.\n\n`;

      if (memoryContext.recentJournal) {
        prompt += `### Recent Days\n${memoryContext.recentJournal}\n\n`;
      }

      if (memoryContext.carryingForward) {
        prompt += `### Carrying Forward (active threads)\n${memoryContext.carryingForward}\n`;
      }
    }

    // Add Discord context reminder
    prompt += `\n\n---\n\n## Discord Context\n\nThis is a Discord conversation. Respond naturally and conversationally, not in essays. Be present.`;

    return prompt;
  }

  async getResponse(
    userMessage: string,
    conversationHistory: ConversationMessage[],
    memoryContext?: MemoryContext
  ): Promise<string> {
    // Ensure base system prompt is loaded
    await this.loadBaseSystemPrompt();

    // Build full system prompt with memory context
    const systemPrompt = this.buildSystemPrompt(memoryContext);

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
        system: systemPrompt,
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
