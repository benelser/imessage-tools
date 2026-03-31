# imessage-tools

A cross-platform iMessage plugin for [Claude Code](https://code.claude.com/docs/en/plugins) and [OpenAI Codex CLI](https://developers.openai.com/codex/plugins). Read, search, and send iMessages directly from your AI coding agent.

## Prerequisites

- **macOS** — iMessage is a macOS-only feature
- **[Bun](https://bun.sh)** — JavaScript runtime (`brew install oven-sh/bun/bun`)
- **Full Disk Access** — your terminal needs Full Disk Access in System Settings > Privacy & Security to read `~/Library/Messages/chat.db` and `~/Library/Application Support/AddressBook/` (for resolving phone numbers to contact names)

## Install

Current release: **v3.0.0**

### Claude Code

```
/plugin marketplace add benelser/imessage-tools
/plugin install imessage-tools@benelser-imessage-tools
/reload-plugins
```

To pin to a specific release:
```
/plugin marketplace add benelser/imessage-tools#v3.0.0
```

### OpenAI Codex CLI

```bash
git clone https://github.com/benelser/imessage-tools.git
cd imessage-tools
bun install && bun link
bun run scripts/deploy.ts codex
```

Then restart Codex — the plugin will be enabled automatically.

**Codex sandbox note:** Read commands (inbox, read, search, catchup) work in any sandbox mode. Send commands require **Full access** sandbox because AppleScript needs to control Messages.app. Set this in Codex Settings > Sandbox settings, or pass `--sandbox danger-full-access` for non-interactive `codex exec`.

### Global CLI (both platforms)

After installing on either platform, run `bun link` from the repo to register `imessage-tools` as a global command. Skills on both Claude Code and Codex use this global CLI — no platform-specific paths.

## Skills

Skills are invoked with `/` in Claude Code and `$` in Codex:

| Claude Code | Codex CLI | Description |
|---|---|---|
| `/imessage-inbox` | `$imessage-inbox` | Recent conversation threads |
| `/imessage-read` | `$imessage-read` | Read messages by contact or group |
| `/imessage-search` | `$imessage-search` | Search messages by keyword |
| `/imessage-catchup` | `$imessage-catchup` | What did I miss? |
| `/imessage-send` | `$imessage-send` | Send a message |
| `/imessage-group-create` | `$imessage-group-create` | Create a group chat |

### [`imessage-inbox`](skills/imessage-inbox/SKILL.md) — Conversation list

View recent threads like the Messages sidebar. Shows contact names, timestamps, message previews, and who spoke last.

```
imessage-inbox        # last 15 threads
imessage-inbox 5      # last 5 threads
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

### [`imessage-read`](skills/imessage-read/SKILL.md) — Conversation view

Read messages in a chat-style layout with day separators, right-aligned sent messages, smart timestamps (only shown on 30min+ gaps), and inline reactions.

```
imessage-read                       # last 20 messages (all contacts)
imessage-read 10                    # last 10 messages
imessage-read 20 +1555…             # last 20 from a specific number
imessage-read --group "Work Chat"   # read a group chat
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

### [`imessage-search`](skills/imessage-search/SKILL.md) — Search with context

Search message history by keyword. Results are grouped by conversation with surrounding messages for context. Matching messages are marked with `▶`.

```
imessage-search "coffee"        # last 25 matches
imessage-search "coffee" 50     # last 50 matches
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

### [`imessage-catchup`](skills/imessage-catchup/SKILL.md) — What did I miss?

Shows messages received since your last sent message, grouped by conversation with counts. Perfect for checking in after being heads-down.

```
imessage-catchup      # since your last sent message
imessage-catchup 2    # last 2 hours
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

### [`imessage-send`](skills/imessage-send/SKILL.md) — Send a message

Supports three modes: 1:1, 1:many (individual sends), and group chat. Resolves contact names with fuzzy matching and disambiguation.

**1:1** — send to a single contact by name or number:
```
imessage-send "Jane Doe" "Hey what's up?"
imessage-send +15551234567 "Hello!"
imessage-send "Jane" "Hello!" --rcs
```

**1:many** — send the same message individually to multiple contacts:
```
imessage-send "Jane, John, Bob" "Meeting at 3"
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
imessage-send --group "Work Chat" "Hello team!"
```
The group must have a display name set in Messages.app (tap group info to name it). Unnamed groups can't be targeted by name.

### [`imessage-group-create`](skills/imessage-group-create/SKILL.md) — Create a group chat

Interactive, human-in-the-loop group creation. The agent walks you through each step and never sends without your explicit confirmation.

```
> imessage-group-create
```

The agent will:

1. **Ask** who should be in the group
2. **Resolve** each name against your Contacts, flagging ambiguous or missing matches
3. **Present** the roster and let you `+Name` / `-Name` to adjust
4. **Confirm** before creating — only proceeds on your explicit "yes"
5. **Ask** for the first message
6. **Create** the group by sending to all members

Note: group naming must be done in Messages.app after creation (AppleScript limitation).

## Developer Tooling

### Build

Generates platform-specific plugin artifacts from `skills-src/` (single source of truth):

```bash
bun run scripts/build.ts
```

Outputs `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, and universal `skills/`.

### Deploy

Automates the full install/reinstall cycle:

```bash
bun run scripts/deploy.ts claude    # reinstall for Claude Code
bun run scripts/deploy.ts codex     # install for Codex CLI
bun run scripts/deploy.ts all       # both platforms + bun link
bun run scripts/deploy.ts link      # just register global CLI
```

## How it works

- **Reading messages** — Queries `~/Library/Messages/chat.db` (SQLite) directly. No AppleScript needed for reads.
- **Contact resolution** — Cross-references phone numbers/emails against macOS AddressBook databases to display real contact names instead of raw identifiers.
- **Reactions** — Tapback reactions are collapsed inline onto their parent messages instead of appearing as separate entries.
- **Service detection** — Uses `account_id` from chat history (not the unreliable `service_name` field) to determine the correct transport (iMessage/RCS/SMS) before sending.
- **Sending** — Uses AppleScript to drive Messages.app with auto-detection of iMessage/RCS/SMS. Phone numbers are normalized to E.164 format for reliable delivery.

## License

MIT
