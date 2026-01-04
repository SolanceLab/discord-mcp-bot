import { Client, GatewayIntentBits, Message, ActivityType, PresenceStatusData } from 'discord.js';
import dotenv from 'dotenv';
import { ClaudeClient } from './claude.js';
import { MemoryManager } from './memory.js';
import { BotConfig } from './types.js';

dotenv.config();

class DiscordMcpBot {
  private client: Client;
  private claude: ClaudeClient;
  private memory: MemoryManager;
  private config: BotConfig;
  private isOwnerOnline: boolean = false;

  constructor() {
    // Load configuration
    this.config = {
      discordToken: process.env.DISCORD_BOT_TOKEN || '',
      channelId: process.env.CHANNEL_ID || '',
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
      presenceSyncEnabled: process.env.PRESENCE_SYNC_ENABLED === 'true',
      ownerUserId: process.env.OWNER_USER_ID || ''
    };

    // Validate configuration
    this.validateConfig();

    // Initialize Discord client with necessary intents
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers
      ]
    });

    // Initialize Claude API client
    this.claude = new ClaudeClient(this.config.anthropicApiKey);

    // Initialize memory manager
    this.memory = new MemoryManager('./memory-ledger.json');
  }

  private validateConfig(): void {
    const required = ['discordToken', 'anthropicApiKey', 'channelId'];
    const missing = required.filter(key => !this.config[key as keyof BotConfig]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required configuration: ${missing.join(', ')}`);
    }

    if (this.config.presenceSyncEnabled && !this.config.ownerUserId) {
      console.warn('⚠️  PRESENCE_SYNC_ENABLED is true but OWNER_USER_ID is not set. Presence sync will not work.');
    }

    // Debug: print config
    console.log('🔧 Bot Configuration:');
    console.log(`   Channel ID: ${this.config.channelId}`);
    console.log(`   Presence Sync: ${this.config.presenceSyncEnabled}`);
    console.log(`   Owner User ID: ${this.config.ownerUserId}`);
  }

  async start(): Promise<void> {
    // Initialize memory ledger
    await this.memory.initialize();

    // Set up event handlers
    this.setupEventHandlers();

    // Login to Discord
    await this.client.login(this.config.discordToken);
  }

  private setupEventHandlers(): void {
    // Bot ready event
    this.client.once('ready', () => {
      console.log(`✅ Bot is online as ${this.client.user?.tag}`);
      console.log(`   Bot User ID: ${this.client.user?.id}`);

      if (this.config.presenceSyncEnabled) {
        console.log(`🔗 Presence sync enabled - tracking owner (${this.config.ownerUserId})`);
        this.updatePresenceStatus('invisible'); // Start invisible until owner comes online
      } else {
        console.log(`🟢 Always-on mode - responding to all mentions`);
        this.updatePresenceStatus('online');
      }
    });

    // Presence update event (to track owner's status)
    this.client.on('presenceUpdate', (oldPresence, newPresence) => {
      if (!this.config.presenceSyncEnabled) return;
      if (newPresence.userId !== this.config.ownerUserId) return;

      const isOnline = newPresence.status === 'online' ||
                       newPresence.status === 'idle' ||
                       newPresence.status === 'dnd';

      if (isOnline !== this.isOwnerOnline) {
        this.isOwnerOnline = isOnline;
        this.updatePresenceStatus(isOnline ? 'online' : 'invisible');
        console.log(`🔄 Owner is now ${isOnline ? 'online' : 'offline'} - adjusting presence`);
      }
    });

    // Message event - WITH FULL DEBUG LOGGING
    this.client.on('messageCreate', async (message) => {
      // Log EVERY message we see
      console.log(`\n🔍 Message received:`);
      console.log(`   From: ${message.author.tag} (${message.author.id})`);
      console.log(`   Channel: ${message.channelId}`);
      console.log(`   Content: ${message.content}`);
      console.log(`   Bot mentioned: ${message.mentions.has(this.client.user?.id || '')}`);
      
      await this.handleMessage(message);
    });

    // Error handling
    this.client.on('error', (error) => {
      console.error('Discord client error:', error);
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bot's own messages
    if (message.author.id === this.client.user?.id) {
      console.log(`   ⏭️  Ignoring (bot's own message)`);
      return;
    }

    // Only respond in configured channel
    if (message.channelId !== this.config.channelId) {
      console.log(`   ⏭️  Ignoring (wrong channel - expected ${this.config.channelId})`);
      return;
    }

    // If presence sync is enabled and owner is offline, don't respond
    if (this.config.presenceSyncEnabled && !this.isOwnerOnline) {
      console.log(`   ⏸️  Ignoring (owner is offline, presence sync enabled)`);
      return;
    }

    // Only respond to @mentions or DMs
    const isMentioned = message.mentions.has(this.client.user?.id || '');
    if (!isMentioned) {
      console.log(`   ⏭️  Ignoring (bot not mentioned)`);
      return;
    }

    console.log(`   ✅ Processing message`);

    try {
      // Show typing indicator
      if ('sendTyping' in message.channel) {
        await message.channel.sendTyping();
      }

      // Get conversation history
      const history = this.memory.getRecentMessages(message.channelId, 20);

      // Get response from Claude
      console.log(`   🤔 Calling Anthropic API...`);
      const response = await this.claude.getResponse(
        message.content,
        history
      );
      console.log(`   💬 Got response: ${response.substring(0, 50)}...`);

      // Store user message in memory
      await this.memory.addMessage(message.channelId, {
        role: 'user',
        content: message.content,
        timestamp: new Date().toISOString(),
        author: message.author.tag,
        userId: message.author.id
      });

      // Store assistant response in memory
      await this.memory.addMessage(message.channelId, {
        role: 'assistant',
        content: response,
        timestamp: new Date().toISOString()
      });

      // Send response
      await message.reply(response);
      console.log(`   ✉️  Response sent successfully`);

    } catch (error) {
      console.error('   ❌ Error handling message:', error);
      await message.reply('I encountered an error processing your message. Please try again.');
    }
  }

  private updatePresenceStatus(status: 'online' | 'idle' | 'dnd' | 'invisible'): void {
    this.client.user?.setPresence({
      status: status,
      activities: status === 'online'
        ? [{ name: 'Online', type: ActivityType.Custom }]
        : []
    });
  }
}

// Start the bot
const bot = new DiscordMcpBot();
bot.start().catch(error => {
  console.error('Fatal error starting bot:', error);
  process.exit(1);
});
