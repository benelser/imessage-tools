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

// Emoji-only map for inline reaction display
const TAPBACK_EMOJI: Record<number, string> = {
  2000: "♥️",
  2001: "👍",
  2002: "👎",
  2003: "😂",
  2004: "‼️",
  2005: "❓",
};

/**
 * Extract the parent message GUID from an associated_message_guid value.
 * Formats seen: "p:0/GUID", "p:1/GUID", "bp:1/GUID", or raw "GUID".
 */
function extractParentGuid(assocGuid: string): string {
  const slashIdx = assocGuid.indexOf("/");
  if (slashIdx !== -1) return assocGuid.slice(slashIdx + 1);
  return assocGuid;
}

interface TapbackInfo {
  emoji: string;
  senderHandle: string | null;
  isFromMe: boolean;
  isRemoval: boolean;
}

/**
 * Given a set of parent message GUIDs, fetch all tapback reactions for them
 * and return a map from parent GUID -> list of tapback info.
 */
function fetchTapbacksForGuids(
  db: Database,
  guids: string[]
): Map<string, TapbackInfo[]> {
  const result = new Map<string, TapbackInfo[]>();
  if (guids.length === 0) return result;

  // Build placeholders for IN clause
  const placeholders = guids.map(() => "?").join(",");

  const rows = db
    .query(
      `SELECT
        m.associated_message_guid,
        m.associated_message_type,
        m.associated_message_emoji,
        m.is_from_me,
        h.id as handle_id
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.associated_message_type != 0
        AND m.associated_message_guid IN (${guids.map((g) => `'p:0/${g}'`).join(",")})
      ORDER BY m.date ASC`
    )
    .all() as any[];

  // Also query for other prefix patterns (p:1/, bp:, and raw GUID)
  const rows2 = db
    .query(
      `SELECT
        m.associated_message_guid,
        m.associated_message_type,
        m.associated_message_emoji,
        m.is_from_me,
        h.id as handle_id
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.associated_message_type != 0
        AND m.associated_message_guid NOT LIKE 'p:0/%'
        AND (${guids.map(() => "m.associated_message_guid LIKE '%' || ? OR m.associated_message_guid = ?").join(" OR ")})
      ORDER BY m.date ASC`
    )
    .all(...guids.flatMap((g) => [g, g])) as any[];

  for (const row of [...rows, ...rows2]) {
    const parentGuid = extractParentGuid(row.associated_message_guid);
    const type = row.associated_message_type as number;
    const isRemoval = type >= 3000 && type <= 3006;

    let emoji: string;
    if (type === 2006 || type === 3006) {
      emoji = row.associated_message_emoji ?? "🫥";
    } else {
      emoji = TAPBACK_EMOJI[type] ?? TAPBACK_EMOJI[type - 1000] ?? "?";
    }

    const info: TapbackInfo = {
      emoji,
      senderHandle: row.is_from_me ? null : row.handle_id,
      isFromMe: !!row.is_from_me,
      isRemoval,
    };

    const list = result.get(parentGuid) ?? [];
    list.push(info);
    result.set(parentGuid, list);
  }

  return result;
}

/**
 * Process tapback info into net reactions (after removals cancel adds).
 * Returns null if no net reactions remain.
 */
function buildReactions(tapbacks: TapbackInfo[]): Reaction[] | null {
  const removals = tapbacks.filter((t) => t.isRemoval);
  const adds = tapbacks.filter((t) => !t.isRemoval);

  // Track which adds are cancelled by removals
  const cancelledIndices = new Set<number>();
  for (const removal of removals) {
    const senderKey = removal.isFromMe ? "__me__" : removal.senderHandle;
    for (let i = 0; i < adds.length; i++) {
      if (cancelledIndices.has(i)) continue;
      const add = adds[i];
      const addSenderKey = add.isFromMe ? "__me__" : add.senderHandle;
      if (addSenderKey === senderKey && add.emoji === removal.emoji) {
        cancelledIndices.add(i);
        break;
      }
    }
  }

  const result: Reaction[] = [];
  for (let i = 0; i < adds.length; i++) {
    if (!cancelledIndices.has(i)) {
      result.push({
        emoji: adds[i].emoji,
        sender: adds[i].isFromMe ? "You" : (adds[i].senderHandle ?? "Unknown"),
      });
    }
  }

  return result.length > 0 ? result : null;
}

