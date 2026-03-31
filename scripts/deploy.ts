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

  const marketplacePath = join(process.env.HOME!, ".agents/plugins/marketplace.json");
  const marketplacePluginsDir = join(process.env.HOME!, ".agents/plugins/plugins/imessage-tools");
  const cacheDir = join(process.env.HOME!, ".codex/plugins/cache/personal/imessage-tools/local");
  const configPath = join(process.env.HOME!, ".codex/config.toml");

  // Files to exclude from plugin copies
  const exclude = (src: string) =>
    !src.includes("node_modules") &&
    !src.includes("/.git/") &&
    !src.includes("/.git") &&
    !src.includes("/.claude/") &&
    !src.includes("/.claude-plugin") &&
    !src.includes("/.agents") &&
    !src.includes("/.cursor") &&
    !src.includes("/hooks/") &&
    !src.includes("/scripts/") &&
    !src.includes("/CLAUDE.md");

  // 1. Populate marketplace source dir (for discovery in /plugins UI)
  console.log("  Setting up marketplace source...");
  await run(["rm", "-rf", marketplacePluginsDir], "clean source");
  mkdirSync(marketplacePluginsDir, { recursive: true });
  cpSync(ROOT, marketplacePluginsDir, { recursive: true, filter: exclude });
  // Ensure only .codex-plugin exists (not .claude-plugin)
  await run(["rm", "-rf", join(marketplacePluginsDir, ".claude-plugin")], "remove claude manifest");
  console.log(`  Source → ${marketplacePluginsDir}`);

  // 2. Populate Codex cache (this is what actually loads at runtime)
  console.log("  Populating plugin cache...");
  await run(["rm", "-rf", cacheDir], "clean cache");
  mkdirSync(cacheDir, { recursive: true });
  cpSync(marketplacePluginsDir, cacheDir, { recursive: true });
  console.log(`  Cache → ${cacheDir}`);

  // 3. Create/update personal marketplace
  mkdirSync(join(process.env.HOME!, ".agents/plugins"), { recursive: true });

  let marketplace: any = { name: "personal", interface: { displayName: "Personal Plugins" }, plugins: [] };
  if (existsSync(marketplacePath)) {
    try {
      marketplace = JSON.parse(readFileSync(marketplacePath, "utf-8"));
    } catch {}
  }

  const existing = marketplace.plugins.findIndex((p: any) => p.name === "imessage-tools");
  const entry = {
    name: "imessage-tools",
    source: { source: "local", path: "./plugins/imessage-tools" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity"
  };
  if (existing >= 0) {
    marketplace.plugins[existing] = entry;
  } else {
    marketplace.plugins.push(entry);
  }
  writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n");
  console.log(`  Marketplace → ${marketplacePath}`);

  // 4. Enable plugin in config.toml
  const configContent = readFileSync(configPath, "utf-8");
  if (!configContent.includes('"imessage-tools@personal"')) {
    writeFileSync(configPath, configContent + '\n[plugins."imessage-tools@personal"]\nenabled = true\n');
    console.log("  Enabled in config.toml");
  } else {
    console.log("  Already enabled in config.toml");
  }

  console.log("  Restart Codex to load the plugin.");
}

// Run
if (platform === "link" || platform === "all") await deployLink();
if (platform === "claude" || platform === "all") await deployClaude();
if (platform === "codex" || platform === "all") await deployCodex();

console.log("\nDone.");
