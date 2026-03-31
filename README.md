# imessage-tools

A [Claude Code plugin](https://code.claude.com/docs/en/plugins) that lets you read, search, and send iMessages directly from Claude Code.

## Features

- `/imessage-inbox` — View recent conversation threads (like the Messages sidebar)
- `/imessage-read` — Read recent messages, optionally filtered by contact
- `/imessage-search` — Search message history by keyword
- `/imessage-send` — Send a message to a contact by name or phone number

## Prerequisites

- **macOS** — iMessage is a macOS-only feature
- **[Bun](https://bun.sh)** — JavaScript runtime (`brew install oven-sh/bun/bun`)
- **Full Disk Access** — your terminal needs Full Disk Access in System Settings > Privacy & Security to read `~/Library/Messages/chat.db` and `~/Library/Application Support/AddressBook/` (for resolving phone numbers to contact names)

## Install as a Claude Code plugin

```
/plugin marketplace add benelser/imessage-tools
/plugin install imessage-tools@benelser-imessage-tools
/reload-plugins
```

## Standalone CLI usage

You can also use it as a standalone CLI without Claude Code:

```bash
bun install
bun run index.ts inbox          # Show recent conversations
bun run index.ts read 10        # Read last 10 messages
bun run index.ts search "lunch" # Search messages
bun run index.ts contacts       # List contacts by message count
bun run index.ts send "Jane Doe" "Hey, what's up?"
```

## How it works

- **Reading messages**: Queries `~/Library/Messages/chat.db` (SQLite) directly — no AppleScript needed for reads
- **Contact resolution**: Cross-references phone numbers/emails against macOS AddressBook databases (`~/Library/Application Support/AddressBook/Sources/`) to display real contact names instead of raw identifiers
- **Sending messages**: Uses AppleScript to drive Messages.app, with auto-detection of iMessage/RCS/SMS. Supports sending by contact name (resolved via AddressBook) or direct phone number

## License

MIT
