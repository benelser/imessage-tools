#!/usr/bin/env bun
/**
 * Build script: generates platform-specific plugin directories from skills-src/.
 *
 * Usage: bun run scripts/build.ts
 *
 * Outputs:
 *   skills/                    — universal skills (copied from skills-src/)
 *   .claude-plugin/plugin.json — Claude Code manifest
 *   .codex-plugin/plugin.json  — Codex CLI manifest
 *   .claude-plugin/marketplace.json — Claude Code marketplace
 *   .agents/plugins/marketplace.json — Codex marketplace
 */

import { cpSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const VERSION = JSON.parse(await Bun.file(join(ROOT, ".claude-plugin/plugin.json")).text()).version;

console.log(`Building imessage-tools v${VERSION}...\n`);

// 1. Copy skills-src/ → skills/ (universal, no platform-specific paths)
const skillsSrc = join(ROOT, "skills-src");
const skillsDst = join(ROOT, "skills");

if (existsSync(skillsSrc)) {
  // Clean and copy
  for (const skill of readdirSync(skillsSrc)) {
    const src = join(skillsSrc, skill);
    const dst = join(skillsDst, skill);
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
  }
  console.log(`  skills/ ← skills-src/ (${readdirSync(skillsSrc).length} skills)`);
}

// 2. Generate .codex-plugin/plugin.json
const codexManifest = {
  name: "imessage-tools",
  version: VERSION,
  description: "Read, search, and send iMessages directly from Codex CLI",
  author: { name: "belser" },
  homepage: "https://github.com/benelser/imessage-tools",
  license: "MIT",
  keywords: ["imessage", "messages", "sms", "macos"],
  skills: "./skills/",
  interface: {
    displayName: "iMessage Tools",
    shortDescription: "Read, search, and send iMessages",
    longDescription: "Full iMessage integration — inbox, conversation view, search with context, catchup, send (1:1, 1:many, group), and group creation.",
    developerName: "belser",
    category: "Productivity",
    capabilities: ["Read", "Write", "Interactive"],
    websiteURL: "https://github.com/benelser/imessage-tools",
    brandColor: "#34C759",
    defaultPrompt: [
      "Check my recent messages",
      "What did I miss?",
      "Send a message to..."
    ]
  }
};

mkdirSync(join(ROOT, ".codex-plugin"), { recursive: true });
writeFileSync(
  join(ROOT, ".codex-plugin/plugin.json"),
  JSON.stringify(codexManifest, null, 2) + "\n"
);
console.log("  .codex-plugin/plugin.json");

// 3. Generate .agents/plugins/marketplace.json (Codex marketplace)
const codexMarketplace = {
  name: "imessage-tools",
  interface: {
    displayName: "iMessage Tools"
  },
  plugins: [
    {
      name: "imessage-tools",
      source: {
        source: "local",
        path: "./plugins/imessage-tools"
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL"
      },
      category: "Productivity"
    }
  ]
};

mkdirSync(join(ROOT, ".agents/plugins"), { recursive: true });
writeFileSync(
  join(ROOT, ".agents/plugins/marketplace.json"),
  JSON.stringify(codexMarketplace, null, 2) + "\n"
);
console.log("  .agents/plugins/marketplace.json");

console.log("\nBuild complete.");
