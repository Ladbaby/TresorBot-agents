/**
 * Locates the `@anthropic-ai/claude-agent-sdk` package without requiring the
 * operator to name it.
 *
 * The adapter needs the SDK package, not the `claude` command: the command on
 * PATH is usually a launcher or a native binary, and the JS API lives in the SDK
 * package somewhere else. Discovery walks the places Claude Code and the SDK are
 * actually installed rather than making a user translate an error message.
 *
 * Structurally this mirrors `pi-resolve.mjs`, because the two problems are the
 * same shape and an operator who understands one should understand the other.
 * Only candidate gathering and validation live here; nothing is imported, so the
 * module stays cheap to load and easy to test.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const CLAUDE_SDK_PKG = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_CODE_PKG = "@anthropic-ai/claude-code";

/** True when `dir` is a complete claude-agent-sdk package directory. */
export function looksLikeClaudeSdkDir(dir) {
  if (typeof dir !== "string" || dir.length === 0) return false;
  try {
    return existsSync(join(dir, "sdk.mjs")) && existsSync(join(dir, "package.json"));
  } catch {
    return false;
  }
}

const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

/**
 * True for a Windows launcher shim. The SDK resolves executables itself and
 * cannot spawn these, so the adapter must translate one into the real entry
 * point instead of passing it through. Matches t3code's ClaudeExecutable.ts.
 */
export function isWindowsLauncherShim(filePath) {
  if (typeof filePath !== "string") return false;
  const lower = filePath.toLowerCase();
  for (const ext of WINDOWS_SHIM_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Reads a package root from a path by locating the nearest package.json whose
 * `name` matches. Accepts a file or a directory, so an explicit setting can name
 * the CLI, the package directory, or any file inside the package.
 */
export function packageRootFrom(fromPath, packageName) {
  if (typeof fromPath !== "string" || fromPath.length === 0) return null;
  let current;
  try {
    current = existsSync(fromPath) ? realpathSync(fromPath) : resolve(fromPath);
  } catch {
    return null;
  }
  // A file resolves from its directory; a directory starts at itself.
  let dir = existsSync(join(current, "package.json")) ? current : dirname(current);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8"));
        if (parsed.name === packageName) return dir;
      } catch {
        // A malformed package.json is not our package; keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Nearest `node_modules/<pkg>` walking up from `fromDir`. */
function walkUpForPkgDir(fromDir, packageName, validate) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", packageName);
    if (validate(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** `npm root -g`, or null when npm is absent or slow. */
export function npmGlobalRoot() {
  try {
    const root = execSync("npm root -g", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
    return root || null;
  } catch {
    return null;
  }
}

export function bunGlobalRoots(env) {
  const roots = [];
  if (env.BUN_INSTALL) roots.push(join(env.BUN_INSTALL, "install", "global", "node_modules"));
  roots.push(join(env.HOME ?? homedir(), ".bun", "install", "global", "node_modules"));
  return roots;
}

/**
 * Locates the `claude` executable, which the SDK spawns as a child process.
 *
 * The SDK can also ship its own bundled binary, so this is a preference rather
 * than a requirement: when nothing is found the SDK's default resolution is used.
 */
export function claudeExecutableCandidates({ env = process.env } = {}) {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const dirs = [];
  const add = (p) => {
    if (typeof p === "string" && p.length > 0 && !dirs.includes(p)) dirs.push(p);
  };

  // 1. An explicit override always wins.
  add(env.TRESORBOT_CLAUDE_CLI);

  // 2. Claude Code's own install location: the native installer puts the binary
  //    under ~/.local/bin, and the npm package exposes bin/claude.exe.
  add(join(home, ".local", "bin", "claude"));
  add(join(home, ".claude", "local", "claude"));

  // 3. Inside an npm/bun global install of the package.
  for (const root of [npmGlobalRoot(), ...bunGlobalRoots(env)].filter(Boolean)) {
    add(join(root, CLAUDE_CODE_PKG, "bin", "claude.exe"));
    add(join(root, CLAUDE_CODE_PKG, "cli.js"));
  }
  return dirs;
}

/** Resolves the executable to hand the SDK, or null to use the SDK default. */
export function resolveClaudeExecutable({ env = process.env, hint } = {}) {
  const explicit = hint || env.TRESORBOT_CLAUDE_CLI;
  if (explicit && existsSync(explicit) && !isWindowsLauncherShim(explicit)) {
    return { path: explicit, source: "configured" };
  }
  for (const candidate of claudeExecutableCandidates({ env })) {
    if (existsSync(candidate) && !isWindowsLauncherShim(candidate)) {
      return { path: candidate, source: "discovered" };
    }
  }
  return { path: null, source: null };
}

/**
 * Ordered candidate directories for the SDK package, unvalidated. Callers filter
 * with {@link looksLikeClaudeSdkDir}.
 *
 * `selfDir` is where a project-local search starts; it defaults to this module's
 * directory so a dev checkout resolves its own copy first.
 */
export function candidateClaudeSdkDirs({ env = process.env, selfDir, includeNpmGlobal = true } = {}) {
  const startDir = selfDir ?? dirname(new URL(import.meta.url).pathname);
  const home = env.HOME ?? env.USERPROFILE ?? homedir();

  const dirs = [];
  const add = (dir) => {
    if (typeof dir === "string" && dir.length > 0 && !dirs.includes(dir)) dirs.push(dir);
  };

  // 1. An explicit override always wins.
  add(env.TRESORBOT_CLAUDE_DIR);

  // 2. A project-local install (adapter's own node_modules, or a dev checkout).
  add(walkUpForPkgDir(startDir, CLAUDE_SDK_PKG, looksLikeClaudeSdkDir));

  // 3. Bun global roots, where this machine installs the SDK.
  for (const root of bunGlobalRoots(env)) add(join(root, CLAUDE_SDK_PKG));

  // 4. Global npm root.
  if (includeNpmGlobal) add(join(npmGlobalRoot() ?? "", CLAUDE_SDK_PKG));

  // 5. Other layouts seen in the wild.
  add(join(home, ".claude", "node_modules", CLAUDE_SDK_PKG));
  add(join(home, ".local", "lib", "node_modules", CLAUDE_SDK_PKG));

  return dirs;
}

/**
 * Resolves the SDK package directory.
 *
 * `hint` is whatever the operator configured, if anything. It is tried first so
 * an explicit setting beats discovery, and accepts a package directory or any
 * file inside it.
 *
 * Returns `{ dir, source }` so a diagnostic can say how the SDK was found, or
 * `{ dir: null }` when nothing matched.
 */
export function resolveClaudeSdkDir({ env = process.env, selfDir, hint, includeNpmGlobal = true } = {}) {
  if (hint) {
    const fromHint = packageRootFrom(hint, CLAUDE_SDK_PKG);
    if (fromHint) return { dir: fromHint, source: "configured" };
  }
  for (const dir of candidateClaudeSdkDirs({ env, selfDir, includeNpmGlobal })) {
    if (looksLikeClaudeSdkDir(dir)) return { dir, source: "discovered" };
  }
  return { dir: null, source: null };
}

/**
 * Reports whether a path looks like the Claude Code CLI rather than the SDK.
 *
 * Operators naturally paste the path to `claude`, so naming that explicitly in
 * the error is friendlier than a generic "not found".
 */
export function describesClaudeCli(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  return basename(filePath).toLowerCase().startsWith("claude");
}
