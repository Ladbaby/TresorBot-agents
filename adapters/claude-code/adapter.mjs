// Claude Code adapter.
//
// Drives Claude Code through the Claude Agent SDK, the same integration t3code
// uses. The important structural difference from the pi adapter: the SDK spawns
// a Claude Code child process per session and cannot multiplex in-process, so
// this adapter is capped by its manifest's `limits.max_sessions` rather than the
// host ceiling. Measured cost is ~131 MB private per session.
//
// Permission strategy: follow Claude Code's own `defaultMode` from the
// operator's settings, because that is the configuration they chose and expect.
// When it is unset the adapter falls back to a mode that can actually run
// headlessly. Measured on this machine (as root), with no human to answer
// prompts:
//
//   auto              writes files AND runs shell   <- usable
//   acceptEdits       writes files, no shell        <- usable
//   dontAsk           shell only, no writes         <- usable
//   default, plan     spin until max-turns          <- unusable headlessly
//   bypassPermissions exits immediately (root ban)  <- unusable as root
//
// So `bypassPermissions` cannot be a fallback when Earth runs as root; `auto`
// is what actually delivers the behaviour people want from it here.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CLAUDE_SDK_PKG, resolveClaudeExecutable, resolveClaudeSdkDir } from "./resolve.mjs";

/** Modes that cannot run unattended: they wait for a human, or refuse as root. */
const UNATTENDED_UNSAFE = new Set(["default", "plan", "bypassPermissions"]);

/** Order of preference when Claude Code's own defaultMode is unset or unusable. */
const FALLBACK_MODES = ["auto", "acceptEdits", "dontAsk"];

/** Structural failure the host reports as a typed protocol reason. */
class AdapterError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "AdapterError";
    this.reason = reason;
  }
}

/** Loads the SDK once per host, not once per session. */
let sdkPromise = null;
let lastResolution = null;

async function loadSdk(settings) {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const hint = settings.cli_path || "";
      const { dir, source } = resolveClaudeSdkDir({ hint });
      if (dir) {
        const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
        const entry = resolve(dir, manifest.main ?? "sdk.mjs");
        lastResolution = { dir, source };
        return import(pathToFileURLString(entry));
      }
      // A copy installed beside the adapter is the last resort; the install
      // command puts one there when npm was available.
      try {
        lastResolution = { dir: null, source: "package resolution" };
        return await import(CLAUDE_SDK_PKG);
      } catch {
        throw new AdapterError(
          "claude_unavailable",
          `could not find ${CLAUDE_SDK_PKG}. Install it, or set "cli_path" in config.json to the claude command or its package directory.`,
        );
      }
    })();
  }
  return sdkPromise;
}

function pathToFileURLString(path) {
  const url = new URL("file://");
  url.pathname = path.split("\\").join("/");
  return url.href;
}

/**
 * Reads the operator's own `permissions.defaultMode` from Claude's settings.
 *
 * Read directly rather than inferred from a turn, so the adapter can report why
 * it chose a mode. Failure is not fatal: an unreadable settings file just means
 * "unset", and the fallback chain applies.
 */
