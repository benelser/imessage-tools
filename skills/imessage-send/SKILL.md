---
name: imessage-send
description: Send an iMessage/SMS/RCS to a contact by name or phone number
---

Send a message using the imessage-tools CLI.

Run the following command:

```
cd "${CLAUDE_PLUGIN_ROOT}" && bun run index.ts send $ARGUMENTS
```

The CLI handles:
- Contact name resolution (e.g. "John" -> phone number via macOS Contacts)
- Auto-detecting the correct service (iMessage, RCS, SMS) from chat history
- Service override with --sms, --rcs, or --imessage flags

Examples of how the user might invoke this:
- `/imessage-send "Jane Doe" "Hey what's up?"`
- `/imessage-send "John Smith" "Let's grab lunch"`
- `/imessage-send +15551234567 "Hello!"`
- `/imessage-send "Jane Doe" "Hello!" --rcs`

Parse $ARGUMENTS to extract the recipient and message, then run the command.