/** Format reactions array into a display string like (emoji Name, emoji Name) */
export function formatReactions(reactions: Reaction[], nameMap?: Map<string, string>): string {
  const parts = reactions.map((r) => {
    const name = r.sender === "You" ? "You" : (nameMap?.get(r.sender) ?? r.sender);
    return `${r.emoji} ${name}`;
  });
  return `(${parts.join(", ")})`;
}

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
    if (mime?.startsWith("image/")) return "Sent a photo";
    if (mime?.startsWith("video/")) return "Sent a video";
    if (mime?.startsWith("audio/") || row.is_audio_message)
      return "Sent a voice memo";
    if (row.balloon_bundle_id === "com.apple.messages.URLBalloonProvider")
      return "Shared a link";
    if (name) return `Sent ${name}`;
    return "Sent an attachment";
  }

  // Link balloon without attachment
  if (row.balloon_bundle_id === "com.apple.messages.URLBalloonProvider")
    return "Shared a link";

  return null;
}

export function openChatDB(): Database {
  return new Database(CHAT_DB_PATH, { readonly: true });
}

export interface Reaction {
  emoji: string;
  sender: string; // raw handle or "You"
}

export interface Message {
  timestamp: string;
  sender: string;
  text: string | null;
  is_from_me: boolean;
  reactions?: Reaction[];
  chat?: string;        // chat identifier (for grouping when reading across chats)
  chatDisplay?: string; // display name or participant list
}

export function readMessages(limit = 20, contact?: string): Message[] {
  const db = openChatDB();
  try {
    const whereClause = contact ? `WHERE h.id = ?` : "";
    const params = contact ? [contact, limit] : [limit];

    const rows = db
      .query(
        `SELECT
          m.guid,
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
          a.transfer_name,
          c.chat_identifier,
          c.display_name as chat_display_name,
          c.style as chat_style
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
        LEFT JOIN attachment a ON a.ROWID = maj.attachment_id
        LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        LEFT JOIN chat c ON c.ROWID = cmj.chat_id
        ${whereClause}
        GROUP BY m.ROWID
        ORDER BY m.date DESC
        LIMIT ?`
      )
      .all(...params) as any[];

    // Separate regular messages from tapbacks
    const regularRows = rows.filter((r) => !r.associated_message_type);
    const parentGuids = regularRows.map((r) => r.guid as string);

    // Fetch tapbacks for these messages
    const tapbackMap = fetchTapbacksForGuids(db, parentGuids);

    // For unnamed group chats, resolve participant names
    const chatDisplayCache = new Map<string, string>();
    for (const row of regularRows) {
      const chatId = row.chat_identifier;
      if (!chatId || chatDisplayCache.has(chatId)) continue;
      if (row.chat_display_name) {
        chatDisplayCache.set(chatId, row.chat_display_name);
      } else if (row.chat_style === 43) {
        // Group chat without a display name — fetch participants
        const handles = db
          .query(
            `SELECT h.id FROM chat_handle_join chj
             JOIN handle h ON h.ROWID = chj.handle_id
             JOIN chat c ON c.ROWID = chj.chat_id
             WHERE c.chat_identifier = ?`
          )
          .all(chatId) as any[];
        const ids = handles.map((h: any) => h.id as string);
        chatDisplayCache.set(chatId, ids.join(", ")); // will be resolved by caller
      }
    }

    return regularRows.map((row) => {
      const tapbacks = tapbackMap.get(row.guid);
      return {
        timestamp: coredateToISO(row.coredate),
        sender: row.is_from_me ? "Me" : (row.handle_id ?? "Unknown"),
        text: truncate(resolveText(row)),
        is_from_me: !!row.is_from_me,
        reactions: tapbacks ? buildReactions(tapbacks) ?? undefined : undefined,
        chat: row.chat_identifier || undefined,
        chatDisplay: chatDisplayCache.get(row.chat_identifier) || row.chat_display_name || undefined,
      };
    });
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
          m.guid,
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

    // Filter out tapback rows from search results
    const regularRows = rows.filter((r) => !r.associated_message_type);
    const parentGuids = regularRows.map((r) => r.guid as string);

    const tapbackMap = fetchTapbacksForGuids(db, parentGuids);

    return regularRows.map((row) => {
      const tapbacks = tapbackMap.get(row.guid);
      return {
        timestamp: coredateToISO(row.coredate),
        sender: row.is_from_me ? "Me" : (row.handle_id ?? "Unknown"),
        text: truncate(resolveText(row)),
        is_from_me: !!row.is_from_me,
        reactions: tapbacks ? buildReactions(tapbacks) ?? undefined : undefined,
      };
    });
  } finally {
    db.close();
  }
}

