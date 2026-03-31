import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import { readdirSync } from "fs";

export interface ResolvedContact {
  name: string;
  phone: string;
}

const AB_SOURCES_DIR = join(
  homedir(),
  "Library/Application Support/AddressBook/Sources"
);

interface ContactRecord {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * Load all contacts from all AddressBook SQLite databases.
 * Builds phone-digits->name and email->name lookup maps.
 */
function loadContactMaps(): {
  phoneLookup: Map<string, string>;
  emailLookup: Map<string, string>;
} {
  const phoneLookup = new Map<string, string>();
  const emailLookup = new Map<string, string>();

  let sources: string[];
  try {
    sources = readdirSync(AB_SOURCES_DIR);
  } catch {
    return { phoneLookup, emailLookup };
  }

  for (const source of sources) {
    const dbPath = join(AB_SOURCES_DIR, source, "AddressBook-v22.abcddb");
    let db: Database;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      continue;
    }

    try {
      const rows = db
        .query(
          `SELECT r.ZFIRSTNAME as firstName, r.ZLASTNAME as lastName,
                  p.ZFULLNUMBER as phone, e.ZADDRESS as email
           FROM ZABCDRECORD r
           LEFT JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
           LEFT JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
           WHERE phone IS NOT NULL OR email IS NOT NULL`
        )
        .all() as ContactRecord[];

      for (const row of rows) {
        const name = [row.firstName, row.lastName].filter(Boolean).join(" ");
        if (!name) continue;

        if (row.phone) {
          const digits = row.phone.replace(/\D/g, "");
          if (digits.length >= 7) {
            phoneLookup.set(digits, name);
            if (digits.length > 10) phoneLookup.set(digits.slice(-10), name);
          }
        }
        if (row.email) {
          emailLookup.set(row.email.toLowerCase(), name);
        }
      }
    } finally {
      db.close();
    }
  }

  return { phoneLookup, emailLookup };
}

// Cache the maps — they're loaded once per process
let _cache: ReturnType<typeof loadContactMaps> | null = null;
function getContactMaps() {
  if (!_cache) _cache = loadContactMaps();
  return _cache;
}

/**
 * Resolve a phone number or email to a contact name.
 * Returns the contact name if found, or the original identifier if not.
 */
export function resolveIdentifier(identifier: string): string {
  const { phoneLookup, emailLookup } = getContactMaps();

  if (identifier.includes("@")) {
    return emailLookup.get(identifier.toLowerCase()) ?? identifier;
  }

  const digits = identifier.replace(/\D/g, "");
  return (
    phoneLookup.get(digits) ??
    phoneLookup.get(digits.slice(-10)) ??
    identifier
  );
}

/**
 * Batch resolve multiple identifiers to contact names.
 * Returns a map of identifier -> display name.
 */
export function resolveIdentifiers(
  identifiers: string[]
): Map<string, string> {
  const results = new Map<string, string>();
  for (const id of new Set(identifiers)) {
    results.set(id, resolveIdentifier(id));
  }
  return results;
}

/**
 * Look up a contact by name. Returns first match with phone number.
 * Throws if no match found.
 */
export function lookupContact(query: string): ResolvedContact {
  const q = query.toLowerCase();
  let sources: string[];
  try {
    sources = readdirSync(AB_SOURCES_DIR);
  } catch {
    throw new Error("Cannot access AddressBook database");
  }

  for (const source of sources) {
    const dbPath = join(AB_SOURCES_DIR, source, "AddressBook-v22.abcddb");
    let db: Database;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      continue;
    }

    try {
      const rows = db
        .query(
          `SELECT r.ZFIRSTNAME as firstName, r.ZLASTNAME as lastName,
                  p.ZFULLNUMBER as phone
           FROM ZABCDRECORD r
           JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
           WHERE LOWER(r.ZFIRSTNAME) LIKE ? OR LOWER(r.ZLASTNAME) LIKE ?
              OR LOWER(r.ZFIRSTNAME || ' ' || r.ZLASTNAME) LIKE ?
           LIMIT 1`
        )
        .all(`%${q}%`, `%${q}%`, `%${q}%`) as any[];

      if (rows.length > 0) {
        const row = rows[0];
        const name = [row.firstName, row.lastName].filter(Boolean).join(" ");
        return { name, phone: row.phone };
      }
    } finally {
      db.close();
    }
  }

  throw new Error(`No contact found matching "${query}"`);
}

/**
 * Determine if a string looks like a phone number / email (i.e. already a recipient)
 * versus a contact name that needs resolution.
 */
export function isDirectRecipient(input: string): boolean {
  return input.startsWith("+") || input.includes("@") || /^\d{4,}$/.test(input);
}
