# Discord Bot Permissions Guide

When your bot connects but doesn't show messages or members, it's usually a permissions issue. There are **two places** you need to configure permissions.

---

## 1. Discord Developer Portal

Go to: https://discord.com/developers/applications → Your App → **Bot** settings

### Privileged Gateway Intents (CRITICAL)

These toggles must be **ON** in the portal, or your bot will be blind:

| Intent | What it does | Toggle ON if... |
|--------|--------------|-----------------|
| **SERVER MEMBERS INTENT** | See member list, join/leave events | You need to list members or detect joins |
| **MESSAGE CONTENT INTENT** | Read actual message text | You need to read what people type (not just metadata) |
| **PRESENCE INTENT** | See online/offline/idle status | You need to track user presence |

> **This is the #1 reason bots "don't work" after being added.** The bot connects fine, but can't see anything because these intents are off.

### Bot Permissions (OAuth2 URL Generator)

When generating your bot invite link, select these permissions:

**Basic:**
- View Channels
- Send Messages
- Read Message History

**If reacting to messages:**
- Add Reactions

**If managing messages:**
- Manage Messages (edit/delete/pin)

**If managing server structure:**
- Manage Channels
- Manage Roles

---

## 2. In Your Code (discord.js)

Your code must **request** the intents that match what you enabled in the portal.

```typescript
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({
  intents: [
    // Basic server access
    GatewayIntentBits.Guilds,

    // See messages in server channels
    GatewayIntentBits.GuildMessages,

    // Read message content (PRIVILEGED - must be ON in portal)
    GatewayIntentBits.MessageContent,

    // See member online/offline status (PRIVILEGED)
    GatewayIntentBits.GuildPresences,

    // See member list (PRIVILEGED)
    GatewayIntentBits.GuildMembers,

    // Receive direct messages
    GatewayIntentBits.DirectMessages,
  ],

  // Required for DM support
  partials: [1, 2], // Channel, Message
});
```

---

## Troubleshooting Checklist

**Bot added but doesn't respond to messages:**
- [ ] MESSAGE CONTENT INTENT enabled in Developer Portal?
- [ ] `GatewayIntentBits.MessageContent` in your code?
- [ ] Bot has "View Channel" permission for that specific channel?

**Bot can't see member list:**
- [ ] SERVER MEMBERS INTENT enabled in Developer Portal?
- [ ] `GatewayIntentBits.GuildMembers` in your code?

**Bot can't see online/offline status:**
- [ ] PRESENCE INTENT enabled in Developer Portal?
- [ ] `GatewayIntentBits.GuildPresences` in your code?

**Bot can't receive DMs:**
- [ ] `GatewayIntentBits.DirectMessages` in your code?
- [ ] `partials: [1, 2]` (or `[Partials.Channel, Partials.Message]`) in client options?

---

## Quick Test

Add this to your bot's ready event to confirm it's working:

```typescript
client.once('ready', () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log(`In ${client.guilds.cache.size} servers`);
});
```

If it logs in but shows 0 servers, your invite link permissions are wrong.
If it's in servers but can't see messages, your intents are wrong.

---

*Last updated: January 2026*
