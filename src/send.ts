import { openChatDB } from "./db";

export type ServiceType = "iMessage" | "SMS" | "RCS";

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
