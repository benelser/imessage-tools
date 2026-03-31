#!/usr/bin/env bun
/**
 * Deploy script: installs the plugin for Claude Code, Codex, or both.
 *
 * Usage:
 *   bun run scripts/deploy.ts claude   — reinstall for Claude Code
 *   bun run scripts/deploy.ts codex    — install for Codex CLI
 *   bun run scripts/deploy.ts all      — both platforms
 *   bun run scripts/deploy.ts link     — just bun link (global CLI)
 */

import { cpSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const platform = process.argv[2];

if (!platform || !["claude", "codex", "all", "link"].includes(platform)) {
  console.log(`Usage: bun run scripts/deploy.ts <claude|codex|all|link>`);
  process.exit(1);
}

async function run(cmd: string[], label: string): Promise<boolean> {
  console.log(`  $ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (stdout.trim()) console.log(`    ${stdout.trim()}`);
  if (code !== 0 && stderr.trim()) console.log(`    ${stderr.trim()}`);
  return code === 0;
}

async function deployLink() {
  console.log("\n--- bun link (global CLI) ---");
  await run(["bun", "link"], "bun link");
  // Verify
  const ok = await run(["imessage-tools", "inbox", "1"], "verify");
  console.log(ok ? "  Global CLI: OK" : "  Global CLI: FAILED");
}

async function deployClaude() {
  console.log("\n--- Claude Code ---");
  await run(["claude", "plugin", "uninstall", "imessage-tools@imessage-tools"], "uninstall");
  await run(["claude", "plugin", "marketplace", "remove", "imessage-tools"], "remove marketplace");

  // Clean cache
  const cacheDir = join(process.env.HOME!, ".claude/plugins/cache/imessage-tools");
  const mktDir = join(process.env.HOME!, ".claude/plugins/marketplaces/imessage-tools");
  if (existsSync(cacheDir)) {
    await run(["rm", "-rf", cacheDir], "clean cache");
  }
  if (existsSync(mktDir)) {
    await run(["rm", "-rf", mktDir], "clean marketplace");
  }

  await run(["claude", "plugin", "marketplace", "add", "benelser/imessage-tools"], "add marketplace");
  await run(["claude", "plugin", "install", "imessage-tools@imessage-tools"], "install");
  console.log("  Run /reload-plugins in your Claude Code session.");
}

async function deployCodex() {
  console.log("\n--- Codex CLI ---");

  const pluginDir = join(process.env.HOME!, ".codex/plugins/imessage-tools");
  const marketplacePath = join(process.env.HOME!, ".agents/plugins/marketplace.json");

  // Copy plugin files
  mkdirSync(pluginDir, { recursive: true });
  cpSync(ROOT, pluginDir, {
    recursive: true,
    filter: (src) => {
      // Skip node_modules, .git, .claude dir
      return !src.includes("node_modules") && !src.includes("/.git/") && !src.includes("/.git") && !src.includes("/.claude/");
    }
  });
  console.log(`  Copied plugin → ${pluginDir}`);

  // Install deps in plugin dir
  await run(["bun", "install", "--cwd", pluginDir], "bun install");

  // Create/update personal marketplace
  mkdirSync(join(process.env.HOME!, ".agents/plugins"), { recursive: true });

  let marketplace: any = { name: "personal", interface: { displayName: "Personal Plugins" }, plugins: [] };
  if (existsSync(marketplacePath)) {
    try {
      marketplace = JSON.parse(readFileSync(marketplacePath, "utf-8"));
    } catch {}
  }

  // Upsert our plugin entry
  const existing = marketplace.plugins.findIndex((p: any) => p.name === "imessage-tools");
  const entry = {
    name: "imessage-tools",
    source: { source: "local", path: pluginDir },
    policy: { installation: "AVAILABLE" },
    category: "Productivity"
  };
  if (existing >= 0) {
    marketplace.plugins[existing] = entry;
  } else {
    marketplace.plugins.push(entry);
  }

  writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n");
  console.log(`  Updated ${marketplacePath}`);
  console.log("  Restart Codex and enable via /plugins.");
}

// Run
if (platform === "link" || platform === "all") await deployLink();
if (platform === "claude" || platform === "all") await deployClaude();
if (platform === "codex" || platform === "all") await deployCodex();

console.log("\nDone.");
