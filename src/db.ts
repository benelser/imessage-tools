import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";

const CHAT_DB_PATH = join(homedir(), "Library/Messages/chat.db");

// macOS Core Data epoch offset (2001-01-01 to 1970-01-01) in seconds
const CORE_DATA_EPOCH_OFFSET = 978307200;

// Classic tapback types (associated_message_type)
const TAPBACK_MAP: Record<number, string> = {
  2000: "♥️ Loved",
  2001: "👍 Liked",
  2002: "👎 Disliked",
  2003: "😂 Laughed",
  2004: "‼️ Emphasized",
  2005: "❓ Questioned",
  // 3000-3005 are "removed" tapbacks
  3000: "Removed ♥️",
  3001: "Removed 👍",
  3002: "Removed 👎",
  3003: "Removed 😂",
  3004: "Removed ‼️",
  3005: "Removed ❓",
};

function coredateToISO(coredate: number): string {
  const unix = coredate / 1_000_000_000 + CORE_DATA_EPOCH_OFFSET;
  return new Date(unix * 1000).toISOString();
}

function truncate(text: string | null, maxWords = 10): string | null {
  if (!text) return text;
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "...";
}

/**
 * Extract text from the NSAttributedString blob stored in attributedBody.
 * The blob is an NSKeyedArchiver binary — after the "NSString" marker there
 * is a 5-byte header (01 9x 84 01 2b) followed by a length byte and then
 * the UTF-8 string content.
 */
function extractFromAttributedBody(blob: Uint8Array | null): string | null {
  if (!blob) return null;
  const marker = new TextEncoder().encode("NSString");
  let idx = -1;
  outer: for (let i = 0; i < blob.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (blob[i + j] !== marker[j]) continue outer;
    }
    idx = i + marker.length;
    break;
  }
  if (idx === -1) return null;

  // Skip the 5-byte header after "NSString": 01 9x 84 01 2b
  idx += 5;
  if (idx >= blob.length) return null;

  // Next byte is the string length
  const len = blob[idx];
  idx += 1;
  if (idx + len > blob.length) return null;

  const text = new TextDecoder("utf-8", { fatal: false }).decode(
    blob.slice(idx, idx + len)
  );
  // Strip the object replacement character (U+FFFC) used for inline attachments
  return text.replace(/\uFFFC/g, "").trim() || null;
}

/**
 * Resolve the display text for a message, handling:
 * 1. Regular text (m.text)
 * 2. Text stored in attributedBody (newer macOS)
 * 3. Tapback reactions (associated_message_type 2000-2005, 2006 emoji)
 * 4. Attachments (images, files, audio)
 * 5. Link previews (balloon_bundle_id)
 */
function resolveText(row: any): string | null {
  // Tapback / reaction
  if (row.associated_message_type) {
    const type = row.associated_message_type as number;
    if (type === 2006 || type === 3006) {
      const emoji = row.associated_message_emoji ?? "🫥";
      return type === 3006
        ? `[Removed ${emoji} reaction]`
        : `[${emoji} reaction]`;
    }
    const label = TAPBACK_MAP[type];
    if (label) return `[${label}]`;
  }

  // Try m.text first (strip U+FFFC object replacement chars used for inline attachments)
  if (row.text) {
    const cleaned = row.text.replace(/\uFFFC/g, "").trim();
    if (cleaned) return cleaned;
  }

  // Fall back to attributedBody
  if (row.attributedBody) {
    const extracted = extractFromAttributedBody(
      new Uint8Array(row.attributedBody)
    );
    if (extracted) return extracted;
  }

  // Attachment-only message
  if (row.cache_has_attachments) {
    const mime = row.mime_type;
    const name = row.transfer_name;
    if (mime?.startsWith("image/")) return `[Image: ${name ?? "photo"}]`;
    if (mime?.startsWith("video/")) return `[Video: ${name ?? "video"}]`;
    if (mime?.startsWith("audio/") || row.is_audio_message)
      return `[Audio: ${name ?? "voice memo"}]`;
    if (row.balloon_bundle_id === "com.apple.messages.URLBalloonProvider")
      return `[Link shared]`;
    if (name) return `[Attachment: ${name}]`;
    return "[Attachment]";
  }

  // Link balloon without attachment
  if (row.balloon_bundle_id === "com.apple.messages.URLBalloonProvider")
    return "[Link shared]";

  return null;
}

export function openChatDB(): Database {
  return new Database(CHAT_DB_PATH, { readonly: true });
}

export interface Message {
  timestamp: string;
  sender: string;
  text: string | null;
  is_from_me: boolean;
}

