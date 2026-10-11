import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, mkdirSync, statSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool,
  createPowerShellTool, createReadTool, createWriteTool, getAgentDir, getPowerShellConfig, getShellConfig,
  type BashOperations, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SecretRedactor } from "./secrets.ts";

/** Grants choose stock Pi tools, not a sandbox or approval of an operation. */
export const REVIEW_TOOL_OPTIONS: readonly { name: string; description: string }[] = [
  { name: "read", description: "Read files." },
  { name: "grep", description: "Search file contents." },
  { name: "find", description: "Find files by path pattern." },
  { name: "ls", description: "List directory contents." },
  { name: "bash", description: "Execute shell commands; each operation requires confirmation." },
  ...(process.platform === "win32" ? [{ name: "powershell", description: "Execute PowerShell commands; each operation requires confirmation." }] : []),
  { name: "edit", description: "Modify existing files; each operation requires confirmation." },
  { name: "write", description: "Create or overwrite files; each operation requires confirmation." },
];

export const ELEVATED_REVIEW_TOOLS: readonly string[] = ["bash", "powershell", "edit", "write"];
const SUPPORTED_REVIEW_TOOLS = new Set(REVIEW_TOOL_OPTIONS.map(tool => tool.name));

/** Canonical supported-list order makes equivalent grants identical. Empty grants stay empty. */
export function parseReviewTools(value: string): string[] {
  if (typeof value !== "string") throw new Error("reviewTools must be a string.");
  const requested = new Set(value.toLowerCase().split(/[,\s]+/));
  requested.delete("");
  for (const name of requested) {
    if (!SUPPORTED_REVIEW_TOOLS.has(name)) throw new Error(`Unknown reviewer tool: ${name}. Supported tools: ${[...SUPPORTED_REVIEW_TOOLS].join(", ")}.`);
  }
  return REVIEW_TOOL_OPTIONS.filter(tool => requested.has(tool.name)).map(tool => tool.name);
}

/** Race even providers/dialogs that ignore cancellation; never invoke work after cancellation. */
export function awaitReviewOperation<T>(operation: () => PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(signal.aborted ? signal.reason : error);
    });
  });
}

type ShellConfig = ReturnType<typeof getShellConfig>;

function killShell(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const cleanup = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    cleanup.on("error", () => { child.kill("SIGKILL"); });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  }
}

/** Stock shell's async cwd check can spawn after abort; check and spawn in one event-loop turn. */
function cancellableShell(config: ShellConfig): BashOperations {
  return {
    exec: (command, cwd, options) => new Promise((resolve, reject) => {
      options.signal?.throwIfAborted();
      accessSync(cwd, constants.F_OK);
      options.signal?.throwIfAborted();
      if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1_000 > 2_147_483_647)) {
        throw new Error("Invalid shell timeout.");
      }
      const fromStdin = config.commandTransport === "stdin";
      const child = spawn(config.shell, fromStdin ? config.args : [...config.args, command], {
        cwd, env: options.env, detached: process.platform !== "win32",
        stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true,
      });
      let timedOut = false;
      let postExitTimer: ReturnType<typeof setTimeout> | undefined;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let exited = false;
      const abort = () => { killShell(child); if (exited) finish(); };
      const timer = options.timeout === undefined ? undefined : setTimeout(() => { timedOut = true; abort(); }, options.timeout * 1_000);
      const data = (chunk: Buffer) => {
        if (!options.signal?.aborted && !timedOut) options.onData(chunk);
        if (exited) { clearTimeout(postExitTimer); postExitTimer = setTimeout(finish, 100); }
      };
      child.stdout?.on("data", data);
      child.stderr?.on("data", data);
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(postExitTimer);
        options.signal?.removeEventListener("abort", abort);
        child.stdout?.removeListener("data", data);
        child.stderr?.removeListener("data", data);
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
      };
      const finish = () => {
        cleanup();
        if (options.signal?.aborted) reject(new Error("aborted"));
        else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
        else resolve({ exitCode: exitCode ?? (exitSignal ? 128 : 1) });
      };
      child.once("error", error => { cleanup(); reject(error); });
      child.once("exit", (code, childSignal) => {
        exited = true;
        exitCode = code;
        exitSignal = childSignal;
        // Drain already-written output before releasing streams, without hanging on detached handles.
        postExitTimer = setTimeout(finish, 100);
        if (options.signal?.aborted || timedOut) finish();
      });
      child.once("close", finish);
      if (fromStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(command);
      }
    }),
  };
}

