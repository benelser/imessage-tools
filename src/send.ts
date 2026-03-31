import { openChatDB } from "./db";

export type ServiceType = "iMessage" | "SMS" | "RCS";

/**
 * Send a message to a group chat by its chat_identifier (e.g. "chat61028630640742929").
 * Uses AppleScript to target the chat by its full ID.
 */
export async function sendToGroup(
  chatGuid: string,
  message: string
): Promise<void> {
  const escapedMessage = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const script = `
    tell application "Messages"
      set targetChat to chat id "${chatGuid}"
      send "${escapedMessage}" to targetChat
    end tell
  `;

  const proc = Bun.spawn(["osascript", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to send to group chat: ${stderr.trim()}`);
  }
}

/**
 * Create a group chat by sending an initial message to multiple recipients.
 * Uses the imessage:// URL scheme to open a compose window with all recipients
 * and the message body, then System Events to press Enter to send.
 * This is the only reliable approach — AppleScript's `send` doesn't accept
 * a list of participants for group creation.
 */
export async function createGroupChat(
  recipients: string[],
  message: string
): Promise<void> {
  if (recipients.length < 2) {
    throw new Error("Group chat requires at least 2 recipients");
  }

  const addressList = recipients.join(",");
  // URL-encode the message body
  const encodedBody = encodeURIComponent(message);

  const script = `
    -- Save the frontmost app to restore focus after
    tell application "System Events"
      set frontApp to name of first application process whose frontmost is true
    end tell

    tell application "Messages" to activate
    delay 0.3
    open location "imessage://open?addresses=${addressList}&body=${encodedBody}"
    delay 2
    tell application "System Events"
      tell process "Messages"
        key code 36
      end tell
    end tell

    -- Restore focus to the original app
    delay 0.5
    tell application frontApp to activate
  `;

  const proc = Bun.spawn(["osascript", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to create group chat: ${stderr.trim()}`);
  }
}

const SERVICE_PRIORITY: ServiceType[] = ["iMessage", "RCS", "SMS"];

/**
 * Normalize a phone number to the formats used in chat_identifier.
 * The DB stores numbers as +1XXXXXXXXXX (E.164). Contacts may have
 * formatted numbers like (202) 505-2358 or 2025052358.
 */
function normalizePhone(phone: string): string[] {
  const digits = phone.replace(/\D/g, "");
  const candidates: string[] = [];
  // Try with +1 prefix (US)
  if (digits.length === 10) {
    candidates.push(`+1${digits}`);
  }
  // Try with + prefix
  if (digits.length === 11 && digits.startsWith("1")) {
    candidates.push(`+${digits}`);
  }
  // Try as-is with + prefix for international
  if (digits.length > 10 && !digits.startsWith("1")) {
    candidates.push(`+${digits}`);
  }
  // Always include the raw input and digits
  candidates.push(phone);
  candidates.push(digits);
  return [...new Set(candidates)];
}

/**
 * Build a map of account_id -> service type by querying Messages.app via AppleScript.
 * Cached after first call.
 */
let _accountMap: Map<string, ServiceType> | null = null;
async function getAccountMap(): Promise<Map<string, ServiceType>> {
  if (_accountMap) return _accountMap;

  const script = `
    tell application "Messages"
      set output to ""
      repeat with a in every account
        try
          set sType to (service type of a) as text
          set aId to id of a
          set output to output & sType & "|" & aId & "\\n"
        end try
      end repeat
      return output
    end tell
  `;

  const proc = Bun.spawn(["osascript", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();

  _accountMap = new Map();
  for (const line of stdout.trim().split("\n")) {
    const [sType, aId] = line.split("|");
    if (sType && aId) {
      _accountMap.set(aId.trim(), sType.trim() as ServiceType);
    }
  }
  return _accountMap;
}

/**
 * Look up which services a contact has used by checking chat history.
 * Uses account_id (not service_name) to determine the real service,
 * since service_name can be misleading (e.g. "iMessage" for SMS/RCS contacts).
 * Returns services ordered by most recent usage.
 */
async function detectServices(recipient: string): Promise<ServiceType[]> {
  const db = openChatDB();
  try {
    const candidates = normalizePhone(recipient);
    const placeholders = candidates.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT DISTINCT c.account_id, c.service_name
         FROM chat c
         WHERE c.chat_identifier IN (${placeholders})
         ORDER BY c.ROWID DESC`
      )
      .all(...candidates) as any[];

    const accountMap = await getAccountMap();
    const services: ServiceType[] = [];
    const seen = new Set<ServiceType>();

    for (const row of rows) {
      // Trust account_id over service_name
      const realService = accountMap.get(row.account_id) ?? row.service_name as ServiceType;
      if (!seen.has(realService)) {
        services.push(realService);
        seen.add(realService);
      }
    }
    return services;
  } finally {
    db.close();
  }
}

/**
 * Try sending via a specific service. Returns true on success.
 */
async function trySend(
  recipient: string,
  message: string,
  service: ServiceType
): Promise<boolean> {
  const escapedMessage = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedRecipient = recipient.replace(/"/g, '\\"');

  const script = `
    tell application "Messages"
      set targetService to 1st account whose service type = ${service}
      set targetBuddy to participant "${escapedRecipient}" of targetService
      send "${escapedMessage}" to targetBuddy
    end tell
  `;

  const proc = Bun.spawn(["osascript", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });

  return (await proc.exited) === 0;
}

/**
 * Resolve recipient to the E.164 format used in the DB and by AppleScript.
 * If we find a match in chat history, use that exact identifier.
 */
function resolveRecipientFormat(recipient: string): string {
  const db = openChatDB();
  try {
    const candidates = normalizePhone(recipient);
    const placeholders = candidates.map(() => "?").join(",");
    const row = db
      .query(
        `SELECT chat_identifier FROM chat
         WHERE chat_identifier IN (${placeholders})
         ORDER BY ROWID DESC LIMIT 1`
      )
      .get(...candidates) as any;
    return row?.chat_identifier ?? candidates[0] ?? recipient;
  } finally {
    db.close();
  }
}

export async function sendMessage(
  recipient: string,
  message: string,
  service?: ServiceType
): Promise<ServiceType> {
  // Normalize recipient to the format Messages.app expects
  const normalizedRecipient = resolveRecipientFormat(recipient);

  if (service) {
    const ok = await trySend(normalizedRecipient, message, service);
    if (!ok) throw new Error(`Failed to send via ${service}`);
    return service;
  }

  // Build ordered list: known services first, then remaining by priority
  const known = await detectServices(normalizedRecipient);
  const tried = new Set<ServiceType>();
  const order: ServiceType[] = [];

  // Known services from chat history first
  for (const s of known) {
    if (!tried.has(s)) {
      order.push(s);
      tried.add(s);
    }
  }

  // Only fall back to other services if we have no history
  // If DB says RCS or SMS, don't waste time trying iMessage
  if (known.length === 0) {
    for (const s of SERVICE_PRIORITY) {
      if (!tried.has(s)) {
        order.push(s);
        tried.add(s);
      }
    }
  }

  for (const svc of order) {
    console.log(`Trying ${svc}...`);
    const ok = await trySend(normalizedRecipient, message, svc);
    if (ok) return svc;
    console.log(`${svc} failed, falling back...`);
  }

  throw new Error(
    `Failed to send to ${normalizedRecipient} via any service (tried: ${order.join(", ")})`
  );
}