export function readMessages(limit = 20, contact?: string): Message[] {
  const db = openChatDB();
  try {
    const whereClause = contact ? `WHERE h.id = ?` : "";
    const params = contact ? [contact, limit] : [limit];

    const rows = db
      .query(
        `SELECT
          m.date as coredate,
          m.is_from_me,
          m.text,
          m.attributedBody,
          m.cache_has_attachments,
          m.associated_message_type,
          m.associated_message_emoji,
          m.balloon_bundle_id,
          m.is_audio_message,
          h.id as handle_id,
          a.mime_type,
          a.transfer_name
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
        LEFT JOIN attachment a ON a.ROWID = maj.attachment_id
        ${whereClause}
        GROUP BY m.ROWID
        ORDER BY m.date DESC
        LIMIT ?`
      )
      .all(...params) as any[];

    return rows.map((row) => ({
      timestamp: coredateToISO(row.coredate),
      sender: row.is_from_me ? "Me" : (row.handle_id ?? "Unknown"),
      text: truncate(resolveText(row)),
      is_from_me: !!row.is_from_me,
    }));
  } finally {
    db.close();
  }
}

export function searchMessages(keyword: string, limit = 25): Message[] {
  const db = openChatDB();
  try {
    const rows = db
      .query(
        `SELECT
          m.date as coredate,
          m.is_from_me,
          m.text,
          m.attributedBody,
          m.cache_has_attachments,
          m.associated_message_type,
          m.associated_message_emoji,
          m.balloon_bundle_id,
          m.is_audio_message,
          h.id as handle_id,
          a.mime_type,
          a.transfer_name
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
        LEFT JOIN attachment a ON a.ROWID = maj.attachment_id
        WHERE m.text LIKE ? OR m.attributedBody LIKE ?
        GROUP BY m.ROWID
        ORDER BY m.date DESC
        LIMIT ?`
      )
      .all(`%${keyword}%`, `%${keyword}%`, limit) as any[];

    return rows.map((row) => ({
      timestamp: coredateToISO(row.coredate),
      sender: row.is_from_me ? "Me" : (row.handle_id ?? "Unknown"),
      text: truncate(resolveText(row)),
      is_from_me: !!row.is_from_me,
    }));
  } finally {
    db.close();
  }
}

export interface Contact {
  id: string;
  messageCount: number;
  lastMessage: string;
}

export function listContacts(): Contact[] {
  const db = openChatDB();
  try {
    const rows = db
      .query(
        `SELECT
          h.id,
          COUNT(m.ROWID) as message_count,
          MAX(m.date) as last_date
        FROM handle h
        JOIN message m ON m.handle_id = h.ROWID
        GROUP BY h.id
        ORDER BY message_count DESC`
      )
      .all() as any[];

    return rows.map((row) => ({
      id: row.id,
      messageCount: row.message_count,
      lastMessage: coredateToISO(row.last_date),
    }));
  } finally {
    db.close();
  }
}

export interface InboxThread {
  chat: string;
  participants: string[]; // raw identifiers for contact resolution
  timestamp: string;
  preview: string | null;
}

export function inbox(limit = 15): InboxThread[] {
  const db = openChatDB();
  try {
    // Get the latest message per chat, ordered by recency
    const chats = db
      .query(
        `SELECT
          c.ROWID as chat_id,
          c.display_name,
          c.chat_identifier,
          c.style,
          MAX(cmj.message_date) as last_date
        FROM chat c
        JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
        GROUP BY c.ROWID
        ORDER BY last_date DESC
        LIMIT ?`
      )
      .all(limit) as any[];

    const results: InboxThread[] = [];

    for (const chat of chats) {
      // Collect participant identifiers
      const handles = db
        .query(
          `SELECT h.id FROM chat_handle_join chj
           JOIN handle h ON h.ROWID = chj.handle_id
           WHERE chj.chat_id = ?`
        )
        .all(chat.chat_id) as any[];
      const participants = handles.map((h: any) => h.id as string);

      // Build display name: use display_name for groups, otherwise identifier
      let name = chat.display_name;
      if (!name) {
        if (chat.style === 43) {
          name = participants.join(", ");
        } else {
          name = chat.chat_identifier;
        }
      }

      // Get the latest message in this chat
      const msg = db
        .query(
          `SELECT
            m.date as coredate,
            m.is_from_me,
            m.text,
            m.attributedBody,
            m.cache_has_attachments,
            m.associated_message_type,
            m.associated_message_emoji,
            m.balloon_bundle_id,
            m.is_audio_message,
            h.id as handle_id,
            a.mime_type,
            a.transfer_name
          FROM message m
          JOIN chat_message_join cmj ON cmj.message_id = m.ROWID AND cmj.chat_id = ?
          LEFT JOIN handle h ON m.handle_id = h.ROWID
          LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
          LEFT JOIN attachment a ON a.ROWID = maj.attachment_id
          ORDER BY m.date DESC
          LIMIT 1`
        )
        .get(chat.chat_id) as any;

      if (!msg) continue;

      const text = resolveText(msg);
      const preview = truncate(text);

      results.push({
        chat: name,
        participants,
        timestamp: coredateToISO(msg.coredate),
        preview,
      });
    }

    return results;
  } finally {
    db.close();
  }
}
