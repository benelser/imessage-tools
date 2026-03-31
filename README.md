# imessage-tools

A [Claude Code plugin](https://code.claude.com/docs/en/plugins) that lets you read, search, and send iMessages directly from Claude Code.

## Prerequisites

- **macOS** — iMessage is a macOS-only feature
- **[Bun](https://bun.sh)** — JavaScript runtime (`brew install oven-sh/bun/bun`)
- **Full Disk Access** — your terminal needs Full Disk Access in System Settings > Privacy & Security to read `~/Library/Messages/chat.db` and `~/Library/Application Support/AddressBook/` (for resolving phone numbers to contact names)

## Install

Current release: **v2.4.0**

```
/plugin marketplace add benelser/imessage-tools
/plugin install imessage-tools@benelser-imessage-tools
/reload-plugins
```

To pin to a specific release, add the marketplace with a tag:

```
/plugin marketplace add benelser/imessage-tools#v2.4.0
```

## Skills

### [`/imessage-inbox`](skills/imessage-inbox/SKILL.md) — Conversation list

View recent threads like the Messages sidebar. Shows contact names, timestamps, message previews, and who spoke last.

```
/imessage-inbox        # last 15 threads
/imessage-inbox 5      # last 5 threads
```

```
  CONTACT                           TIME
  ──────────────────────────────────────────────
  Jane Doe                          9:17 AM
    > You: Sounds good, see you there
  ──────────────────────────────────────────────
  Work Chat                         8:57 AM
    > Sarah: deployed the fix
  ──────────────────────────────────────────────
```

### [`/imessage-read`](skills/imessage-read/SKILL.md) — Conversation view

Read messages in a chat-style layout with day separators, right-aligned sent messages, smart timestamps (only shown on 30min+ gaps), and inline reactions.

```
/imessage-read                       # last 20 messages (all contacts)
/imessage-read 10                    # last 10 messages
/imessage-read 20 +1555…             # last 20 from a specific number
/imessage-read --group "Work Chat"   # read a group chat
```

```
                     ── Today ──

Jane Doe  9:15 AM
    Hey are you free for coffee?
    I'm at the place on 5th

                                     Sure, give me 10 min  9:17 AM
                                          On my way now

Jane Doe  10:45 AM
    That was fun! (♥️ You)

                                               Definitely!  10:46 AM
```

### [`/imessage-search`](skills/imessage-search/SKILL.md) — Search with context

Search message history by keyword. Results are grouped by conversation with surrounding messages for context. Matching messages are marked with `▶`.

```
/imessage-search "coffee"        # last 25 matches
/imessage-search "coffee" 50     # last 50 matches
```

```
  Found 2 messages matching "coffee" in 2 conversations

  ── Jane Doe ──────────────────────────────────
    Jane Doe  Mar 29, 9:13 AM
      Hey are you free tomorrow?
    Me  Mar 29, 9:14 AM
  ▶   Want to grab coffee at the usual spot?
    Jane Doe  Mar 29, 9:15 AM
      Yes! 10am works
```

### [`/imessage-catchup`](skills/imessage-catchup/SKILL.md) — What did I miss?

Shows messages received since your last sent message, grouped by conversation with counts. Perfect for checking in after being heads-down.

```
/imessage-catchup      # since your last sent message
/imessage-catchup 2    # last 2 hours
```

```
  You've been away since 2:30 PM (1h 47m)

  ── Jane Doe (3 new) ────────────────────────
    Hey are you around?                  2:45 PM
    Just called, call me back            3:15 PM
    Nvm figured it out                   3:52 PM

  ── Work Chat (1 new) ───────────────────────
    Sarah: deployed the fix              3:30 PM

  4 new messages in 2 conversations
```

### [`/imessage-send`](skills/imessage-send/SKILL.md) — Send a message

Supports three modes: 1:1, 1:many (individual sends), and group chat. Resolves contact names with fuzzy matching and disambiguation.

**1:1** — send to a single contact by name or number:
```
/imessage-send "Jane Doe" "Hey what's up?"
/imessage-send +15551234567 "Hello!"
/imessage-send "Jane" "Hello!" --rcs
```

**1:many** — send the same message individually to multiple contacts:
```
/imessage-send "Jane, John, Bob" "Meeting at 3"
```
```
  Resolved "Jane" -> Jane Doe (+15551234567)
  Resolved "John" -> John Smith (+15559876543)
  Resolved "Bob" -> Bob Jones (+15550001111)

  [ok] Jane Doe: sent via iMessage
  [ok] John Smith: sent via iMessage
  [ok] Bob Jones: sent via SMS
```

**Group chat** — send to an existing named group:
```
/imessage-send --group "Work Chat" "Hello team!"
```
The group must have a display name set in Messages.app (tap group info to name it). Unnamed groups can't be targeted by name.

## Standalone CLI

Works without Claude Code too:

```bash
bun install
bun run index.ts inbox
bun run index.ts read 10
bun run index.ts read --group "Work Chat"
bun run index.ts search "lunch"
bun run index.ts catchup
bun run index.ts contacts
bun run index.ts send "Jane Doe" "Hey, what's up?"
bun run index.ts send "Jane, John" "Meeting at 3"
bun run index.ts send --group "Work Chat" "Hello team!"
```

## How it works

- **Reading messages** — Queries `~/Library/Messages/chat.db` (SQLite) directly. No AppleScript needed for reads.
- **Contact resolution** — Cross-references phone numbers/emails against macOS AddressBook databases to display real contact names instead of raw identifiers.
- **Reactions** — Tapback reactions are collapsed inline onto their parent messages instead of appearing as separate entries.
- **Sending** — Uses AppleScript to drive Messages.app with auto-detection of iMessage/RCS/SMS.

## License

MIT