async function configuredPermissionMode(env) {
  const home = env.HOME || env.USERPROFILE || "";
  const configDir = env.CLAUDE_CONFIG_DIR || (home ? join(home, ".claude") : "");
  if (!configDir) return null;
  try {
    const raw = await readFile(join(configDir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    const mode = settings?.permissions?.defaultMode;
    return typeof mode === "string" && mode.length > 0 ? mode : null;
  } catch {
    return null;
  }
}

/**
 * Decides the permission mode and explains the choice.
 *
 * An explicit setting always wins: the operator asked for it. Otherwise the
 * operator's own Claude configuration is honoured, and only when that is absent
 * or cannot run unattended does the fallback chain apply.
 */
async function choosePermissionMode({ explicit, env }) {
  if (explicit) return { mode: explicit, reason: "configured by adapter setting" };

  const configured = await configuredPermissionMode(env);
  if (configured && !UNATTENDED_UNSAFE.has(configured)) {
    return { mode: configured, reason: "from Claude Code settings" };
  }
  if (configured) {
    // Chosen deliberately by the operator, but it cannot work with nobody to
    // approve tool calls, so say so instead of silently hanging.
    const fallback = FALLBACK_MODES[0];
    return {
      mode: fallback,
      reason: `Claude settings use "${configured}", which cannot run unattended; using "${fallback}"`,
    };
  }
  return { mode: FALLBACK_MODES[0], reason: `Claude settings set no permissionMode; using "${FALLBACK_MODES[0]}"` };
}

/** Maps Claude's usage onto the canonical shape Earth understands. */
function toCanonicalUsage(usage, modelUsage) {
  if (!usage || typeof usage !== "object") return null;
  const num = (value) => (typeof value === "number" && value >= 0 ? value : 0);

  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  // Claude reports uncached input separately; the canonical "input" is the whole
  // prompt, so the cached portions are added back in.
  const input = num(usage.input_tokens) + cacheWrite + cacheRead;
  const output = num(usage.output_tokens);
  const total = input + output;

  const models = {};
  for (const [name, entry] of Object.entries(modelUsage ?? {})) {
    const mIn = num(entry?.inputTokens) + num(entry?.cacheCreationInputTokens) + num(entry?.cacheReadInputTokens);
    const mOut = num(entry?.outputTokens);
    models[`${entry?.provider ?? ""}/${name}`] = {
      provider: entry?.provider ?? "",
      model: name,
      input: mIn,
      output: mOut,
      cache_read: num(entry?.cacheReadInputTokens),
      cache_write: num(entry?.cacheCreationInputTokens),
      total: mIn + mOut,
    };
  }
  if (Object.keys(models).length === 0) {
    models[`/${""}`] = {
      provider: "",
      model: "",
      input,
      output,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      total,
    };
  }

  return { input, output, cache_read: cacheRead, cache_write: cacheWrite, total, models };
}

/**
 * Renders a Sun tool payload as plain text, matching the convention the pi
 * adapter and the old embedded extension both use.
 */
function toolResultText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    if (typeof result.text === "string" && result.text) return result.text;
    if (result.error && typeof result.error === "object") {
      const code = result.error.code || "";
      const message = result.error.message || code;
      return code && message && code !== message ? `${code}: ${message}` : message;
    }
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

/**
 * Exposes Earth's tool gateway to Claude as an HTTP MCP server.
 *
 * HTTP rather than an in-process server because the tools are defined by Sun at
 * runtime: an in-process server would need their JSON schemas converted to zod
 * at session start, and the HTTP form keeps the runner credential inside Earth
 * exactly as it is for pi.
 */
function buildHostTools({ sdk, toolUrl, toolToken, assignmentId, crypto }) {
  if (!toolUrl || !toolToken) return { servers: undefined, discover: async () => [] };

  // The gateway is path-scoped per assignment; the MCP endpoint is the same
  // loopback listener the pi adapter posts to.
  const servers = {
    tresor: {
      type: "http",
      url: toolUrl,
      headers: { Authorization: `Bearer ${toolToken}` },
      alwaysLoad: true,
    },
  };

  async function call(path, body) {
    const response = await fetch(toolUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${toolToken}` },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.code || "Bot tool unavailable");
    return payload;
  }

  return {
    servers,
    /** Reports the tool names Sun offers, so a diagnostic can name them. */
    async discover() {
      try {
        const definitions = await call("/definitions", {});
        return (definitions.tools ?? []).map((tool) => tool.name);
      } catch {
        return [];
      }
    },
  };
}

/**
 * Maps Claude's result frame onto the canonical stop reason.
 *
 * `subtype: "success"` is not sufficient: the SDK reports some API failures that
 * way with `is_error` set, and an aborted turn still arrives as a result.
 */
function normaliseStop(result) {
  if (!result) return "error";
  const reason = String(result.terminal_reason ?? "");
  if (reason === "aborted_streaming" || reason === "aborted_tools") return "aborted";
  switch (reason) {
    case "budget_exhausted":
    case "prompt_too_long":
    case "blocking_limit":
    case "rapid_refill_breaker":
      return "max_turns";
    case "api_error":
      return "usage_limit";
    default:
      break;
  }
  if (result.subtype === "error_max_turns") return "max_turns";
  if (result.subtype !== "success") return "error";
  if (result.api_error_status === 429 || result.api_error_status === 529) return "usage_limit";
  if (result.is_error) return "error";
  return "stop";
}

/** Extracts text blocks from an assistant message. */
function assistantTextOf(message) {
  if (!Array.isArray(message?.message?.content)) return "";
  return message.message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/** Text of every assistant message seen this turn, for verification. */
function joinAssistantText(parts) {
  return parts.filter(Boolean).join("");
}

/**
 * Reads the resume handle. A missing or unreadable pointer means "start fresh":
 * treating it as fatal is what wedged conversations in the pi adapter before
 * that bug was fixed.
 */
async function readPointer(stateDir, conversationId) {
  try {
    const raw = await readFile(join(stateDir, "session.json"), "utf8");
    const pointer = JSON.parse(raw);
    if (pointer?.conversationID !== conversationId) return null;
    if (typeof pointer.sessionID !== "string" || pointer.sessionID.length === 0) return null;
    return pointer.sessionID;
  } catch {
    return null;
  }
}

/**
 * Commits the resume handle. Called only after a turn has run, so the pointer
 * can never name a session that does not exist.
 */
async function commitPointer(stateDir, conversationId, sessionID) {
  const pointerPath = join(stateDir, "session.json");
  const temp = `${pointerPath}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ conversationID: conversationId, sessionID }), { mode: 0o600 });
  await rename(temp, pointerPath);
}

async function createClaudeSession(ctx) {
  const settings = ctx.settings ?? {};
  const workspace = ctx.workspace;
  const stateDir = ctx.state_dir;
  const conversationId = ctx.conversation_id;
  const instructions = ctx.instructions ?? "";
  const history = ctx.history ?? [];
  const emit = ctx.emit ?? (() => {});
  const log = ctx.log ?? (() => {});

  const sdk = await loadSdk(settings);
  const crypto = await import("node:crypto");
  await mkdir(join(stateDir), { recursive: true });

  const chosen = await choosePermissionMode({
    explicit: settings.permission_mode,
    env: process.env,
  });
  const executable = resolveClaudeExecutable({ hint: settings.cli_path || "" });
  const hostTools = buildHostTools({
    sdk,
    toolUrl: ctx.tool_url,
    toolToken: ctx.tool_token,
    assignmentId: ctx.assignment_id,
    crypto,
  });
  const toolNames = await hostTools.discover();

  const diagnostics = [];
  if (lastResolution?.dir) diagnostics.push(`claude sdk: ${lastResolution.dir} (${lastResolution.source})`);
  else if (lastResolution?.source) diagnostics.push(`claude sdk: ${lastResolution.source}`);
  if (executable.path) diagnostics.push(`claude cli: ${executable.path} (${executable.source})`);
  diagnostics.push(`permission mode: ${chosen.mode} (${chosen.reason})`);
  if (toolNames.length > 0) diagnostics.push(`host tools: ${toolNames.join(", ")}`);

  // Resume only when a previous turn actually completed; otherwise a fresh
  // session carries the imported history instead.
  let resumeSessionId = await readPointer(stateDir, conversationId);
  // A fresh conversation has no session id yet, but Earth records one as process
  // evidence before the turn starts. Minting it here means open() can report a
  // real reference immediately; the SDK only accepts a UUID for this.
  const assignedSessionId = resumeSessionId ?? crypto.randomUUID();
  if (!resumeSessionId && history.length > 0) {
    diagnostics.push(`imported ${history.length} history message(s)`);
  }

  // A resumable turn needs the whole conversation; the first turn of a new
  // session gets it as a single prompt so the model sees prior context.
  const promptForTurn = (text) => {
    const parts = [];
    if (instructions && instructions.trim()) parts.push(instructions.trim());
    if (!resumeSessionId) {
      for (const item of history) {
        const role = item.role === "assistant" ? "Assistant" : "User";
        if (item.content) parts.push(`${role}: ${item.content}`);
      }
    }
    parts.push(text);
    return parts.join("\n\n");
  };

  let queryRuntime = null;
  let settled = null;
  let settleResolve = null;
  let settledFlag = false;
  let aborted = false;
  let closed = false;
  let lastResult = null;
  let errorMessage = "";
  let assistantParts = [];
  let usage = null;
  let sessionRef = assignedSessionId;
  let model = settings.model ?? "";
  let toolCalls = new Map();

  /** Resolves the settled promise exactly once, whichever signal arrives first. */
  function settle() {
    if (!settled) {
      settled = new Promise((res) => {
        settleResolve = res;
      });
    }
    return settled;
  }

  function finish(outcome) {
    if (settledFlag) return;
    settledFlag = true;
    settleResolve?.(outcome);
  }

  /**
   * Runs one turn: builds a query(), consumes its stream, and reports the
   * outcome through settle(). The query is single-use, so a fresh one is created
   * per turn; the session id carries continuity across them.
   */
  async function runTurn(text) {
    assistantParts = [];
    toolCalls = new Map();
    lastResult = null;
    errorMessage = "";

    const abortController = new AbortController();
    const options = {
      cwd: workspace,
      permissionMode: chosen.mode,
      maxTurns: settings.max_turns ?? undefined,
      abortController,
      // inherit the operator's Claude settings deliberately: their MCP servers,
      // allowlists and hooks are part of the environment they configured.
      ...(settings.model ? { model: settings.model } : {}),
      ...(executable.path ? { pathToClaudeCodeExecutable: executable.path } : {}),
      ...(hostTools.servers ? { mcpServers: hostTools.servers } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : { sessionId: assignedSessionId }),
      stderr: (data) => log("warn", `claude: ${String(data).trim().slice(0, 500)}`),
    };

    emit({ type: "turn.started" });
    try {
      queryRuntime = sdk.query({ prompt: promptForTurn(text), options });
    } catch (cause) {
      errorMessage = cause?.message ?? String(cause);
      finish();
      return;
    }

    try {
      for await (const message of queryRuntime) {
        switch (message.type) {
          case "system":
            if (message.subtype === "init") {
              sessionRef = message.session_id ?? sessionRef;
              model = message.model ?? model;
              const tools = Array.isArray(message.tools) ? message.tools.length : 0;
              const mcp = Array.isArray(message.mcp_servers) ? message.mcp_servers.length : 0;
              diagnostics.push(`turn init: model=${message.model} tools=${tools} mcp=${mcp}`);
            }
            break;
          case "assistant": {
            const body = assistantTextOf(message);
            if (body) assistantParts.push(body);
            if (message.session_id) sessionRef = message.session_id;
            if (body) emit({ type: "assistant.message", text: body, stage: String(message.message?.stop_reason ?? "") });
            // Tool uses are reported here, before execution.
            for (const block of message.message?.content ?? []) {
              if (block?.type === "tool_use") {
                toolCalls.set(block.id, block.name);
                emit({ type: "tool.call", call_id: block.id ?? "", name: block.name ?? "" });
              }
            }
            break;
          }
          case "user": {
            // Tool results arrive as user-role messages carrying tool_result blocks.
            for (const block of message.message?.content ?? []) {
              if (block?.type === "tool_result") {
                const name = toolCalls.get(block.tool_use_id) ?? "";
                emit({
                  type: "tool.result",
                  call_id: block.tool_use_id ?? "",
                  name,
                  ok: block.is_error !== true,
                });
              }
            }
            break;
          }
          case "stream_event": {
            const event = message.event;
            if (event?.type === "content_block_delta") {
              const delta = event.delta;
              if (delta?.type === "text_delta" && delta.text) {
                emit({ type: "assistant.delta", text: delta.text });
              } else if (delta?.type === "thinking_delta" && delta.thinking) {
                emit({ type: "thinking.delta", text: delta.thinking });
              }
            }
            break;
          }
          case "result": {
            lastResult = message;
            usage = toCanonicalUsage(message.usage, message.modelUsage) ?? usage;
            if (message.session_id) sessionRef = message.session_id;
            errorMessage = resultError(message) ?? errorMessage;
            break;
          }
          default:
            break;
        }
      }
    } catch (cause) {
      // An interrupt makes the SDK throw rather than yield; the result frame we
      // already saw is authoritative, so only record a cause when we have none.
      if (!lastResult) errorMessage = cause?.message ?? String(cause);
    } finally {
      // A turn that yielded nothing at all — a child killed mid-stream, an auth
      // failure before the first frame — must still settle. Leaving it open
      // hangs the assignment forever, which reads to an operator as a frozen
      // bot rather than a failed one.
      if (!lastResult && !errorMessage) {
        errorMessage = "claude produced no result; the agent process ended unexpectedly";
      }
    }

    // Persist the resume handle only now: the turn ran, so the session exists.
    if (sessionRef) {
      try {
        await commitPointer(stateDir, conversationId, sessionRef);
        resumeSessionId = sessionRef;
      } catch (cause) {
        log("warn", `could not record claude session pointer: ${cause?.message ?? cause}`);
      }
    }
    finish();
  }

  return {
    // A getter, not a copy: the host reads this once when opening, but the SDK
    // may report a different session id later, and the settled report must
    // reflect the id the conversation actually continues with.
    get sessionRef() {
      return sessionRef;
    },
    diagnostics,
    async prompt(text) {
      if (settledFlag) throw new AdapterError("turn_finished", "this session already finished its turn");
      if (typeof text !== "string" || text.trim() === "") {
        throw new AdapterError("bad_request", "text is required");
      }
      settle();
      // Acceptance, not completion: the turn continues in the background and is
      // reported through session/settled. Blocking here would hang cancellation.
      void runTurn(text).catch((cause) => {
        errorMessage = cause?.message ?? String(cause);
        finish();
      });
      return true;
    },
    async wait() {
      if (!settled) return null;
      await settled;
      return this.settleReport();
    },
    settleReport() {
      const reason = aborted ? "aborted" : normaliseStop(lastResult);
      // Claude's own `result` field is the final assistant text for the turn;
      // the streamed blocks are the fallback when a result frame is missing.
      const streamed = joinAssistantText(assistantParts);
      const finalText =
        typeof lastResult?.result === "string" && lastResult.result ? lastResult.result : streamed;
      return {
        stop_reason: reason,
        text: finalText,
        usage: usage ?? undefined,
        model: model || undefined,
        provider: "Anthropic",
        session_ref: sessionRef || undefined,
        error: reason === "stop" ? "" : withHint(errorMessage || finalText) || undefined,
        evidence: evidenceFor(reason, lastResult),
      };
    },
    async cancel() {
      aborted = true;
      if (!queryRuntime) {
        finish();
        return true;
      }
      try {
        await queryRuntime.interrupt();
      } catch (cause) {
        log("warn", `interrupt failed: ${cause?.message ?? cause}`);
        // A refused interrupt means we cannot prove the turn stopped.
        finish();
        return false;
      }
      finish();
      return true;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await queryRuntime?.return?.(undefined);
      } catch (cause) {
        log("warn", `close failed: ${cause?.message ?? cause}`);
      }
    },
  };

  /**
   * Evidence the outcome is trustworthy. Cancellation is only certified when a
   * result frame proved the turn ended; a refused interrupt leaves it unknown,
   * which Earth records as execution_uncertain rather than a clean stop.
   */
  function evidenceFor(reason, result) {
    const evidence = [];
    if (result) evidence.push("result frame observed");
    if (reason === "stop") evidence.push("clean stop");
    if (reason === "aborted" && result) evidence.push("terminal_reason=aborted");
    return evidence;
  }
}

/** Human-readable failure from a result frame, ignoring CLI telemetry noise. */
function resultError(result) {
  if (!result) return "";
  if (result.subtype === "success" && !result.is_error) return "";
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const meaningful = errors.find(
    (error) => typeof error === "string" && !error.startsWith("[ede_diagnostic]"),
  );
  if (meaningful) return meaningful;
  if (result.terminal_reason) return `claude stopped: ${result.terminal_reason}`;
  if (typeof result.result === "string" && result.is_error) return result.result;
  return "";
}

/**
 * Turns Claude's terse failure text into something actionable.
 *
 * "Not logged in" is what a headless bot reports when the service environment
 * lacks the credentials an interactive shell has, and the bare message gives an
 * operator nothing to act on.
 */
function withHint(message) {
  const text = String(message ?? "");
  if (!text) return "";
  if (/not logged in|please run \/login|invalid api key/i.test(text)) {
    return `${text}: the Earth service environment has no usable Claude credentials. Set ANTHROPIC_AUTH_TOKEN (and ANTHROPIC_BASE_URL for a proxy) in the unit's EnvironmentFile.`;
  }
  return text;
}

export default async function createAdapter() {
  return {
    async createSession(ctx) {
      return createClaudeSession(ctx);
    },
  };
}
