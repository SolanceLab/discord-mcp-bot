import * as fs from 'fs';
import * as path from 'path';

// Log directory and files
const LOG_DIR = process.env.DISCORD_LOG_DIR || path.join(process.env.HOME || '/tmp', '.discord-mcp-logs');
const LOG_FILE = path.join(LOG_DIR, 'discord-mcp-bot.log');
const HEARTBEAT_FILE = path.join(LOG_DIR, 'heartbeat.json');
const MAX_LOG_AGE_DAYS = 7;
const MAX_LOG_SIZE_MB = 10;
const HEARTBEAT_INTERVAL_MS = 60000; // 60 seconds

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

interface HeartbeatData {
  pid: number;
  alive: number;
  aliveISO: string;
  uptime: number;
  uptimeHuman: string;
  discordConnected: boolean;
  lastDiscordEvent: string | null;
}

class Logger {
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private discordConnected: boolean = false;
  private lastDiscordEvent: string | null = null;
  private startTime: number = Date.now();

  constructor() {
    this.ensureLogDir();
    this.rotateLogsIfNeeded();
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  }

  private rotateLogsIfNeeded(): void {
    try {
      // Check if current log file is too large
      if (fs.existsSync(LOG_FILE)) {
        const stats = fs.statSync(LOG_FILE);
        const sizeMB = stats.size / (1024 * 1024);

        if (sizeMB > MAX_LOG_SIZE_MB) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const archiveName = `discord-mcp-bot-${timestamp}.log`;
          fs.renameSync(LOG_FILE, path.join(LOG_DIR, archiveName));
          this.log('INFO', 'Logger', `Rotated log file (was ${sizeMB.toFixed(2)}MB)`);
        }
      }

      // Clean up old log files
      const files = fs.readdirSync(LOG_DIR);
      const now = Date.now();
      const maxAge = MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file.startsWith('discord-mcp-bot-') && file.endsWith('.log')) {
          const filePath = path.join(LOG_DIR, file);
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
            this.log('INFO', 'Logger', `Deleted old log file: ${file}`);
          }
        }
      }
    } catch (error) {
      // Don't crash if rotation fails
      console.error('[Logger] Rotation error:', error);
    }
  }

  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  log(level: LogLevel, source: string, message: string, data?: any): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] [${source}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`;

    // Always write to stderr for MCP visibility
    process.stderr.write(logLine);

    // Also write to persistent log file
    try {
      fs.appendFileSync(LOG_FILE, logLine);
    } catch (error) {
      // Don't crash if logging fails
    }
  }

  debug(source: string, message: string, data?: any): void {
    this.log('DEBUG', source, message, data);
  }

  info(source: string, message: string, data?: any): void {
    this.log('INFO', source, message, data);
  }

  warn(source: string, message: string, data?: any): void {
    this.log('WARN', source, message, data);
  }

  error(source: string, message: string, data?: any): void {
    this.log('ERROR', source, message, data);
  }

  fatal(source: string, message: string, data?: any): void {
    this.log('FATAL', source, message, data);
  }

  // Discord connection tracking
  setDiscordConnected(connected: boolean): void {
    const wasConnected = this.discordConnected;
    this.discordConnected = connected;

    if (wasConnected !== connected) {
      this.lastDiscordEvent = new Date().toISOString();
      if (connected) {
        this.info('Discord', 'Connection established');
      } else {
        this.warn('Discord', 'Connection lost');
      }
    }
  }

  recordDiscordEvent(event: string): void {
    this.lastDiscordEvent = new Date().toISOString();
    this.debug('Discord', `Event: ${event}`);
  }

  // Heartbeat system
  startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Write initial heartbeat
    this.writeHeartbeat();

    // Then write every 60 seconds
    this.heartbeatInterval = setInterval(() => {
      this.writeHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    this.info('Heartbeat', `Started (interval: ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.info('Heartbeat', 'Stopped');
    }
  }

  private writeHeartbeat(): void {
    const uptimeMs = Date.now() - this.startTime;
    const heartbeat: HeartbeatData = {
      pid: process.pid,
      alive: Date.now(),
      aliveISO: new Date().toISOString(),
      uptime: uptimeMs,
      uptimeHuman: this.formatUptime(uptimeMs),
      discordConnected: this.discordConnected,
      lastDiscordEvent: this.lastDiscordEvent
    };

    try {
      fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(heartbeat, null, 2));
    } catch (error) {
      // Don't crash if heartbeat write fails
    }
  }

  // Get log file paths for debugging
  getLogPaths(): { logDir: string; logFile: string; heartbeatFile: string } {
    return {
      logDir: LOG_DIR,
      logFile: LOG_FILE,
      heartbeatFile: HEARTBEAT_FILE
    };
  }
}

// Export singleton instance
export const logger = new Logger();
