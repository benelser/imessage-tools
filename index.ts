import { readMessages, searchMessages, searchMessagesWithContext, listContacts, inbox, catchup, formatReactions } from "./src/db";
import { sendMessage } from "./src/send";
import { lookupContact, lookupContacts, isDirectRecipient, resolveIdentifiers } from "./src/contacts";

const command = process.argv[2];

function usage() {
  console.log(`Usage: bun run index.ts <command> [options]

Commands:
  inbox [limit]              Show conversations (like iMessage sidebar)
  read [limit] [contact]     Read recent messages
  search <keyword> [limit]   Search messages by keyword
  catchup [hours]            Show messages since your last sent message
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

      // Collect all participant identifiers for batch resolution (including last message senders)
      const allIds = [
        ...threads.flatMap((t) => t.participants),
        ...threads.filter((t) => !t.lastIsFromMe).map((t) => t.lastSender),
      ];
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
        const isRawIds = thread.chat === thread.participants.join(", ") || thread.chat === thread.participants[0];
        if (isRawIds) {
          if (resolved.length <= 3) {
            thread.chat = resolved.join(", ");
          } else {
            // Use first names + overflow count for large groups
            const firstNames = resolved.map((n) => n.split(" ")[0]);
            thread.chat = `${firstNames.slice(0, 2).join(", ")} +${resolved.length - 2}`;
          }
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
        const rawPreview = thread.preview ?? "(no content)";

        // Sender attribution for preview
        let prefix = "";
        if (thread.lastIsFromMe) {
          prefix = "You: ";
        } else if (thread.isGroup) {
          const senderName = nameMap.get(thread.lastSender) ?? thread.lastSender;
          prefix = `${senderName}: `;
        }
        // 1-on-1 from other: no prefix
        const preview = `${prefix}${rawPreview}`;

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
      const allIds = [
        ...messages.filter((m) => !m.is_from_me).map((m) => m.sender),
        ...messages.flatMap((m) => m.reactions ?? []).map((r) => r.sender).filter((s) => s !== "You"),
      ];
      // Also resolve chat display names (may contain participant phone numbers)
      const chatDisplayIds = messages
        .map((m) => m.chatDisplay)
        .filter(Boolean)
        .flatMap((d) => (d as string).split(", ").map((s) => s.trim()));
      const chatIds = messages.map((m) => m.chat).filter(Boolean) as string[];
      const senderMap = resolveIdentifiers([...allIds, ...chatIds, ...chatDisplayIds]);

      const WIDTH = process.stdout.columns || 80;
      const INDENT = 4;

      function dayLabel(d: Date): string {
        const now = new Date();
        const todayStr = now.toDateString();
        const yesterdayDate = new Date(now);
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        if (d.toDateString() === todayStr) return "Today";
        if (d.toDateString() === yesterdayDate.toDateString()) return "Yesterday";
        return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      }

      function center(s: string): string {
        const pad = Math.max(0, Math.floor((WIDTH - s.length) / 2));
        return " ".repeat(pad) + s;
      }

      function timeOfDay(d: Date): string {
        return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      }

      // Chronological order
      const sorted = messages.reverse();

      if (!contact) {
        // GLOBAL VIEW: group messages by chat, then show each chat's messages
        const chatGroups = new Map<string, typeof sorted>();
        for (const msg of sorted) {
          const key = msg.chat ?? msg.sender;
          const group = chatGroups.get(key) ?? [];
          group.push(msg);
          chatGroups.set(key, group);
        }

        console.log();
        for (const [chatKey, msgs] of chatGroups) {
          // Resolve chat name — chatDisplay for groups, senderMap lookup for 1-on-1
          let chatName = msgs[0].chatDisplay || senderMap.get(msgs[0].chat ?? "") || senderMap.get(chatKey) || chatKey;
          // Resolve any raw phone/email identifiers in the chat name
          if (chatName.includes("+") || chatName.includes("@")) {
            const parts = chatName.split(", ").map((id: string) => senderMap.get(id.trim()) ?? id.trim());
            chatName = parts.length <= 3 ? parts.join(", ") : `${parts.slice(0, 2).join(", ")} +${parts.length - 2}`;
          }
          const separator = "─".repeat(Math.max(0, WIDTH - chatName.length - 6));
          console.log(`  ── ${chatName} ${separator}`);

          for (const msg of msgs) {
            const d = new Date(msg.timestamp);
            const sender = msg.is_from_me ? "You" : (senderMap.get(msg.sender) ?? msg.sender);
            const text = msg.text ?? "(no content)";
            const reactions = msg.reactions ? ` ${formatReactions(msg.reactions, senderMap)}` : "";
            const time = timeOfDay(d);
            console.log(`    ${sender}: ${text}${reactions}  ${time}`);
          }
          console.log();
        }
      } else {
        // SINGLE CONVERSATION VIEW: chat-style with alignment
        let lastDate: string | null = null;
        let lastSender: string | null = null;
        let lastMsgTime: number = 0;

        console.log();

        for (const msg of sorted) {
          const d = new Date(msg.timestamp);
          const dateStr = d.toDateString();

          if (dateStr !== lastDate) {
            if (lastDate !== null) console.log();
            console.log(center(`── ${dayLabel(d)} ──`));
            console.log();
            lastDate = dateStr;
            lastSender = null;
            lastMsgTime = 0;
          }

          const sender = msg.is_from_me ? "Me" : (senderMap.get(msg.sender) ?? msg.sender);
          const senderKey = msg.is_from_me ? "__me__" : msg.sender;
          const text = msg.text ?? "(no content)";
          const reactions = msg.reactions ? ` ${formatReactions(msg.reactions, senderMap)}` : "";
          const msgTime = d.getTime();
          const showTime = (msgTime - lastMsgTime) >= 30 * 60 * 1000;
          const showSender = senderKey !== lastSender;

          if (msg.is_from_me) {
            if (showSender && lastSender !== null) console.log();
            const content = `${text}${reactions}`;
            const timeSuffix = showTime ? `  ${timeOfDay(d)}` : "";
            const line = `${content}${timeSuffix}`;
            const pad = Math.max(0, WIDTH - line.length - 2);
            console.log(" ".repeat(pad) + line);
          } else {
            if (showSender) {
              if (lastSender !== null) console.log();
              console.log(showTime ? `${sender}  ${timeOfDay(d)}` : sender);
            } else if (showTime) {
              console.log();
              console.log(`${sender}  ${timeOfDay(d)}`);
            }
            console.log(" ".repeat(INDENT) + `${text}${reactions}`);
          }

          lastSender = senderKey;
          lastMsgTime = msgTime;
        }
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
      const results = searchMessagesWithContext(keyword, limit);

      // Count total matches and conversations
      const totalMatches = results.reduce((sum, r) => sum + r.matchIndices.length, 0);
      const convCount = results.length;

      // Collect all identifiers for batch resolution
      const allIds = results.flatMap((r) => [
        ...r.participants,
        ...r.messages.filter((m) => !m.is_from_me).map((m) => m.sender),
        ...r.messages.flatMap((m) => m.reactions ?? []).map((rx) => rx.sender).filter((s) => s !== "You"),
      ]);
      const nameMap = resolveIdentifiers(allIds);

      // Resolve chat names
      for (const result of results) {
        const isRawIds =
          result.chat === result.participants.join(", ") ||
          result.chat === result.participants[0];
        if (isRawIds) {
          result.chat = result.participants
            .map((id) => nameMap.get(id) ?? id)
            .join(", ");
        }
      }

      console.log();
      console.log(
        `  Found ${totalMatches} message${totalMatches !== 1 ? "s" : ""} matching "${keyword}" in ${convCount} conversation${convCount !== 1 ? "s" : ""}`
      );

      for (const result of results) {
        const headerLine = `── ${result.chat} `;
        const pad = Math.max(0, 50 - headerLine.length);
        console.log();
        console.log(`  ${headerLine}${"─".repeat(pad)}`);

        for (let i = 0; i < result.messages.length; i++) {
          const msg = result.messages[i];
          const isMatch = result.matchIndices.includes(i);
          const d = new Date(msg.timestamp);
          const time =
            d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
            ", " +
            d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

          const sender = msg.is_from_me
            ? "Me"
            : (nameMap.get(msg.sender) ?? msg.sender);
          const text = msg.text ?? "(no content)";
          const reactions = msg.reactions
            ? ` ${formatReactions(msg.reactions, nameMap)}`
            : "";

          const marker = isMatch ? "▶ " : "  ";

          console.log(`    ${sender}  ${time}`);
          console.log(`  ${marker}  ${text}${reactions}`);
        }
      }

      console.log();
      break;
    }
    case "catchup": {
      const hoursArg = process.argv[3] ? parseFloat(process.argv[3]) : undefined;
      const result = catchup(hoursArg);

      // Collect all identifiers for batch resolution
      const allCatchupIds = [
        ...result.threads.flatMap((t) => t.participants),
        ...result.threads.flatMap((t) => t.messages.filter((m) => !m.is_from_me).map((m) => m.sender)),
        ...result.threads.flatMap((t) => t.messages.flatMap((m) => m.reactions ?? []).map((r) => r.sender).filter((s) => s !== "You")),
      ];
      const catchupNameMap = resolveIdentifiers(allCatchupIds);

      // Resolve chat names
      for (const thread of result.threads) {
        const isRawIds =
          thread.chat === thread.participants.join(", ") ||
          thread.chat === thread.participants[0];
        if (isRawIds) {
          thread.chat = thread.participants
            .map((id) => catchupNameMap.get(id) ?? id)
            .join(", ");
        }
      }

      // Format away duration
      const awayMs = result.awayDurationMs;
      const awayHrs = Math.floor(awayMs / 3_600_000);
      const awayMins = Math.floor((awayMs % 3_600_000) / 60_000);
      let awayStr: string;
      if (awayHrs > 0) {
        awayStr = `${awayHrs}h ${awayMins}m`;
      } else {
        awayStr = `${awayMins}m`;
      }

      const awaySinceTime = new Date(result.awaySince).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      });

      console.log();
      if (hoursArg) {
        console.log(`  Messages from the last ${hoursArg} hour${hoursArg !== 1 ? "s" : ""}`);
      } else {
        console.log(`  You've been away since ${awaySinceTime} (${awayStr})`);
      }

      if (result.threads.length === 0) {
        console.log();
        console.log("  No new messages.");
        console.log();
        break;
      }

      for (const thread of result.threads) {
        const count = thread.messages.length;
        const header = `── ${thread.chat} (${count} new) `;
        const pad = Math.max(0, 50 - header.length);
        console.log();
        console.log(`  ${header}${"─".repeat(pad)}`);

        for (const msg of thread.messages) {
          const d = new Date(msg.timestamp);
          const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
          const senderName = catchupNameMap.get(msg.sender) ?? msg.sender;
          const text = msg.text ?? "(no content)";
          const reactions = msg.reactions ? ` ${formatReactions(msg.reactions, catchupNameMap)}` : "";

          if (thread.isGroup) {
            console.log(`    ${senderName}: ${text}${reactions}  ${time}`);
          } else {
            console.log(`    ${text}${reactions}  ${time}`);
          }
        }
      }

      console.log();
      const convCount = result.threads.length;
      console.log(`  ${result.totalMessages} new message${result.totalMessages !== 1 ? "s" : ""} in ${convCount} conversation${convCount !== 1 ? "s" : ""}`);
      console.log();
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
          const MAX_SHOW = 10;
          const shown = matches.slice(0, MAX_SHOW);
          const remaining = matches.length - MAX_SHOW;
          console.log(`\nMultiple contacts match "${recipient}" (${matches.length} total):\n`);
          for (let i = 0; i < shown.length; i++) {
            console.log(`  ${i + 1}. ${shown[i].name} (${shown[i].phone})`);
          }
          if (remaining > 0) {
            console.log(`  ... and ${remaining} more`);
          }
          console.log(`\nBe more specific or use a phone number to send.`);
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
