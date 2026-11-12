/**
 * Locates the `@earendil-works/pi-coding-agent` package without requiring the
 * operator to name it.
 *
 * The adapter needs pi's JavaScript package directory, not the `pi` command: the
 * command on PATH is usually a launcher shell script, and the package lives
 * somewhere else entirely. Asking a user to work that out from an error message
 * is the wrong trade, so this walks the well-known locations pi is installed to.
 *
 * Modelled on picc-claude-shim's `bin/pi-resolve.mjs`, which solves the same
 * problem for the same package. Walking a list of known roots is more robust than
 * any single assumption: pi can live in a managed release directory, a global npm
 * root, a bun global root, or a project checkout.
 *
 * Only candidate gathering and validation live here; nothing is imported, so this
 * module stays cheap to load and easy to test.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const PI_PKG = "@earendil-works/pi-coding-agent";
const PI_MAIN_REL = join("dist", "index.js");

/** True when `dir` is a complete pi-coding-agent package directory. */
export function looksLikePiPkgDir(dir) {
  if (typeof dir !== "string" || dir.length === 0) return false;
  try {
    return existsSync(join(dir, PI_MAIN_REL)) && existsSync(join(dir, "package.json"));
  } catch {
    return false;
  }
}

/**
 * Reads pi's package root from a package.json `name`, walking up from `fromPath`.
 *
 * Accepts either a file or a directory, so an explicit setting can name the CLI,
 * the package directory, or any file inside the package.
 */
export function packageRootFrom(fromPath) {
  if (typeof fromPath !== "string" || fromPath.length === 0) return null;
  let current;
  try {
    current = existsSync(fromPath) ? realpathSync(fromPath) : resolve(fromPath);
  } catch {
    return null;
  }
  // A file resolves from its directory; a directory starts at itself.
  if (existsSync(join(current, "package.json"))) return looksLikePiPkgDir(current) ? current : null;
  let dir = current;
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8"));
        if (parsed.name === PI_PKG) return dir;
      } catch {
        // A malformed package.json is not our package; keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Nearest `node_modules/<PI_PKG>` walking up from `fromDir`. */
function walkUpForPiPkgDir(fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", PI_PKG);
    if (looksLikePiPkgDir(candidate)) return candidate;
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

function bunGlobalRoots(env) {
  const roots = [];
  if (env.BUN_INSTALL) roots.push(join(env.BUN_INSTALL, "install", "global", "node_modules"));
  roots.push(join(env.HOME ?? homedir(), ".bun", "install", "global", "node_modules"));
  return roots;
}

/**
 * pi's managed installer keeps the runtime in a versioned release directory:
 *
 *   <agentDir>/install/current-version
 *   <agentDir>/install/releases/<version>/node_modules/<PI_PKG>
 *
 * The indirection exists so updates switch releases atomically, so the version is
 * read rather than guessed. An explicit release path would break on the next pi
 * update, which is exactly what this avoids.
 */
export function managedPiPkgDir(agentDir) {
  try {
    const installDir = join(agentDir, "install");
    const version = readFileSync(join(installDir, "current-version"), "utf8").trim();
    if (!/^[0-9A-Za-z._+-]+$/.test(version)) return null;
    return join(installDir, "releases", version, "node_modules", PI_PKG);
  } catch {
    return null;
  }
}

/**
 * Ordered candidate directories, unvalidated. Callers filter with
 * {@link looksLikePiPkgDir}.
 *
 * `selfDir` is where the search starts for a project-local install; it defaults to
 * this module's directory so a dev checkout resolves its own copy first.
 */
export function candidatePiPkgDirs({ env = process.env, selfDir, includeNpmGlobal = true } = {}) {
  const startDir = selfDir ?? dirname(new URL(import.meta.url).pathname);
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");

  const dirs = [];
  const add = (dir) => {
    if (typeof dir === "string" && dir.length > 0 && !dirs.includes(dir)) dirs.push(dir);
  };

  // 1. An explicit override always wins.
  add(env.TRESORBOT_PI_DIR);

  // 2. A project-local install (dev checkout, or a bundled dependency).
  add(walkUpForPiPkgDir(startDir));

  // 3. Bun global roots, where bun-compiled runners commonly install.
  for (const root of bunGlobalRoots(env)) add(join(root, PI_PKG));

  // 4. Global npm root.
  if (includeNpmGlobal) add(join(npmGlobalRoot() ?? "", PI_PKG));

  // 5. pi's managed runtime and other manual layouts.
  add(managedPiPkgDir(agentDir));
  add(join(agentDir, "npm", "node_modules", PI_PKG));
  add(join(agentDir, "node_modules", PI_PKG));
  add(join(home, ".pi", "node_modules", PI_PKG));

  return dirs;
}

/**
 * Resolves pi's package directory.
 *
 * `hint` is whatever the operator configured, if anything. It is tried first so
 * an explicit setting always beats discovery, and it accepts a launcher path, a
 * CLI path, or the package directory itself.
 *
 * Returns `{ dir, source }` so a diagnostic can say how pi was found, or
 * `{ dir: null }` when nothing matched.
 */
export function resolvePiPkgDir({ env = process.env, selfDir, hint, includeNpmGlobal = true } = {}) {
  if (hint) {
    const fromHint = packageRootFrom(hint);
    if (fromHint) return { dir: fromHint, source: "configured" };
    // A launcher script names the real install in its own text; read it rather
    // than making the operator translate a wrapper into a package path.
    const viaLauncher = packageRootFromLauncher(hint);
    if (viaLauncher) return { dir: viaLauncher, source: "configured launcher" };
  }
  for (const dir of candidatePiPkgDirs({ env, selfDir, includeNpmGlobal })) {
    if (looksLikePiPkgDir(dir)) {
      return { dir, source: "discovered" };
    }
  }
  return { dir: null, source: null };
}

/**
 * Resolves pi from a launcher script.
 *
 * The `pi` on PATH is a shell script that reads `install/current-version` and
 * execs the release. Following that indirection means a path the user naturally
 * knows keeps working across pi updates, instead of a version-pinned package path
 * that breaks on the next release.
 */
export function packageRootFromLauncher(launcherPath) {
  let text;
  try {
    let real = launcherPath;
    if (existsSync(real)) real = realpathSync(real);
    text = readFileSync(real, "utf8");
  } catch {
    return null;
  }
  // Not a launcher: a binary or a JS file. packageRootFrom already handled those.
  if (!text.startsWith("#!")) return null;
  // Derive the agent dir the launcher would compute: it lives in <agent>/bin.
  const agentDir = dirname(dirname(realpathSync(launcherPath)));
  const managed = managedPiPkgDir(agentDir);
  if (managed && looksLikePiPkgDir(managed)) return managed;
  // Fall back to any package path the script mentions literally.
  for (const match of text.matchAll(/[\w./@-]*pi-coding-agent[\w./-]*/g)) {
    const candidate = packageRootFrom(match[0]);
    if (candidate) return candidate;
  }
  return null;
}
