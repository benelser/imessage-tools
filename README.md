# imessage-tools

A [Claude Code plugin](https://code.claude.com/docs/en/plugins) that lets you read, search, and send iMessages directly from Claude Code.

## Prerequisites

- **macOS** — iMessage is a macOS-only feature
- **[Bun](https://bun.sh)** — JavaScript runtime (`brew install oven-sh/bun/bun`)
- **Full Disk Access** — your terminal needs Full Disk Access in System Settings > Privacy & Security to read `~/Library/Messages/chat.db` and `~/Library/Application Support/AddressBook/` (for resolving phone numbers to contact names)

## Install

```
/plugin marketplace add benelser/imessage-tools
/plugin install imessage-tools@benelser-imessage-tools
/reload-plugins
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
/imessage-read            # last 20 messages (all contacts)
/imessage-read 10         # last 10 messages
/imessage-read 20 +1555…  # last 20 from a specific number
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

Send via iMessage, RCS, or SMS. Resolves contact names through macOS AddressBook with fuzzy matching — ambiguous names show a disambiguation list instead of guessing.

```
/imessage-send "Jane Doe" "Hey what's up?"
/imessage-send +15551234567 "Hello!"
/imessage-send "Jane" "Hello!" --rcs
```

```
  Multiple contacts match "Jane":

    1. Jane Doe (+15551234567)
    2. Jane Smith (+15559876543)

  Be more specific or use a phone number to send.
```

## Standalone CLI

Works without Claude Code too:

```bash
bun install
bun run index.ts inbox
bun run index.ts read 10
bun run index.ts search "lunch"
bun run index.ts catchup
bun run index.ts contacts
bun run index.ts send "Jane Doe" "Hey, what's up?"
```

## How it works

- **Reading messages** — Queries `~/Library/Messages/chat.db` (SQLite) directly. No AppleScript needed for reads.
- **Contact resolution** — Cross-references phone numbers/emails against macOS AddressBook databases to display real contact names instead of raw identifiers.
- **Reactions** — Tapback reactions are collapsed inline onto their parent messages instead of appearing as separate entries.
- **Sending** — Uses AppleScript to drive Messages.app with auto-detection of iMessage/RCS/SMS.

## License

MIT
