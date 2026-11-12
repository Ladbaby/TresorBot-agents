// Pi coding agent adapter.
//
// This is the in-process equivalent of TresorBot's former per-assignment pi
// driver. It differs in one decisive way: it uses pi's SDK rather than
// `pi --mode rpc`, so one host process hosts many pi sessions concurrently.
// `--mode rpc` holds a single session and rebinds it on every switch, which
// cannot serve a wide Worker fleet.
//
// The two scripts the old driver embedded are gone:
//   session-helper.mjs        -> SessionManager.open/create called directly
//   bot-context-extension.mjs -> customTools + appendSystemPrompt + tools

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { PI_PKG, resolvePiPkgDir } from "./pi-resolve.mjs";

const IMPORTED_HISTORY_MODEL = "imported-history";

/** Structural failure the host reports as a typed protocol reason. */
class AdapterError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "AdapterError";
    this.reason = reason;
  }
}

/** Loads the SDK exactly once per host, not once per session. */
let sdkPromise = null;
/** How the SDK was located, so a session can report it as a diagnostic. */
let lastResolution = null;
async function loadSdk(settings) {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      // Discovery first: an operator should not have to name pi's package path,
      // which is buried in a versioned release directory and changes on update.
      const hint = settings.cli_path || "";
      const { dir, source } = resolvePiPkgDir({ hint });
      if (dir) {
        const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
        const entry = resolve(dir, manifest.main ?? "dist/index.js");
        lastResolution = { dir, source };
        return import(pathToFileURLString(entry));
      }
      // A locally installed copy beside the adapter is the last resort before
      // giving up; the install command puts one there when npm was available.
      try {
        lastResolution = { dir: null, source: "package resolution" };
        return await import(PI_PKG);
      } catch {
        throw new AdapterError(
          "pi_unavailable",
          `could not find ${PI_PKG}. Install pi, or set "cli_path" in config.json to the pi command or its package directory.`,
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

/** Maps pi's native usage onto the canonical shape Earth understands. */
function toCanonicalUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const num = (value) => (typeof value === "number" && value >= 0 ? value : undefined);
  const input = num(usage.input);
  const output = num(usage.output);
  if (input === undefined || output === undefined) {
    return { partial: true, input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 };
  }
  const cacheRead = num(usage.cacheRead) ?? 0;
  const cacheWrite = num(usage.cacheWrite) ?? 0;
  const total = num(usage.totalTokens) ?? input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    total,
    models: {
      [`${usage.provider ?? ""}/${usage.model ?? ""}`]: {
        provider: usage.provider ?? "",
        model: usage.model ?? "",
        input,
        output,
        cache_read: cacheRead,
        cache_write: cacheWrite,
        total,
      },
    },
  };
}

/**
 * Renders a Sun tool payload as plain text. This mirrors the old extension's
 * convention: a top-level `text` string wins, an `error` object becomes one
 * short line, and anything else is indented JSON.
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
 * Builds the Sun tool definitions as pi ToolDefinitions, proxying through
 * Earth's loopback tool endpoint. The runner credential never reaches this
 * process: Earth performs the upstream call.
 *
 * Returns an object rather than a list so discovery can fail (or be skipped)
 * without the caller having to distinguish "no tools" from "could not ask".
 */
function buildHostTools({ toolUrl, toolToken, assignmentId, crypto }) {
  if (!toolUrl || !toolToken) return { async discover() { return []; } };
  const call = async (path, body, signal) => {
    const response = await fetch(toolUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${toolToken}` },
      body: JSON.stringify(body),
      signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error?.code || "Bot tool unavailable");
    }
    return payload;
  };

  return {
    async discover() {
      const definitions = await call("/definitions", {});
      const tools = [];
      for (const tool of definitions.tools ?? []) {
        tools.push({
          name: tool.name,
          label: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          async execute(callId, args, signal) {
            // Stable per-turn operation id, so a retried call is deduplicated by
            // Sun exactly as before.
            const operationId = crypto
              .createHash("sha256")
              .update(`${assignmentId}\u0000${callId}`)
              .digest("hex");
            const result = await call("/execute", { operation_id: operationId, tool: tool.name, arguments: args }, signal);
            return { content: [{ type: "text", text: toolResultText(result) }], details: result };
          },
        });
      }
      return tools;
    },
  };
}

/**
 * Resolves the pi SessionManager for a conversation, creating and importing
 * history on first use. This replaces session-helper.mjs: same on-disk contract
 * (a `session.json` pointer plus a session directory), but called in-process.
 */
async function resolveSession({ sdk, workspace, stateDir, conversationId, history }) {
  const pointerPath = join(stateDir, "session.json");
  const sessionsDir = join(stateDir, "pi-sessions");
  await mkdir(sessionsDir, { recursive: true });

  if (existsSync(pointerPath)) {
    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    if (pointer.conversationID !== conversationId || typeof pointer.sessionFile !== "string") {
      throw new AdapterError("session_mismatch", "session pointer does not match this conversation");
    }
    const sessionFile = resolve(pointer.sessionFile);
    if (!existsSync(sessionFile)) {
      throw new AdapterError("session_missing", "the mapped pi session is missing");
    }
    return { manager: sdk.SessionManager.open(sessionFile, sessionsDir, workspace), sessionFile, resumed: true };
  }

  const manager = sdk.SessionManager.create(workspace, sessionsDir);
  // Import prior turns except the final user message (which becomes the live
  // prompt) and any system/developer messages (which become the instructions).
  const lastUser = history.reduce((found, item, index) => (item.role === "user" ? index : found), -1);
  for (let index = 0; index < history.length; index += 1) {
    const item = history[index];
    if (index === lastUser || item.role === "system" || item.role === "developer") continue;
    if (item.role === "user") {
      manager.appendMessage({ role: "user", content: item.content, timestamp: Date.now() });
    } else if (item.role === "assistant") {
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: item.content }],
        api: "openai-completions",
        provider: "openai",
        model: IMPORTED_HISTORY_MODEL,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    } else {
      throw new AdapterError("import_failed", `unsupported imported role: ${item.role}`);
    }
  }
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new AdapterError("session_missing", "pi did not persist the session");
  const temp = `${pointerPath}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ conversationID: conversationId, sessionFile }), { mode: 0o600 });
  await rename(temp, pointerPath);
  return { manager, sessionFile, resumed: false };
}

