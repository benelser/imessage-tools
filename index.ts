#!/usr/bin/env bun
import { readMessages, readGroupMessages, searchMessages, searchMessagesWithContext, listContacts, inbox, catchup, formatReactions, findGroupChats } from "./src/db";
import { sendMessage, sendToGroup, createGroupChat } from "./src/send";
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
  send "Name1, Name2" <message>  Send same message to multiple contacts (1:many)
  send --group "Group Name" <message>  Send to an existing group chat
  create-group resolve "names..."    Resolve contacts for a new group chat
  create-group send "phones" "msg"   Create a group chat with resolved numbers
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
      // Check for --group flag
      if (process.argv[3] === "--group") {
        const groupName = process.argv[4];
        const limit = parseInt(process.argv[5]) || 30;
        if (!groupName) {
          console.error('Error: group name required\nUsage: read --group "Group Name" [limit]');
          process.exit(1);
        }
        const groupMatches = findGroupChats(groupName);
        if (groupMatches.length === 0) {
          console.error(`No group chat found matching "${groupName}"`);
          process.exit(1);
        }
        let target = groupMatches[0];
        if (groupMatches.length > 1) {
          const exact = groupMatches.find((m) => m.displayName.toLowerCase() === groupName.toLowerCase());
          if (exact) {
            target = exact;
          } else {
            console.log(`\nMultiple group chats match "${groupName}":\n`);
            for (let i = 0; i < groupMatches.length; i++) {
              console.log(`  ${i + 1}. ${groupMatches[i].displayName}`);
            }
            console.log(`\nBe more specific to select a group.`);
            process.exit(1);
          }
        }
        const groupMessages = readGroupMessages(target.chatIdentifier, limit);
        const groupSenderIds = groupMessages.filter((m) => !m.is_from_me).map((m) => m.sender);
        const groupReactionIds = groupMessages.flatMap((m) => m.reactions ?? []).map((r) => r.sender).filter((s) => s !== "You");
        const groupSenderMap = resolveIdentifiers([...groupSenderIds, ...groupReactionIds]);

        // Use single-conversation view with group name header
        const WIDTH = process.stdout.columns || 80;
        console.log();
        console.log(`  ── ${target.displayName} ${"─".repeat(Math.max(0, WIDTH - target.displayName.length - 6))}`);
        console.log();

        // Reuse conversation-style display
        const sorted = groupMessages.reverse();
        let lastDate: string | null = null;
        let lastSender: string | null = null;
        let lastMsgTime = 0;

        for (const msg of sorted) {
          const d = new Date(msg.timestamp);
          const dateStr = d.toDateString();
          const now = new Date();
          const yesterdayDate = new Date(now); yesterdayDate.setDate(yesterdayDate.getDate() - 1);
          const dayLbl = d.toDateString() === now.toDateString() ? "Today"
            : d.toDateString() === yesterdayDate.toDateString() ? "Yesterday"
            : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

          if (dateStr !== lastDate) {
            if (lastDate !== null) console.log();
            const label = `── ${dayLbl} ──`;
            const pad = Math.max(0, Math.floor((WIDTH - label.length) / 2));
            console.log(" ".repeat(pad) + label);
            console.log();
            lastDate = dateStr;
            lastSender = null;
            lastMsgTime = 0;
          }

          const sender = msg.is_from_me ? "Me" : (groupSenderMap.get(msg.sender) ?? msg.sender);
          const senderKey = msg.is_from_me ? "__me__" : msg.sender;
          const text = msg.text ?? "(no content)";
          const reactions = msg.reactions ? ` ${formatReactions(msg.reactions, groupSenderMap)}` : "";
          const msgTime = d.getTime();
          const showTime = (msgTime - lastMsgTime) >= 30 * 60 * 1000;
          const showSender = senderKey !== lastSender;
          const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

          if (msg.is_from_me) {
            if (showSender && lastSender !== null) console.log();
            const content = `${text}${reactions}`;
            const timeSuffix = showTime ? `  ${timeStr}` : "";
            const line = `${content}${timeSuffix}`;
            const linePad = Math.max(0, WIDTH - line.length - 2);
            console.log(" ".repeat(linePad) + line);
          } else {
            if (showSender) {
              if (lastSender !== null) console.log();
              console.log(showTime ? `${sender}  ${timeStr}` : sender);
            } else if (showTime) {
              console.log();
              console.log(`${sender}  ${timeStr}`);
            }
            console.log(`    ${text}${reactions}`);
          }

          lastSender = senderKey;
          lastMsgTime = msgTime;
        }
        console.log();
        break;
      }

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
      // Check for --group flag
      if (process.argv[3] === "--group") {
        const groupName = process.argv[4];
        const groupMessage = process.argv[5];
        if (!groupName || !groupMessage) {
          console.error("Error: group name and message required");
          console.error('Usage: send --group "Group Name" "message"');
          process.exit(1);
        }
        const matches = findGroupChats(groupName);
        if (matches.length === 0) {
          console.error(`No group chat found matching "${groupName}"`);
          process.exit(1);
        }
        if (matches.length > 1) {
          // Check for exact match first
          const exact = matches.find(
            (m) => m.displayName.toLowerCase() === groupName.toLowerCase()
          );
          if (exact) {
            console.log(`Sending to group "${exact.displayName}"...`);
            await sendToGroup(exact.guid, groupMessage);
            console.log(`Message sent to group "${exact.displayName}"`);
          } else {
            console.log(`\nMultiple group chats match "${groupName}":\n`);
            for (let i = 0; i < matches.length; i++) {
              console.log(`  ${i + 1}. ${matches[i].displayName}`);
            }
            console.log(`\nBe more specific to select a group.`);
            process.exit(1);
          }
        } else {
          console.log(`Sending to group "${matches[0].displayName}"...`);
          await sendToGroup(matches[0].guid, groupMessage);
          console.log(`Message sent to group "${matches[0].displayName}"`);
        }
        break;
      }

      let recipient = process.argv[3];
      const message = process.argv[4];
      if (!recipient || !message) {
        console.error("Error: recipient and message required");
        usage();
        process.exit(1);
      }

      // Check for comma-separated recipients (1:many mode)
      if (recipient.includes(",") && !isDirectRecipient(recipient)) {
        const names = recipient.split(",").map((n) => n.trim()).filter(Boolean);
        if (names.length < 2) {
          console.error("Error: provide at least two comma-separated names for multi-send");
          process.exit(1);
        }

        const flag = process.argv[5];
        const serviceOverride =
          flag === "--sms" ? "SMS" as const :
          flag === "--rcs" ? "RCS" as const :
          flag === "--imessage" ? "iMessage" as const :
          undefined;

        console.log(`Sending to ${names.length} recipients...\n`);
        const results: { name: string; status: string }[] = [];

        for (const name of names) {
          let resolvedRecipient = name;
          let displayName = name;

          if (!isDirectRecipient(name)) {
            const matches = lookupContacts(name);
            if (matches.length === 0) {
              results.push({ name, status: "FAILED - no contact found" });
              continue;
            }
            if (matches.length > 1) {
              // Check for high-confidence match (exact first or full name)
              const exactFull = matches.find(
                (m) => m.name.toLowerCase() === name.toLowerCase()
              );
              const exactFirst = matches.find(
                (m) => m.name.split(" ")[0].toLowerCase() === name.toLowerCase()
              );
              const best = exactFull ?? exactFirst;
              if (!best || (matches.length > 1 && !exactFull && matches[0].name.split(" ")[0].toLowerCase() === matches[1].name.split(" ")[0].toLowerCase())) {
                const preview = matches.slice(0, 3).map((m) => m.name).join(", ");
                results.push({ name, status: `FAILED - ambiguous (${preview}${matches.length > 3 ? "..." : ""})` });
                continue;
              }
              displayName = best.name;
              resolvedRecipient = best.phone;
              console.log(`  Resolved "${name}" -> ${best.name} (${best.phone})`);
            } else {
              const contact = matches[0];
              displayName = contact.name;
              resolvedRecipient = contact.phone;
              console.log(`  Resolved "${name}" -> ${contact.name} (${contact.phone})`);
            }
          }

          try {
            const usedService = await sendMessage(resolvedRecipient, message, serviceOverride);
            results.push({ name: displayName, status: `sent via ${usedService}` });
          } catch (err: any) {
            results.push({ name: displayName, status: `FAILED - ${err.message}` });
          }
        }

        console.log();
        for (const r of results) {
          const icon = r.status.startsWith("FAILED") ? "x" : "ok";
          console.log(`  [${icon}] ${r.name}: ${r.status}`);
        }

        const failed = results.filter((r) => r.status.startsWith("FAILED"));
        if (failed.length > 0) {
          console.log(`\n${failed.length} of ${names.length} sends failed.`);
          process.exit(1);
        }
        break;
      }

      // Standard 1:1 send
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
    case "create-group": {
      const subcommand = process.argv[3];

      if (subcommand === "resolve") {
        const input = process.argv[4];
        if (!input) {
          console.error("Error: names/numbers required");
          console.error('Usage: create-group resolve "Jane, John, +15551234567"');
          process.exit(1);
        }

        const names = input.split(",").map((n) => n.trim()).filter(Boolean);
        const resolved: { input: string; name: string; phone: string; status: string }[] = [];
        const ambiguous: { input: string; candidates: string[] }[] = [];
        const notFound: string[] = [];

        for (const name of names) {
          if (isDirectRecipient(name)) {
            // Already a phone number or email — pass through
            const displayName = resolveIdentifiers([name]).get(name) ?? name;
            resolved.push({ input: name, name: displayName, phone: name, status: "ok" });
          } else {
            const matches = lookupContacts(name);
            if (matches.length === 0) {
              notFound.push(name);
            } else if (matches.length === 1) {
              resolved.push({ input: name, name: matches[0].name, phone: matches[0].phone, status: "ok" });
            } else {
              // Check for high-confidence match
              const exactFull = matches.find((m) => m.name.toLowerCase() === name.toLowerCase());
              const exactFirst = matches.find((m) => m.name.split(" ")[0].toLowerCase() === name.toLowerCase());
              const best = exactFull ?? exactFirst;

              if (best && !(matches.length > 1 && !exactFull &&
                matches[0].name.split(" ")[0].toLowerCase() === matches[1].name.split(" ")[0].toLowerCase())) {
                resolved.push({ input: name, name: best.name, phone: best.phone, status: "ok" });
              } else {
                ambiguous.push({
                  input: name,
                  candidates: matches.slice(0, 5).map((m) => `${m.name} (${m.phone})`),
                });
              }
            }
          }
        }

        console.log(JSON.stringify({ resolved, ambiguous, notFound }, null, 2));
        break;
      }

      if (subcommand === "send") {
        const phones = process.argv[4];
        const groupMessage = process.argv[5];
        if (!phones || !groupMessage) {
          console.error("Error: phone numbers and message required");
          console.error('Usage: create-group send "+15551234567,+15559876543" "Hello!"');
          process.exit(1);
        }

        const recipients = phones.split(",").map((p) => p.trim()).filter(Boolean);
        if (recipients.length < 2) {
          console.error("Error: at least 2 recipients required for a group chat");
          process.exit(1);
        }

        console.log(`Creating group chat with ${recipients.length} recipients...`);
        await createGroupChat(recipients, groupMessage);
        console.log(`Group chat created and first message sent to ${recipients.length} recipients.`);
        break;
      }

      console.error("Error: unknown subcommand. Use 'resolve' or 'send'.");
      console.error('Usage: create-group resolve "names..."');
      console.error('       create-group send "phones" "message"');
      process.exit(1);
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