export interface SearchResult {
  chat: string;
  participants: string[];
  messages: Message[];
  matchIndices: number[];
}

export function searchMessagesWithContext(
  keyword: string,
  limit = 25,
  contextSize = 2
): SearchResult[] {
  const db = openChatDB();
  try {
    // Step 1: Find matching message ROWIDs and their chat associations
    const matchRows = db
      .query(
        `SELECT
          m.ROWID as msg_rowid,
          m.guid,
          m.date as coredate,
          cmj.chat_id
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        WHERE (m.associated_message_type = 0 OR m.associated_message_type IS NULL)
          AND (m.text LIKE ? OR m.attributedBody LIKE ?)
        ORDER BY m.date DESC
        LIMIT ?`
      )
      .all(`%${keyword}%`, `%${keyword}%`, limit) as any[];

    if (matchRows.length === 0) return [];

    // Step 2: Group matches by chat_id, collecting the message ROWIDs
    const chatMatches = new Map<number, { rowids: number[]; guids: string[] }>();
    for (const row of matchRows) {
      const entry = chatMatches.get(row.chat_id) ?? { rowids: [], guids: [] };
      entry.rowids.push(row.msg_rowid);
      entry.guids.push(row.guid);
      chatMatches.set(row.chat_id, entry);
    }

    const results: SearchResult[] = [];

    for (const [chatId, { rowids, guids }] of chatMatches) {
      // Get chat metadata
      const chatRow = db
        .query(
          `SELECT c.display_name, c.chat_identifier, c.style
           FROM chat c WHERE c.ROWID = ?`
        )
        .get(chatId) as any;

      // Get participants
      const handles = db
        .query(
          `SELECT h.id FROM chat_handle_join chj
           JOIN handle h ON h.ROWID = chj.handle_id
           WHERE chj.chat_id = ?`
        )
        .all(chatId) as any[];
      const participants = handles.map((h: any) => h.id as string);

      let chatName = chatRow?.display_name;
      if (!chatName) {
        if (chatRow?.style === 43) {
          chatName = participants.join(", ");
        } else {
          chatName = chatRow?.chat_identifier ?? "Unknown";
        }
      }

      // Step 3: For each match, find context window via date-ordered position
      // Build merged ranges of message ROWIDs we need to fetch
      const allContextRowids = new Set<number>();
      const matchRowidSet = new Set(rowids);

      for (const rowid of rowids) {
        // Get messages before and after the match within this chat
        const before = db
          .query(
            `SELECT m.ROWID as msg_rowid
             FROM message m
             JOIN chat_message_join cmj ON cmj.message_id = m.ROWID AND cmj.chat_id = ?
             WHERE (m.associated_message_type = 0 OR m.associated_message_type IS NULL)
               AND m.date < (SELECT date FROM message WHERE ROWID = ?)
             ORDER BY m.date DESC
             LIMIT ?`
          )
          .all(chatId, rowid, contextSize) as any[];

        const after = db
          .query(
            `SELECT m.ROWID as msg_rowid
             FROM message m
             JOIN chat_message_join cmj ON cmj.message_id = m.ROWID AND cmj.chat_id = ?
             WHERE (m.associated_message_type = 0 OR m.associated_message_type IS NULL)
               AND m.date > (SELECT date FROM message WHERE ROWID = ?)
             ORDER BY m.date ASC
             LIMIT ?`
          )
          .all(chatId, rowid, contextSize) as any[];

        allContextRowids.add(rowid);
        for (const r of before) allContextRowids.add(r.msg_rowid);
        for (const r of after) allContextRowids.add(r.msg_rowid);
      }

      // Step 4: Fetch full message data for all context rowids
      const placeholders = [...allContextRowids].map(() => "?").join(",");
      const msgRows = db
        .query(
          `SELECT
            m.ROWID as msg_rowid,
            m.guid,
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
          WHERE m.ROWID IN (${placeholders})
          GROUP BY m.ROWID
          ORDER BY m.date ASC`
        )
        .all(...allContextRowids) as any[];

      // Build messages array and track which indices are matches
      const msgGuids = msgRows.map((r) => r.guid as string);
      const tapbackMap = fetchTapbacksForGuids(db, msgGuids);

      const messages: Message[] = [];
      const matchIndices: number[] = [];

      for (let i = 0; i < msgRows.length; i++) {
        const row = msgRows[i];
        const tapbacks = tapbackMap.get(row.guid);
        messages.push({
          timestamp: coredateToISO(row.coredate),
          sender: row.is_from_me ? "Me" : (row.handle_id ?? "Unknown"),
          text: resolveText(row),
          is_from_me: !!row.is_from_me,
          reactions: tapbacks ? buildReactions(tapbacks) ?? undefined : undefined,
        });
        if (matchRowidSet.has(row.msg_rowid)) {
          matchIndices.push(i);
        }
      }

      results.push({
        chat: chatName,
        participants,
        messages,
        matchIndices,
      });
    }

    // Sort results by most recent match first
    results.sort((a, b) => {
      const aTime = a.matchIndices.length > 0 ? a.messages[a.matchIndices[0]].timestamp : "";
      const bTime = b.matchIndices.length > 0 ? b.messages[b.matchIndices[0]].timestamp : "";
      return bTime.localeCompare(aTime);
    });

    return results;
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
  lastSender: string;     // raw handle_id of last message sender
  lastIsFromMe: boolean;  // whether the last message was sent by the user
  isGroup: boolean;       // whether the chat is a group chat (style === 43)
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

      // Get the latest non-tapback message in this chat for the preview
      const msg = db
        .query(
          `SELECT
            m.guid,
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
          WHERE m.associated_message_type = 0 OR m.associated_message_type IS NULL
          ORDER BY m.date DESC
          LIMIT 1`
        )
        .get(chat.chat_id) as any;

      if (!msg) continue;

      const text = resolveText(msg);
      const tapbacks = fetchTapbacksForGuids(db, [msg.guid]);
      const reactions = tapbacks.get(msg.guid);
      const netReactions = reactions ? buildReactions(reactions) : null;
      let preview = truncate(text);
      if (preview && netReactions) preview = `${preview} ${formatReactions(netReactions)}`;

      results.push({
        chat: name,
        participants,
        timestamp: coredateToISO(msg.coredate),
        preview,
        lastSender: msg.is_from_me ? "Me" : (msg.handle_id ?? "Unknown"),
        lastIsFromMe: !!msg.is_from_me,
        isGroup: chat.style === 43,
      });
    }

    return results;
  } finally {
    db.close();
  }
}

