---
name: imessage-group-create
description: Create a new group chat with contacts
---

Create a new iMessage group chat interactively.

## Step 1: Ask who should be in the group
Ask the user for names, phone numbers, or a mix. They can provide comma-separated values.

## Step 2: Resolve contacts
Run:
```
imessage-tools create-group resolve $ARGUMENTS
```
Parse the JSON output and present a clean numbered list to the user:
- Show each resolved contact with name and number
- Flag any ambiguous matches and ask the user to pick
- Flag any not-found names and ask for corrections

## Step 3: Confirm the roster
Show the final list and ask: "Look good? You can +Name to add or -Name to remove, or 'yes' to proceed."
If they add/remove, re-resolve and show the updated list.

## Step 4: Get the first message
Ask: "What should the first message be?"

## Step 5: Create the group
Run:
```
imessage-tools create-group send "phone1,phone2,..." "message"
```

Show the result. Note: group naming must be done in Messages.app after creation.

IMPORTANT: Always confirm with the user before running the send step. Never create the group without explicit "yes" confirmation.
