import { readMessages, searchMessages, listContacts, inbox, formatReactions } from "./src/db";
import { sendMessage } from "./src/send";
import { lookupContact, lookupContacts, isDirectRecipient, resolveIdentifiers } from "./src/contacts";

const command = process.argv[2];

function usage() {
  console.log(`Usage: bun run index.ts <command> [options]

Commands:
  inbox [limit]              Show conversations (like iMessage sidebar)
  read [limit] [contact]     Read recent messages
  search <keyword> [limit]   Search messages by keyword
  contacts                   List all contacts by message count
  send <name-or-number> <message> [--sms|--rcs|--imessage]
                             Send a message (auto-detects service)

Examples:
  bun run index.ts inbox
  bun run index.ts inbox 5
  bun run index.ts read 50
  bun run index.ts read 10 "+15551234567"
  bun run index.ts search "lunch"
  bun run index.ts contacts
  bun run index.ts send "Jane Doe" "Hey what's up?"
  bun run index.ts send "+15551234567" "Hello!"
  bun run index.ts send "+15551234567" "Hello!" --rcs
`);
}

async function main() {
  switch (command) {
    case "inbox": {
      const limit = parseInt(process.argv[3]) || 15;
      const threads = inbox(limit);

      // Collect all participant identifiers for batch resolution
      const allIds = threads.flatMap((t) => t.participants);
      const nameMap = resolveIdentifiers(allIds);

      // Format relative timestamps
      const now = Date.now();
      function formatTime(iso: string): string {
        const d = new Date(iso);
        const diffMs = now - d.getTime();
        const diffDays = Math.floor(diffMs / 86_400_000);
        if (diffDays === 0)
          return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        if (diffDays === 1) return "Yesterday";
        if (diffDays < 7)
          return d.toLocaleDateString("en-US", { weekday: "long" });
        return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
      }

      // Resolve chat names using contact lookup
      for (const thread of threads) {
        const resolved = thread.participants.map((id) => nameMap.get(id) ?? id);
        // Use resolved names unless chat already has a display name that isn't raw identifiers
        const isRawIds = thread.chat === thread.participants.join(", ") || thread.chat === thread.participants[0];
        if (isRawIds) {
          thread.chat = resolved.join(", ");
        }
      }

      // Render clean inbox view
      const COL = 32;
      const line = "─".repeat(COL + 14);

      console.log();
      console.log(`  ${"CONTACT".padEnd(COL)}  TIME`);
      console.log(`  ${line}`);

      for (const thread of threads) {
        const name = thread.chat.length > COL
          ? thread.chat.slice(0, COL - 3) + "..."
          : thread.chat;
        const time = formatTime(thread.timestamp);
        const preview = thread.preview ?? "(no content)";

        console.log(`  ${name.padEnd(COL)}  ${time}`);
        console.log(`    > ${preview}`);
        console.log(`  ${line}`);
      }
      console.log();
      break;
    }
    case "read": {
      const limit = parseInt(process.argv[3]) || 20;
      const contact = process.argv[4];
      const messages = readMessages(limit, contact);

      // Resolve sender names (including reaction senders)
      const senderIds = messages
        .filter((m) => !m.is_from_me)
        .map((m) => m.sender);
      const reactionSenderIds = messages
        .flatMap((m) => m.reactions ?? [])
        .map((r) => r.sender)
        .filter((s) => s !== "You");
      const senderMap = resolveIdentifiers([...senderIds, ...reactionSenderIds]);

      const now = Date.now();
      const line = "─".repeat(50);

      console.log();
      for (const msg of messages.reverse()) {
        const d = new Date(msg.timestamp);
        const diffDays = Math.floor((now - d.getTime()) / 86_400_000);
        let time: string;
        if (diffDays === 0)
          time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        else if (diffDays === 1)
          time = "Yesterday " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        else
          time = d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
            " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

        const sender = msg.is_from_me
          ? "Me"
          : (senderMap.get(msg.sender) ?? msg.sender);
        const text = msg.text ?? "(no content)";
        const reactions = msg.reactions ? ` ${formatReactions(msg.reactions, senderMap)}` : "";

        console.log(`  ${sender}  ${time}`);
        console.log(`    ${text}${reactions}`);
        console.log();
      }
      break;
    }
    case "search": {
      const keyword = process.argv[3];
      if (!keyword) {
        console.error("Error: keyword required");
        usage();
        process.exit(1);
      }
      const limit = parseInt(process.argv[4]) || 25;
      const messages = searchMessages(keyword, limit);

      const senderIds = messages
        .filter((m) => !m.is_from_me)
        .map((m) => m.sender);
      const reactionSenderIds2 = messages
        .flatMap((m) => m.reactions ?? [])
        .map((r) => r.sender)
        .filter((s) => s !== "You");
      const senderMap = resolveIdentifiers([...senderIds, ...reactionSenderIds2]);

      const now = Date.now();

      console.log();
      console.log(`  Found ${messages.length} messages matching "${keyword}"`);
      console.log(`  ${"─".repeat(50)}`);
      for (const msg of messages.reverse()) {
        const d = new Date(msg.timestamp);
        const diffDays = Math.floor((now - d.getTime()) / 86_400_000);
        let time: string;
        if (diffDays === 0)
          time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        else if (diffDays === 1)
          time = "Yesterday " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        else
          time = d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
            " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

        const sender = msg.is_from_me
          ? "Me"
          : (senderMap.get(msg.sender) ?? msg.sender);
        const text = msg.text ?? "(no content)";
        const reactions = msg.reactions ? ` ${formatReactions(msg.reactions, senderMap)}` : "";

        console.log(`  ${sender}  ${time}`);
        console.log(`    ${text}${reactions}`);
        console.log();
      }
      break;
    }
    case "contacts": {
      const contacts = listContacts();
      console.table(contacts);
      break;
    }
    case "send": {
      let recipient = process.argv[3];
      const message = process.argv[4];
      if (!recipient || !message) {
        console.error("Error: recipient and message required");
        usage();
        process.exit(1);
      }
      // Resolve contact name to phone number if needed
      let displayName = recipient;
      if (!isDirectRecipient(recipient)) {
        const matches = lookupContacts(recipient);
        if (matches.length === 0) {
          console.error(`No contact found matching "${recipient}"`);
          process.exit(1);
        }
        if (matches.length > 1) {
          console.log(`\nMultiple contacts match "${recipient}":\n`);
          for (let i = 0; i < matches.length; i++) {
            console.log(`  ${i + 1}. ${matches[i].name} (${matches[i].phone})`);
          }
          console.log(`\nRe-run with the full name or phone number to send.`);
          process.exit(1);
        }
        const contact = matches[0];
        console.log(`Resolved "${recipient}" -> ${contact.name} (${contact.phone})`);
        displayName = contact.name;
        recipient = contact.phone;
      }
      const flag = process.argv[5];
      const serviceOverride =
        flag === "--sms" ? "SMS" as const :
        flag === "--rcs" ? "RCS" as const :
        flag === "--imessage" ? "iMessage" as const :
        undefined;
      const usedService = await sendMessage(recipient, message, serviceOverride);
      console.log(`Message sent to ${displayName} via ${usedService}`);
      break;
    }
    default:
      usage();
      break;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
