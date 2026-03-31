---
name: imessage-inbox
description: Inbox — recent threads
---

Show the inbox/conversation list using imessage-tools.

```
imessage-tools inbox $ARGUMENTS
```

Default is 15 conversations. Pass a number to change the limit.

The output renders like the iMessage sidebar with resolved contact names, relative timestamps, and message previews. Show the raw output directly to the user — it is already formatted.

Examples:
- `/imessage-inbox` — show last 15 threads
- `/imessage-inbox 5` — show last 5 threads