/** Text of the final assistant message, matching the old verification step. */
function lastAssistantText(session) {
  try {
    return session.getLastAssistantText?.() ?? "";
  } catch {
    return "";
  }
}

async function createPiSession(ctx) {
  // The host passes wire-shaped (snake_case) fields straight through, so the
  // adapter reads exactly what Earth sent rather than a renamed view.
  const settings = ctx.settings ?? {};
  const workspace = ctx.workspace;
  const stateDir = ctx.state_dir;
  const conversationId = ctx.conversation_id;
  const instructions = ctx.instructions ?? "";
  const history = ctx.history ?? [];
  const toolUrl = ctx.tool_url;
  const toolToken = ctx.tool_token;
  const assignmentId = ctx.assignment_id;
  const emit = ctx.emit ?? (() => {});
  const log = ctx.log ?? (() => {});
  const sdk = await loadSdk(settings);
  const crypto = await import("node:crypto");

  const { manager, sessionFile } = await resolveSession({ sdk, workspace, stateDir, conversationId, history });

  // Instructions replace the old before_agent_start extension.
  const appendSystemPrompt = [];
  if (instructions && instructions.trim()) appendSystemPrompt.push(instructions);

  const hostTools = buildHostTools({ toolUrl, toolToken, assignmentId, crypto });
  const customTools = await hostTools.discover();

  const toolAllowlist = Array.isArray(settings.tools) && settings.tools.length > 0 ? settings.tools : undefined;

  const created = await sdk.createAgentSession({
    cwd: workspace,
    sessionManager: manager,
    customTools,
    ...(toolAllowlist ? { tools: [...toolAllowlist, ...customTools.map((tool) => tool.name)] } : {}),
    ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}),
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.thinking_level ? { thinkingLevel: settings.thinking_level } : {}),
  });

  const session = created.session;
  if (created.modelFallbackMessage) log("warn", created.modelFallbackMessage);
  const diagnostics = created.extensionsResult?.diagnostics?.map((d) => d.message) ?? [];
  // Record where pi came from. Discovery is silent by design, so this is the only
  // way an operator can tell which installation a bot is actually running.
  if (lastResolution?.dir) {
    diagnostics.push(`pi runtime: ${lastResolution.dir} (${lastResolution.source})`);
  } else if (lastResolution?.source) {
    diagnostics.push(`pi runtime: ${lastResolution.source}`);
  }

  // Reject a session with no usable model before prompting, which is what the
  // old driver's preflight did.
  const modelId = session.model?.id;
  if (!modelId || modelId === "unknown") {
    throw new AdapterError(
      "no_model",
      "local pi has no available model; check provider credentials and the Earth service environment",
    );
  }

  let settlePromise = null;
  let settleResolve = null;
  const settle = () => {
    if (!settlePromise) {
      settlePromise = new Promise((res) => {
        settleResolve = res;
      });
    }
    return settlePromise;
  };
  let settled = false;
  let aborted = false;
  let stopReason = "error";
  let errorMessage = "";
  let usage = null;
  let text = "";

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        emit({ type: "turn.started" });
        return;
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (!delta) return;
        if (delta.type === "text_delta" && delta.delta) {
          emit({ type: "assistant.delta", text: delta.delta });
        } else if (delta.type === "thinking_delta" && delta.delta) {
          emit({ type: "thinking.delta", text: delta.delta });
        }
        return;
      }
      case "tool_execution_start":
        emit({ type: "tool.call", call_id: event.toolCallId ?? "", name: event.toolName ?? "" });
        return;
      case "tool_execution_end":
        emit({ type: "tool.result", call_id: event.toolCallId ?? "", name: event.toolName ?? "", ok: !event.isError });
        return;
      case "message_end": {
        const message = event.message;
        if (!message || message.role !== "assistant") return;
        stopReason = message.stopReason ?? stopReason;
        errorMessage = message.errorMessage ?? errorMessage;
        text = assistantTextOf(message) || text;
        if (message.model === IMPORTED_HISTORY_MODEL) return;
        usage = toCanonicalUsage({ ...message.usage, provider: message.provider, model: message.model }) ?? usage;
        emit({
          type: "assistant.message",
          text: assistantTextOf(message),
          stage: message.stopReason ?? "",
        });
        return;
      }
      case "agent_settled": {
        settled = true;
        settleResolve?.();
        return;
      }
      default:
        return;
    }
  });

  return {
    sessionRef: sessionFile,
    diagnostics,
    async prompt(promptText) {
      if (settled) throw new AdapterError("turn_finished", "this session already finished its turn");
      if (typeof promptText !== "string" || promptText.trim() === "") {
        throw new AdapterError("bad_request", "text is required");
      }
      settle();
      // prompt() resolves when the run finishes; agent_settled is authoritative.
      const running = session.prompt(promptText);
      // Surface completion to the host as soon as the run is done, whichever
      // signal arrives first.
      running.then(
        () => settleResolve?.(),
        (cause) => {
          errorMessage = cause?.message ?? String(cause);
          settleResolve?.();
        },
      );
      return true;
    },
    /** Waits for the turn to end and reports it. Called by the host. */
    async wait() {
      if (!settlePromise) return null;
      await settlePromise;
      return this.settleReport();
    },
    settleReport() {
      const reason = aborted ? "aborted" : normaliseStop(stopReason, errorMessage);
      const verified = lastAssistantText(session);
      if (reason === "stop" && verified && text && verified !== text) {
        return {
          stop_reason: "error",
          error: "pi last assistant text did not match the observed final message",
          session_ref: sessionFile,
        };
      }
      return {
        stop_reason: reason,
        text: text || verified || "",
        usage: usage ?? undefined,
        model: session.model?.id,
        provider: session.model?.provider,
        session_ref: sessionFile,
        error: reason === "stop" ? "" : errorMessage || undefined,
        evidence: settled ? ["agent_settled observed"] : [],
      };
    },
    async cancel() {
      aborted = true;
      try {
        await session.abort();
        await session.waitForIdle?.();
      } catch (cause) {
        log("warn", `abort failed: ${cause?.message ?? cause}`);
        return false;
      }
      settleResolve?.();
      return true;
    },
    async close() {
      unsubscribe?.();
      try {
        session.dispose?.();
      } catch (cause) {
        log("warn", `dispose failed: ${cause?.message ?? cause}`);
      }
    },
  };
}

function assistantTextOf(message) {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/** Maps pi's stop reason onto the canonical one Earth understands. */
function normaliseStop(reason, errorMessage) {
  switch (reason) {
    case "stop":
      return "stop";
    case "aborted":
      return "aborted";
    case "length":
    case "max_tokens":
      return "max_turns";
    case "usage_limit":
    case "rate_limit":
      return "usage_limit";
    default:
      if (errorMessage && /usage|rate limit|quota/i.test(errorMessage)) return "usage_limit";
      return reason && reason !== "end_turn" ? "error" : "stop";
  }
}

export default async function createAdapter() {
  return {
    async createSession(ctx) {
      const session = await createPiSession(ctx);
      return session;
    },
  };
}
