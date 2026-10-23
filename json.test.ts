import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Every test runs the CLI (or a one-line script) in a subprocess whose HOME is a temp dir holding a synthetic chat.db,
// with an empty PATH (no osascript). Nothing here can read real messages or send one.

const ME = "+15550001111";        // the 1:1 handle under test (fictional)
const OTHER = "+15550002222";

function synthetic(opts: { modern?: boolean } = {}) {
  const modern = opts.modern ?? true;
  const home = mkdtempSync(join(tmpdir(), "imt-json-"));
  mkdirSync(join(home, "Library/Messages"), { recursive: true });
  const db = new Database(join(home, "Library/Messages/chat.db"));
  db.run(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT)`);
  db.run(`CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, style INTEGER,
           service_name TEXT)`);
  db.run(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER,
           is_from_me INTEGER, handle_id INTEGER, service TEXT, cache_has_attachments INTEGER,
           associated_message_type INTEGER, associated_message_guid TEXT, associated_message_emoji TEXT,
           balloon_bundle_id TEXT, is_audio_message INTEGER
           ${modern ? ", thread_originator_guid TEXT, date_edited INTEGER, date_retracted INTEGER" : ""})`);
  db.run(`CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)`);
  db.run(`CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER)`);
  db.run(`CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER)`);
  db.run(`CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, mime_type TEXT, transfer_name TEXT)`);
  db.run(`INSERT INTO handle VALUES (1, ?, 'iMessage'), (2, ?, 'iMessage')`, [ME, OTHER]);
  db.run(`INSERT INTO chat VALUES (1, 'iMessage;-;${ME}', ?, NULL, 45, 'iMessage'),
                                  (2, 'iMessage;-;${OTHER}', ?, NULL, 45, 'iMessage'),
                                  (3, 'iMessage;+;chat99', 'chat99', 'A group', 43, 'iMessage')`, [ME, OTHER]);
  const t = (s: number) => s * 1_000_000_000;      // Core Data nanoseconds
  const add = (rowid: number, chat: number, fromMe: number, handle: number, text: string, extra: any = {}) => {
    const cols = ["ROWID", "guid", "text", "date", "is_from_me", "handle_id", "service", "associated_message_type",
                  "associated_message_guid", ...(modern ? ["thread_originator_guid", "date_edited", "date_retracted"] : [])];
    const vals = [rowid, `G${rowid}`, text, t(800000000 + rowid), fromMe, handle, "iMessage", extra.type ?? 0,
                  extra.assoc ?? null, ...(modern ? [extra.reply ?? null, extra.edited ?? 0, extra.retracted ?? 0] : [])];
    db.run(`INSERT INTO message (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
    db.run(`INSERT INTO chat_message_join VALUES (?, ?)`, [chat, rowid]);
  };
  add(1, 1, 1, 1, "first, from me");
  add(2, 1, 0, 1, "a reply", { reply: "G1" });
  add(3, 2, 0, 2, "someone else entirely");
  add(4, 3, 0, 1, "in a group, same handle");
  add(5, 1, 0, 1, "", { type: 2000, assoc: "p:0/G1" });
  add(6, 1, 1, 1, "edited later", { edited: 1 });
  add(7, 1, 1, 1, "unsent", { retracted: 1 });
  db.close();
  return home;
}

function cli(home: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "index.ts"), ...args], { env: { HOME: home, PATH: "" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("read --json", () => {
  test("refuses without an exact handle, and prints nothing", () => {
    const home = synthetic();
    for (const args of [["read", "--json"], ["read", "--json", "--handle"], ["read", "--json", "--handle", "Some Name"],
                        ["read", "--json", "--handle", `${ME},${OTHER}`], ["read", "5", "--json"]]) {
      const r = cli(home, ...args);
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
    }
  });

  test("returns only that 1:1 chat, oldest first, with stable ids and the reply/tapback/edit/unsend fields", () => {
    const r = cli(synthetic(), "read", "--json", "--handle", ME);
    expect(r.code).toBe(0);
    const c = JSON.parse(r.out);
    expect(c.handle).toBe(ME);
    expect(c.chats).toEqual([{ guid: `iMessage;-;${ME}`, service: "iMessage" }]);
    expect(c.messages.map((m: any) => m.rowid)).toEqual([1, 2, 5, 6, 7]);      // not 3 (other chat) or 4 (group)
    const [first, reply, tap, edited, unsent] = c.messages;
    expect(first).toMatchObject({ guid: "G1", is_from_me: true, handle: null, text: "first, from me", service: "iMessage" });
    expect(reply).toMatchObject({ is_from_me: false, handle: ME, reply_to_guid: "G1" });
    expect(tap).toMatchObject({ associated_type: 2000, associated_guid: "p:0/G1" });
    expect(edited.edited).toBe(true);
    expect(unsent.retracted).toBe(true);
    expect(first.date).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  test("--after-rowid polls: only newer messages, oldest first", () => {
    const c = JSON.parse(cli(synthetic(), "read", "--json", "--handle", ME, "--after-rowid", "2").out);
    expect(c.messages.map((m: any) => m.rowid)).toEqual([5, 6, 7]);
  });

  test("--limit keeps the latest N, still oldest first; with a cursor, the first N after it", () => {
    const home = synthetic();
    expect(JSON.parse(cli(home, "read", "--json", "--handle", ME, "--limit", "2").out).messages.map((m: any) => m.rowid))
      .toEqual([6, 7]);
    expect(JSON.parse(cli(home, "read", "--json", "--handle", ME, "--after-rowid", "1", "--limit", "2").out)
      .messages.map((m: any) => m.rowid)).toEqual([2, 5]);
  });

  test("bad numbers are refused", () => {
    const home = synthetic();
    expect(cli(home, "read", "--json", "--handle", ME, "--limit", "x").code).toBe(2);
    expect(cli(home, "read", "--json", "--handle", ME, "--after-rowid").code).toBe(2);
  });

  test("an older schema without the reply/edit columns still reads, with nulls", () => {
    const c = JSON.parse(cli(synthetic({ modern: false }), "read", "--json", "--handle", ME).out);
    expect(c.messages[1]).toMatchObject({ rowid: 2, reply_to_guid: null, edited: false, retracted: false });
  });

  test("a handle with no 1:1 chat returns empty, and a group's identifier is refused", () => {
    const home = synthetic();
    const c = JSON.parse(cli(home, "read", "--json", "--handle", "+15550009999").out);
    expect(c).toEqual({ handle: "+15550009999", chats: [], messages: [] });
    const g = cli(home, "read", "--json", "--handle", "chat99");      // not a phone or email: never a group chat
    expect(g.code).toBe(2);
    expect(g.out).toBe("");
  });
});

describe("send --json", () => {
  test("refuses a contact name or a 1:many list, and sends nothing", () => {
    const home = synthetic();
    for (const to of ["Some Name", `${ME},${OTHER}`]) {
      const r = cli(home, "send", to, "hello", "--json");
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
    }
  });

  test("a failed send prints no ids", () => {
    const r = cli(synthetic(), "send", ME, "hello", "--json");     // no osascript on PATH
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('"sent"');
  });

  test("findOutgoing finds the new outgoing row above the cursor, by text, in that 1:1 chat only", () => {
    const home = synthetic();
    const script = `import { findOutgoing, maxMessageRowid } from ${JSON.stringify(join(import.meta.dir, "src/db.ts"))};
      console.log(JSON.stringify([maxMessageRowid(), findOutgoing([${JSON.stringify(ME)}], "edited later", 1),
        findOutgoing([${JSON.stringify(ME)}], "edited later", 6), findOutgoing([${JSON.stringify(ME)}], "a reply", 0),
        findOutgoing(["chat99"], "in a group, same handle", 0)]));`;
    const r = Bun.spawnSync([process.execPath, "-e", script], { env: { HOME: home, PATH: "" } });
    expect(JSON.parse(r.stdout.toString())).toEqual([7, { rowid: 6, guid: "G6" }, null, null, null]);
  });
});
