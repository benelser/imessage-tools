---
name: imessage-search
description: Search messages by keyword
---

Search messages using imessage-tools.

```
imessage-tools search $ARGUMENTS
```

The CLI accepts:
- `search <keyword>` — search for keyword, last 25 matches
- `search <keyword> <limit>` — search with custom limit

Examples:
- `/imessage-search "lunch"` — find messages containing "lunch"
- `/imessage-search "lunch" 50` — find last 50 matches

Show the output to the user.
