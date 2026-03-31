---
name: imessage-send
description: Send a message by name or number
---

Send a message using imessage-tools.

```
imessage-tools send $ARGUMENTS
```

The CLI handles:
- Contact name resolution (e.g. "John" -> phone number via macOS Contacts)
- Auto-detecting the correct service (iMessage, RCS, SMS) from chat history
- Service override with --sms, --rcs, or --imessage flags
- Sending to multiple contacts at once (1:many, comma-separated names)
- Sending to existing group chats by name (--group flag)

Examples of how the user might invoke this:
- `/imessage-send "Jane Doe" "Hey what's up?"`               (1:1 send)
- `/imessage-send "John Smith" "Let's grab lunch"`            (1:1 send)
- `/imessage-send +15551234567 "Hello!"`                      (1:1 by number)
- `/imessage-send "Jane Doe" "Hello!" --rcs`                  (1:1 with service override)
- `/imessage-send "Jane, John, Bob" "Meeting at 3"`           (1:many individual sends)
- `/imessage-send --group "Work Chat" "Hello team!"`          (existing group chat)

Parse $ARGUMENTS to extract the recipient and message, then run the command.
