---
name: imessage-catchup
description: Show messages received since you were last active — your "what did I miss" view
---

Show messages received since the user's last sent message using the imessage-tools CLI.

Run the following command:

```
cd "${CLAUDE_PLUGIN_ROOT}" && bun run index.ts catchup $ARGUMENTS
```

No arguments needed. Optionally pass a number of hours to look back.

Examples:
- `/imessage-catchup` — messages since your last sent message
- `/imessage-catchup 2` — messages from the last 2 hours
