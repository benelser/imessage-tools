---
name: imessage-read
description: Read messages by contact or group
---

Read recent messages using the imessage-tools CLI.

Run the following command:

```
cd "${CLAUDE_PLUGIN_ROOT}" && bun run index.ts read $ARGUMENTS
```

The CLI accepts:
- `read` — last 20 messages (all contacts)
- `read <limit>` — last N messages
- `read <limit> <contact>` — last N messages from a specific phone/email
- `read --group "Group Name"` — read messages from a named group chat
- `read --group "Group Name" <limit>` — read N messages from a group

Examples:
- `/imessage-read` — show last 20 messages
- `/imessage-read 5` — show last 5 messages
- `/imessage-read 10 +15551234567` — last 10 from a number
- `/imessage-read --group "Work Chat"` — read group chat
- `/imessage-read --group "Family" 50` — last 50 from Family group

Show the output to the user.