export interface CatchupThread {
  chat: string;
  participants: string[];
  messages: Message[];
  isGroup: boolean;
}

export interface CatchupResult {
  awaySince: string;      // ISO timestamp of last sent message
  awayDurationMs: number; // milliseconds since last sent message
  threads: CatchupThread[];
  totalMessages: number;
}

export function catchup(hours?: number): CatchupResult {
  const db = openChatDB();
  try {
    const fallbackHours = hours ?? 4;

    // Find the most recent message sent by the user
    const lastSent = db
      .query(
        `SELECT m.date as coredate
         FROM message m
         WHERE m.is_from_me = 1
         ORDER BY m.date DESC
         LIMIT 1`
      )
      .get() as any;

    let sinceDate: number; // coredate threshold
    let awaySinceISO: string;

    if (lastSent && !hours) {
      sinceDate = lastSent.coredate;
      awaySinceISO = coredateToISO(lastSent.coredate);
    } else {
      // Fall back to N hours ago
      const unixThreshold = Date.now() / 1000 - fallbackHours * 3600;
      sinceDate = (unixThreshold - CORE_DATA_EPOCH_OFFSET) * 1_000_000_000;
      awaySinceISO = new Date(unixThreshold * 1000).toISOString();
    }

    const awayDurationMs = Date.now() - new Date(awaySinceISO).getTime();

    // Find all received messages since the threshold, grouped by chat
    const rows = db
      .query(
        `SELECT
          m.guid,
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
          a.transfer_name,
          cmj.chat_id
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
        LEFT JOIN attachment a ON a.ROWID = maj.attachment_id
        WHERE m.date > ?
          AND m.is_from_me = 0
          AND (m.associated_message_type = 0 OR m.associated_message_type IS NULL)
        GROUP BY m.ROWID
        ORDER BY m.date ASC`
      )
      .all(sinceDate) as any[];

    if (rows.length === 0) {
      return {
        awaySince: awaySinceISO,
        awayDurationMs,
        threads: [],
        totalMessages: 0,
      };
    }

    // Group by chat_id
    const chatGroups = new Map<number, any[]>();
    for (const row of rows) {
      const list = chatGroups.get(row.chat_id) ?? [];
      list.push(row);
      chatGroups.set(row.chat_id, list);
    }

    const threads: CatchupThread[] = [];

    for (const [chatId, msgRows] of chatGroups) {
      // Get chat metadata
      const chatRow = db
        .query(
          `SELECT c.display_name, c.chat_identifier, c.style
           FROM chat c WHERE c.ROWID = ?`
        )
        .get(chatId) as any;

      const handles = db
        .query(
          `SELECT h.id FROM chat_handle_join chj
           JOIN handle h ON h.ROWID = chj.handle_id
           WHERE chj.chat_id = ?`
        )
        .all(chatId) as any[];
      const participants = handles.map((h: any) => h.id as string);

      let chatName = chatRow?.display_name;
      if (!chatName) {
        if (chatRow?.style === 43) {
          chatName = participants.join(", ");
        } else {
          chatName = chatRow?.chat_identifier ?? "Unknown";
        }
      }

      const guids = msgRows.map((r: any) => r.guid as string);
      const tapbackMap = fetchTapbacksForGuids(db, guids);

      const messages: Message[] = msgRows.map((row: any) => {
        const tapbacks = tapbackMap.get(row.guid);
        return {
          timestamp: coredateToISO(row.coredate),
          sender: row.handle_id ?? "Unknown",
          text: resolveText(row),
          is_from_me: false,
          reactions: tapbacks ? buildReactions(tapbacks) ?? undefined : undefined,
        };
      });

      threads.push({
        chat: chatName,
        participants,
        messages,
        isGroup: chatRow?.style === 43,
      });
    }

    // Sort by most recent message in each thread
    threads.sort((a, b) => {
      const aLast = a.messages[a.messages.length - 1]?.timestamp ?? "";
      const bLast = b.messages[b.messages.length - 1]?.timestamp ?? "";
      return bLast.localeCompare(aLast);
    });

    const totalMessages = threads.reduce((sum, t) => sum + t.messages.length, 0);

    return {
      awaySince: awaySinceISO,
      awayDurationMs,
      threads,
      totalMessages,
    };
  } finally {
    db.close();
  }
}
