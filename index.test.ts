import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Runs the CLI with HOME pointed at an empty temp dir (no ~/Library/Messages/chat.db to read) and an empty PATH
// (osascript can't be found), so even a regression here can't read real messages or send one.
function run(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "imt-help-"));
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
    env: { HOME: home, PATH: "" },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("--help never reads or sends", () => {
  const cases = [
    ["read", "--help"], ["read", "5", "--help"], ["read", "--group", "--help"], ["inbox", "--help"],
    ["search", "--help"], ["catchup", "--help"], ["contacts", "--help"], ["send", "--help"],
    ["send", "Someone", "--help"], ["send", "--group", "--help"], ["create-group", "--help"],
    ["read", "-h"], ["--help"], ["-h"], ["help"],
  ];
  for (const args of cases) {
    test(args.join(" "), () => {
      const r = run(...args);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Usage:");
      expect(r.err).toBe("");
    });
  }
});
