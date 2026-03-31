---
name: imessage-read
description: Read recent iMessages, optionally filtered by contact
---

Read recent messages using the imessage-tools CLI.

Run the following command:

```
cd "${CLAUDE_PLUGIN_ROOT}" && bun run index.ts read $ARGUMENTS
```

The CLI accepts:
- `read` — last 20 messages
- `read <limit>` — last N messages
- `read <limit> <contact>` — last N messages from a specific phone/email

If the user provides a contact name instead of a number, first resolve it using the contacts command.

Examples:
- `/imessage-read` — show last 20 messages
- `/imessage-read 5` — show last 5 messages
- `/imessage-read 10 +15551234567` — last 10 from a number

Show the output to the user.
