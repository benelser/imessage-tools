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
 * Look up which services a contact has used by checking chat history.
 * Returns services ordered by most recent usage.
 */
function detectServices(recipient: string): ServiceType[] {
  const db = openChatDB();
  try {
    const rows = db
      .query(
        `SELECT DISTINCT c.service_name
         FROM chat c
         WHERE c.chat_identifier = ?
         ORDER BY c.ROWID DESC`
      )
      .all(recipient) as any[];
    return rows.map((r: any) => r.service_name as ServiceType);
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
 * Send a message via Messages.app.
 *
 * If `service` is specified, sends via that service only.
 * Otherwise, determines the order from chat history + priority:
 *   - Known services from history are tried first (most recent first)
 *   - Then remaining services in priority order: iMessage > RCS > SMS
 */
export async function sendMessage(
  recipient: string,
  message: string,
  service?: ServiceType
): Promise<ServiceType> {
  if (service) {
    const ok = await trySend(recipient, message, service);
    if (!ok) throw new Error(`Failed to send via ${service}`);
    return service;
  }

  // Build ordered list: known services first, then remaining by priority
  const known = detectServices(recipient);
  const tried = new Set<ServiceType>();
  const order: ServiceType[] = [];

  // Known services from chat history first
  for (const s of known) {
    if (!tried.has(s)) {
      order.push(s);
      tried.add(s);
    }
  }
  // Fill in remaining services by priority
  for (const s of SERVICE_PRIORITY) {
    if (!tried.has(s)) {
      order.push(s);
      tried.add(s);
    }
  }

  for (const svc of order) {
    console.log(`Trying ${svc}...`);
    const ok = await trySend(recipient, message, svc);
    if (ok) return svc;
    console.log(`${svc} failed, falling back...`);
  }

  throw new Error(
    `Failed to send to ${recipient} via any service (tried: ${order.join(", ")})`
  );
}