function requireStockBinary(tool: "grep" | "find"): void {
  const names = tool === "grep" ? ["rg"] : ["fd", "fdfind"];
  const directories = [join(getAgentDir(), "bin"), ...(process.env.PATH ?? "").split(delimiter)];
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of directories) for (const name of names) for (const extension of extensions) {
    try { accessSync(join(directory, name + extension), constants.X_OK); return; }
    catch {}
  }
  throw new Error(`Selected reviewer tool ${tool} is unavailable: install ${names.join(" or ")} first. Reviewer grants do not authorize downloading tools.`);
}

/** Construct only explicitly granted tools; never discover extensions, MCP, skills or session tools. */
export function createReviewTools(ctx: ExtensionContext, names: readonly string[], signal: AbortSignal, redactor: SecretRedactor): AgentTool<any>[] {
  signal.throwIfAborted();
  if (names.includes("grep")) requireStockBinary("grep");
  if (names.includes("find")) requireStockBinary("find");
  const factories = new Map<string, (operationSignal: AbortSignal) => AgentTool<any>>([
    ["read", () => createReadTool(ctx.cwd)],
    ["grep", operationSignal => createGrepTool(ctx.cwd, { operations: {
      // Keep the final prerequisite check and stock rg spawn in one event-loop turn.
      isDirectory: path => { operationSignal.throwIfAborted(); return statSync(path).isDirectory(); },
      readFile: async path => { operationSignal.throwIfAborted(); return readFile(path, "utf8"); },
    } })],
    ["find", () => createFindTool(ctx.cwd)],
    ["ls", () => createLsTool(ctx.cwd)],
    ["edit", operationSignal => createEditTool(ctx.cwd, { operations: {
      access: path => access(path, constants.R_OK | constants.W_OK),
      readFile: path => readFile(path),
      // No pending filesystem mutation can commit after cancellation has been observed.
      writeFile: async (path, content) => { operationSignal.throwIfAborted(); writeFileSync(path, content, "utf8"); },
    } })],
    ["write", operationSignal => createWriteTool(ctx.cwd, { operations: {
      mkdir: async dir => { operationSignal.throwIfAborted(); mkdirSync(dir, { recursive: true }); },
      writeFile: async (path, content) => { operationSignal.throwIfAborted(); writeFileSync(path, content, "utf8"); },
    } })],
  ]);
  // Resolve shell prerequisites before inference, even if the model never calls the tool.
  if (names.includes("bash")) {
    const operations = cancellableShell(getShellConfig());
    factories.set("bash", () => createBashTool(ctx.cwd, { operations, exposeSessionEnvironment: false }));
  }
  if (names.includes("powershell") && process.platform === "win32") {
    const operations = cancellableShell(getPowerShellConfig());
    factories.set("powershell", () => createPowerShellTool(ctx.cwd, { operations, exposeSessionEnvironment: false }));
  }
  return names.map(name => {
    signal.throwIfAborted();
    const factory = factories.get(name);
    if (!factory) throw new Error(`Selected reviewer tool is unavailable: ${name}. Remove it in /decision settings.`);
    const tool = factory(signal);
    return {
      ...tool,
      async execute(id, args, toolSignal, onUpdate) {
        const operationSignal = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal;
        try {
          operationSignal.throwIfAborted();
          if (ELEVATED_REVIEW_TOOLS.includes(name)) {
            if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) throw new Error(`Reviewer ${name} requires interactive per-operation confirmation; denied in headless mode.`);
            const approved = await awaitReviewOperation(() => ctx.ui.confirm(
              `Advisor review: approve ${name}?`,
              redactor.redactText(`This is not sandboxed. Approve only this operation in ${ctx.cwd}:\n${JSON.stringify(args)}`),
              { signal: operationSignal },
            ), operationSignal);
            operationSignal.throwIfAborted();
            if (approved !== true) throw new Error(`Reviewer ${name} operation was not approved.`);
          }
          operationSignal.throwIfAborted();
          const result = await awaitReviewOperation(() => factory(operationSignal).execute(id, args, operationSignal, update => {
            if (!operationSignal.aborted) onUpdate?.(redactor.redactObject(update));
          }), operationSignal);
          return redactor.redactObject(result);
        } catch (error) {
          if (operationSignal.aborted) throw new Error("Reviewer operation cancelled.");
          throw new Error(redactor.redactText(error instanceof Error ? error.message : String(error)));
        }
      },
    };
  });
}
