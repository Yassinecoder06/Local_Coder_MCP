/**
 * Code mode engine for the `exec` tool.
 * Runs user scripts in an isolated node:worker_threads Worker with resource limits.
 *
 * NOTE: This isolation is a convenience boundary for structuring batch tool execution
 * (stripping ambient host globals like require/process/fs/timers), NOT a security sandbox,
 * because the tools exposed through `tools.<name>()` already execute shell and file operations.
 */
import { Worker } from "node:worker_threads";
import type { ToolResult } from "../../core/types.js";

export const MAX_TOOL_CALLS = 32;
export const MAX_CONCURRENT_CALLS = 8;
export const MAX_EMITTED_TEXT_BYTES = 40 * 1024; // 40 KB
export const MAX_IMAGES = 4;
export const DEFAULT_TIMEOUT_MS = 60_000; // 60 s

export interface CodeModeOptions {
  code: string;
  timeoutMs?: number;
  callableTools?: Array<{ name: string; description: string }>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  plugins?: Array<{ plugin: string; tool: string; description: string; execAllowed: boolean }>;
  callPluginTool?: (plugin: string, tool: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface CodeModeSuccess {
  ok: true;
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  totalCalls: number;
}

export interface CodeModeFailure {
  ok: false;
  error: string;
  line?: number;
}

export type CodeModeResult = CodeModeSuccess | CodeModeFailure;

/**
 * Self-contained worker thread source executed in an isolated thread.
 */
const WORKER_SCRIPT = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const MAX_TOOL_CALLS = 32;
const MAX_CONCURRENT_CALLS = 8;
const MAX_EMITTED_TEXT_BYTES = 40 * 1024;
const MAX_IMAGES = 4;

const pendingCalls = new Map();
let nextCallId = 1;
let activeCalls = 0;
let totalCalls = 0;
let emittedText = "";
const emittedImages = [];

parentPort.on("message", (msg) => {
  if (msg.type === "tool_result" || msg.type === "tool_error") {
    const cb = pendingCalls.get(msg.id);
    if (cb) {
      pendingCalls.delete(msg.id);
      releaseSlot();
      if (msg.type === "tool_result") {
        cb.resolve(msg.result);
      } else {
        cb.reject(new Error(msg.error));
      }
    }
  }
});

const waiting = [];
function releaseSlot() {
  activeCalls--;
  const next = waiting.shift();
  if (next) next();
}

function dispatchCall(payload) {
  if (totalCalls >= MAX_TOOL_CALLS) {
    return Promise.reject(new Error(\`Exceeded maximum limit of \${MAX_TOOL_CALLS} tool calls in exec\`));
  }
  totalCalls++;
  // At most MAX_CONCURRENT_CALLS run at once; the rest queue instead of failing.
  const start = () => new Promise((resolve, reject) => {
    activeCalls++;
    const id = nextCallId++;
    pendingCalls.set(id, { resolve, reject });
    parentPort.postMessage({ ...payload, id });
  });
  if (activeCalls < MAX_CONCURRENT_CALLS) return start();
  return new Promise((resolve, reject) => waiting.push(() => start().then(resolve, reject)));
}

function callTool(name, args) {
  if (name === "exec") {
    return Promise.reject(new Error("Recursive exec call is not allowed"));
  }
  return dispatchCall({ type: "call_tool", name, args: args || {} });
}

const hasPlugins = Boolean(workerData.hasPlugins);
function callPlugin(plugin, tool, args) {
  if (!hasPlugins) {
    return Promise.reject(new Error("No plugins are configured. Add one in Admin → Plugins."));
  }
  return dispatchCall({ type: "call_plugin_tool", plugin, tool, args: args || {} });
}

const tools = new Proxy({}, {
  get: (_, prop) => (args) => callTool(String(prop), args || {}),
});

const plugins = new Proxy({}, {
  get: (_, plugin) => new Proxy({}, {
    get: (_, tool) => (args) => callPlugin(String(plugin), String(tool), args || {}),
  }),
});

function text(value) {
  const str = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (emittedText.length + str.length > MAX_EMITTED_TEXT_BYTES) {
    throw new Error(\`Exceeded limit of \${MAX_EMITTED_TEXT_BYTES / 1024} KB emitted text in exec\`);
  }
  emittedText += (emittedText ? "\\n" : "") + str;
}

function image(val) {
  if (val && Array.isArray(val.images)) {
    for (const img of val.images) {
      if (emittedImages.length >= MAX_IMAGES) {
        throw new Error(\`Exceeded limit of \${MAX_IMAGES} images in exec\`);
      }
      emittedImages.push(img);
    }
  } else if (val && val.data && val.mimeType) {
    if (emittedImages.length >= MAX_IMAGES) {
      throw new Error(\`Exceeded limit of \${MAX_IMAGES} images in exec\`);
    }
    emittedImages.push({ data: val.data, mimeType: val.mimeType });
  } else {
    throw new Error("Invalid image: expected { data, mimeType } or ToolResult with images");
  }
}

const ALL_TOOLS = workerData.allTools || [];
const PLUGINS = workerData.plugins || [];

(async () => {
  const userCode = workerData.code;

  // 1. Syntax check with line extraction
  try {
    new vm.Script("(async () => {\\n" + userCode + "\\n})()");
  } catch (err) {
    const match = err.stack ? err.stack.match(/<anonymous>:(\\d+)/) : null;
    const line = match ? Math.max(1, parseInt(match[1], 10) - 1) : undefined;
    parentPort.postMessage({
      type: "error",
      message: err.message,
      line,
    });
    return;
  }

  // 2. Convenience boundary execution (isolated context without host process/require/timers)
  try {
    const sandboxContext = vm.createContext({
      Object, Array, String, Number, Boolean, Math, Date, RegExp, JSON,
      Promise, Error, TypeError, SyntaxError, RangeError, URIError, ReferenceError,
      Map, Set, WeakMap, WeakSet,
      console: {
        log: (...args) => text(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")),
        warn: (...args) => text("[warn] " + args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")),
        error: (...args) => text("[error] " + args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")),
      },
      undefined,
      NaN,
      Infinity,
      isFinite,
      isNaN,
      parseFloat,
      parseInt,
      decodeURI,
      decodeURIComponent,
      encodeURI,
      encodeURIComponent,
    });

    const runner = vm.compileFunction(
      "return (async () => {\\n" + userCode + "\\n})()",
      ["tools", "ALL_TOOLS", "text", "image", "plugins", "PLUGINS"],
      {
        parsingContext: sandboxContext,
        importModuleDynamically: () => {
          throw new Error("Dynamic import is disabled in exec");
        },
      }
    );

    await runner(tools, ALL_TOOLS, text, image, plugins, PLUGINS);

    parentPort.postMessage({
      type: "done",
      text: emittedText,
      images: emittedImages,
      totalCalls,
    });
  } catch (err) {
    const match = err.stack ? err.stack.match(/<anonymous>:(\\d+):(\\d+)/) : null;
    const line = match ? Math.max(1, parseInt(match[1], 10) - 1) : undefined;
    parentPort.postMessage({
      type: "error",
      message: err.message,
      line,
    });
  }
})();
`;

export async function runCodeMode(options: CodeModeOptions): Promise<CodeModeResult> {
  if (options.code.length > 64_000) {
    return { ok: false, error: "Code exceeds maximum limit of 64,000 characters" };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let resolved = false;
    let timedOut = false;
    let totalCallsCount = 0;
    let activeCallsCount = 0;

    const worker = new Worker(WORKER_SCRIPT, {
      eval: true,
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 16,
      },
      workerData: {
        code: options.code,
        allTools: options.callableTools ?? [],
        plugins: options.plugins ?? [],
        hasPlugins: Boolean(options.callPluginTool),
      },
    });

    const finish = (result: CodeModeResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      finish({ ok: false, error: `Execution timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    worker.on("message", (msg: any) => {
      if (msg.type === "call_tool") {
        if (msg.name === "exec") {
          worker.postMessage({
            type: "tool_error",
            id: msg.id,
            error: "Recursive exec call is not allowed",
          });
          return;
        }

        if (totalCallsCount >= MAX_TOOL_CALLS) {
          worker.postMessage({
            type: "tool_error",
            id: msg.id,
            error: `Exceeded maximum limit of ${MAX_TOOL_CALLS} tool calls in exec`,
          });
          return;
        }

        if (activeCallsCount >= MAX_CONCURRENT_CALLS) {
          worker.postMessage({
            type: "tool_error",
            id: msg.id,
            error: `Exceeded limit of ${MAX_CONCURRENT_CALLS} concurrent tool calls in exec`,
          });
          return;
        }

        totalCallsCount++;
        activeCallsCount++;

        options
          .callTool(msg.name, msg.args)
          .then((result) => {
            if (!resolved) {
              worker.postMessage({ type: "tool_result", id: msg.id, result });
            }
          })
          .catch((err: unknown) => {
            if (!resolved) {
              const msgText = err instanceof Error ? err.message : String(err);
              worker.postMessage({ type: "tool_error", id: msg.id, error: msgText });
            }
          })
          .finally(() => {
            activeCallsCount--;
          });
        return;
      }

      if (msg.type === "call_plugin_tool") {
        if (!options.callPluginTool) {
          worker.postMessage({
            type: "tool_error",
            id: msg.id,
            error: "No plugins are configured. Add one in Admin → Plugins.",
          });
          return;
        }

        if (totalCallsCount >= MAX_TOOL_CALLS) {
          worker.postMessage({
            type: "tool_error",
            id: msg.id,
            error: `Exceeded maximum limit of ${MAX_TOOL_CALLS} tool calls in exec`,
          });
          return;
        }

        if (activeCallsCount >= MAX_CONCURRENT_CALLS) {
          worker.postMessage({
            type: "tool_error",
            id: msg.id,
            error: `Exceeded limit of ${MAX_CONCURRENT_CALLS} concurrent tool calls in exec`,
          });
          return;
        }

        totalCallsCount++;
        activeCallsCount++;

        options
          .callPluginTool(msg.plugin, msg.tool, msg.args)
          .then((result) => {
            if (!resolved) {
              worker.postMessage({ type: "tool_result", id: msg.id, result });
            }
          })
          .catch((err: unknown) => {
            if (!resolved) {
              const msgText = err instanceof Error ? err.message : String(err);
              worker.postMessage({ type: "tool_error", id: msg.id, error: msgText });
            }
          })
          .finally(() => {
            activeCallsCount--;
          });
        return;
      }

      if (msg.type === "done") {
        finish({
          ok: true,
          text: msg.text,
          images: msg.images || [],
          totalCalls: msg.totalCalls ?? totalCallsCount,
        });
        return;
      }

      if (msg.type === "error") {
        const lineMsg = msg.line !== undefined ? ` (line ${msg.line})` : "";
        finish({
          ok: false,
          error: `${msg.message}${lineMsg}`,
          line: msg.line,
        });
        return;
      }
    });

    worker.on("error", (err) => {
      if (timedOut) return;
      finish({ ok: false, error: err.message });
    });

    worker.on("exit", (code) => {
      if (resolved) return;
      if (timedOut) {
        finish({ ok: false, error: `Execution timed out after ${timeoutMs}ms` });
      } else if (code !== 0) {
        finish({ ok: false, error: `Worker exited unexpectedly with code ${code}` });
      }
    });
  });
}
