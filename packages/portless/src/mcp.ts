/**
 * Stdio MCP server for portless: a thin translator that runs the portless CLI
 * for each tool call.
 *
 * Intentionally omitted: run, <name> <cmd>, --name, and zero-arg mode
 * (foreground dev servers with no detached form), proxy start --foreground
 * (blocks), trust, clean, hosts sync, hosts clean, and service (may prompt for
 * sudo or need a TTY), plus mcp and --help (the server itself and human help).
 */

declare const __VERSION__: string;

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import colors from "./colors.js";
import { isWindows } from "./cli-utils.js";

const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_TIMEOUT_MS = 120000;
const PAGE_SIZE = 64;

const SHARED_PROPERTIES: Record<string, unknown> = {
  cwd: {
    type: "string",
    description:
      "Working directory for the command (decides the app name and worktree prefix). Defaults to the server's working directory.",
  },
  extraArgs: {
    type: "array",
    items: { type: "string" },
    description: "Arguments appended verbatim after the typed arguments.",
  },
  timeoutMs: {
    type: "integer",
    minimum: 1,
    default: DEFAULT_TIMEOUT_MS,
    description: "Timeout in milliseconds.",
  },
};

const SHARED_FIELDS = Object.keys(SHARED_PROPERTIES);

export class McpError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
    this.name = "McpError";
  }
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  annotations: { readOnlyHint: boolean; openWorldHint: boolean };
}

interface ToolMeta {
  def: ToolDef;
  own: string[];
  shared: boolean;
  inProcess: boolean;
}

const TOOL_META: ToolMeta[] = [];

function tool(
  name: string,
  title: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  profileless = false
): ToolDef {
  const inputSchema: ToolDef["inputSchema"] = {
    type: "object",
    properties: profileless ? { ...properties } : { ...properties, ...SHARED_PROPERTIES },
    additionalProperties: false,
  };
  if (required.length > 0) inputSchema.required = required;
  const def: ToolDef = {
    name,
    title,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: profileless ? true : false,
      openWorldHint: false,
    },
  };
  TOOL_META.push({
    def,
    own: Object.keys(properties),
    shared: !profileless,
    inProcess: profileless,
  });
  return def;
}

const NAME_PROPERTY = { type: "string", description: "App or alias name." };
const FORCE_PROPERTY = { type: "boolean", description: "Skip confirmation prompts." };
const PORT_PROPERTY = {
  type: "integer",
  minimum: 1,
  maximum: 65535,
  description: "Port number.",
};

/** Every tool, in tools/list order. */
export const TOOLS: ToolDef[] = [
  (() => {
    const def = tool(
      "portless_list",
      "List routes",
      "List active routes with their URLs, ports, PIDs, and uptime.",
      {},
      []
    );
    def.annotations.readOnlyHint = true;
    return def;
  })(),
  (() => {
    const def = tool(
      "portless_get",
      "Get app URL",
      "Print the URL for a registered app. Use noWorktree when the caller is not inside the app's worktree.",
      {
        name: NAME_PROPERTY,
        noWorktree: {
          type: "boolean",
          description: "Ignore the current worktree prefix when looking up the name.",
        },
      },
      ["name"]
    );
    def.annotations.readOnlyHint = true;
    return def;
  })(),
  (() => {
    const def = tool(
      "portless_alias_add",
      "Add alias",
      "Register a static route for a service portless does not run, such as a database.",
      { name: NAME_PROPERTY, port: PORT_PROPERTY, force: FORCE_PROPERTY },
      ["name", "port"]
    );
    def.annotations.openWorldHint = true;
    return def;
  })(),
  (() => {
    const def = tool(
      "portless_alias_remove",
      "Remove alias",
      "Remove a static route registered with alias add.",
      { name: NAME_PROPERTY },
      ["name"]
    );
    def.annotations.openWorldHint = true;
    return def;
  })(),
  tool(
    "portless_tools_profiles",
    "Show tool profiles",
    "Show the active tool profiles and other profiles you can enable.",
    {},
    [],
    true
  ),
  (() => {
    const def = tool(
      "portless_proxy_start",
      "Start proxy",
      "Start the shared portless proxy as a background daemon. Without port, HTTPS uses 443 which may need sudo; MCP cannot answer a sudo prompt, so pass port (for example 1355) for an unprivileged proxy.",
      {
        port: PORT_PROPERTY,
        noTls: { type: "boolean", description: "Serve plain HTTP instead of HTTPS." },
        lan: { type: "boolean", description: "Expose the proxy on the local network." },
        tld: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "One or more TLDs to serve.",
        },
        wildcard: { type: "boolean", description: "Enable wildcard DNS handling." },
      },
      []
    );
    def.annotations.openWorldHint = true;
    return def;
  })(),
  (() => {
    const def = tool(
      "portless_proxy_stop",
      "Stop proxy",
      "Stop the shared portless proxy. Pass port when the proxy runs on a non-default port.",
      { port: PORT_PROPERTY },
      []
    );
    def.annotations.openWorldHint = true;
    return def;
  })(),
  (() => {
    const def = tool(
      "portless_doctor",
      "Run doctor",
      "Check local portless health, including the proxy, certificates, and routes.",
      {},
      []
    );
    def.annotations.readOnlyHint = true;
    return def;
  })(),
  tool(
    "portless_prune",
    "Prune servers",
    "Kill orphaned dev servers left by crashed sessions.",
    { force: FORCE_PROPERTY },
    []
  ),
  (() => {
    const def = tool("portless_version", "Print version", "Print the portless version.", {}, []);
    def.annotations.readOnlyHint = true;
    return def;
  })(),
];

/** Profile name -> description and tool names. `all` has tools: "all". Aliases are not keys here. */
export const PROFILES: Record<string, { description: string; tools: string[] | "all" }> = {
  core: {
    description: "Everyday route lookup and static aliases.",
    tools: [
      "portless_list",
      "portless_get",
      "portless_alias_add",
      "portless_alias_remove",
      "portless_tools_profiles",
    ],
  },
  proxy: {
    description: "Start and stop the shared portless proxy.",
    tools: ["portless_proxy_start", "portless_proxy_stop"],
  },
  diagnostics: {
    description: "Health checks, cleanup, and version information.",
    tools: ["portless_doctor", "portless_prune", "portless_version"],
  },
  all: {
    description: "Every available tool.",
    tools: "all",
  },
};

const PROFILE_ALIASES: Record<string, string> = { default: "core", full: "all" };

const VALID_PROFILES = "core, proxy, diagnostics, all (aliases: default = core, full = all)";

function metaFor(toolName: string): ToolMeta | undefined {
  return TOOL_META.find((meta) => meta.def.name === toolName);
}

/** Parse a --tools value into canonical profile names (aliases resolved). */
export function parseToolsFlag(value: string): string[] {
  const requested = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (requested.length === 0) {
    throw new Error(`No tools profiles given. Valid profiles: ${VALID_PROFILES}.`);
  }
  const resolved: string[] = [];
  const unknown: string[] = [];
  for (const name of requested) {
    const canonical = PROFILE_ALIASES[name] ?? name;
    if (!(canonical in PROFILES)) {
      unknown.push(name);
      continue;
    }
    if (!resolved.includes(canonical)) resolved.push(canonical);
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unknown tools profile: ${unknown.join(", ")}. Valid profiles: ${VALID_PROFILES}.`
    );
  }
  return resolved;
}

function fail(message: string): never {
  throw new McpError(-32602, message);
}

function readString(
  args: Record<string, unknown>,
  key: string,
  required: boolean
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) fail(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") fail(`${key} must be a string`);
  return value;
}

function readRequiredName(args: Record<string, unknown>, key: string): string {
  const value = readString(args, key, true);
  if (value === undefined || value.length === 0) fail(`${key} must not be empty`);
  return value;
}

function readBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") fail(`${key} must be a boolean`);
  return value;
}

function readPort(
  args: Record<string, unknown>,
  key: string,
  required: boolean
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) fail(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    fail(`${key} must be an integer between 1 and 65535`);
  }
  return value;
}

function readExtraArgs(args: Record<string, unknown>): string[] {
  const value = args.extraArgs;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("extraArgs must be an array");
  return value.map((item, index) => {
    if (typeof item !== "string") fail(`extraArgs[${index}] must be a string`);
    return item;
  });
}

function readTld(args: Record<string, unknown>): string[] {
  const value = args.tld;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length === 0) fail("tld must not be empty");
  return value.map((item, index) => {
    if (typeof item !== "string") fail(`tld[${index}] must be a string`);
    return item;
  });
}

function validateShared(args: Record<string, unknown>): void {
  readString(args, "cwd", false);
  readExtraArgs(args);
  const timeout = args.timeoutMs;
  if (timeout !== undefined && timeout !== null) {
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1) {
      fail("timeoutMs must be a positive integer");
    }
  }
}

/** Build the CLI argv (without node/script path, without cwd/timeoutMs) for a child-run tool. */
export function buildArgv(toolName: string, args: Record<string, unknown>): string[] {
  validateShared(args);
  const extraArgs = readExtraArgs(args);
  const argv: string[] = [];

  switch (toolName) {
    case "portless_list":
      argv.push("list");
      break;
    case "portless_get": {
      const name = readRequiredName(args, "name");
      argv.push("get", name);
      if (readBoolean(args, "noWorktree") === true) argv.push("--no-worktree");
      break;
    }
    case "portless_alias_add": {
      const name = readRequiredName(args, "name");
      const port = readPort(args, "port", true);
      argv.push("alias", name, String(port));
      if (readBoolean(args, "force") === true) argv.push("--force");
      break;
    }
    case "portless_alias_remove": {
      const name = readRequiredName(args, "name");
      argv.push("alias", "--remove", name);
      break;
    }
    case "portless_tools_profiles":
      break;
    case "portless_proxy_start": {
      const port = readPort(args, "port", false);
      if (extraArgs.includes("--foreground")) {
        fail(
          "extraArgs must not include --foreground because the foreground proxy would block the call"
        );
      }
      argv.push("proxy", "start");
      if (port !== undefined) argv.push("-p", String(port));
      if (readBoolean(args, "noTls") === true) argv.push("--no-tls");
      if (readBoolean(args, "lan") === true) argv.push("--lan");
      for (const tld of readTld(args)) argv.push("--tld", tld);
      if (readBoolean(args, "wildcard") === true) argv.push("--wildcard");
      break;
    }
    case "portless_proxy_stop": {
      const port = readPort(args, "port", false);
      argv.push("proxy", "stop");
      if (port !== undefined) argv.push("-p", String(port));
      break;
    }
    case "portless_doctor":
      argv.push("doctor");
      break;
    case "portless_prune":
      argv.push("prune");
      if (readBoolean(args, "force") === true) argv.push("--force");
      break;
    case "portless_version":
      argv.push("--version");
      break;
    default:
      fail(`Unknown tool: ${toolName}`);
  }

  argv.push(...extraArgs);
  return argv;
}

/** Map a finished child run to an MCP tool result. */
export function toToolResult(run: { exitCode: number | null; stdout: string; stderr: string }): {
  content: { type: "text"; text: string }[];
  structuredContent: { exitCode: number | null; stdout: string; stderr: string };
  isError: boolean;
} {
  const stdout = run.stdout.trim();
  const stderr = run.stderr.trim();
  let text = stdout;
  if (stderr.length > 0)
    text = text.length > 0 ? `${text}\n\nstderr:\n${stderr}` : `stderr:\n${stderr}`;
  if (text.length === 0) text = "(no output)";
  return {
    content: [{ type: "text", text }],
    structuredContent: { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr },
    isError: run.exitCode !== 0,
  };
}

function runChild(
  argv: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    delete env.FORCE_COLOR;

    let child;
    try {
      child = spawn(process.execPath, [process.argv[1], ...argv], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: !isWindows,
        windowsHide: true,
      });
    } catch (error) {
      reject(new McpError(-32603, `Failed to run portless: ${(error as Error).message}`));
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = stripVTControlCharacters(Buffer.concat(out).toString("utf8"));
      let stderr = stripVTControlCharacters(Buffer.concat(err).toString("utf8"));
      if (timedOut) {
        const note = `portless command timed out after ${timeoutMs}ms`;
        stderr = stderr.trim().length > 0 ? `${stderr.trimEnd()}\n${note}` : note;
      }
      resolve({ exitCode: timedOut ? null : code, stdout, stderr });
    };

    child.stdout?.on("data", (chunk: Buffer) => out.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => err.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new McpError(-32603, `Failed to run portless: ${error.message}`));
    });
    child.on("close", finish);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function resultResponse(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function profilesText(profiles: string[]): string {
  const lines = [`Active profiles: ${profiles.join(", ")}`];
  for (const name of Object.keys(PROFILES)) {
    const profile = PROFILES[name];
    const count = profile.tools === "all" ? TOOLS.length : profile.tools.length;
    lines.push(`${name}: ${profile.description} (${count} tools), portless mcp --tools ${name}`);
  }
  return lines.join("\n");
}

/** A server for the given canonical profile names. */
export function createServer(profiles: string[]): {
  handleLine(line: string): Promise<Record<string, unknown> | null>;
  readonly shutdown: boolean;
} {
  let shutdown = false;
  const enabled = new Set<string>();
  for (const profileName of profiles) {
    const profile = PROFILES[profileName];
    if (!profile) continue;
    if (profile.tools === "all") {
      for (const def of TOOLS) enabled.add(def.name);
    } else {
      for (const name of profile.tools) enabled.add(name);
    }
  }

  async function handleRequest(
    message: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    const id = message.id;
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const method = message.method;
    if (typeof method !== "string") {
      return hasId ? errorResponse(id, -32600, "Invalid request: missing method") : null;
    }
    if (!hasId) return null;

    const params = message.params;

    switch (method) {
      case "initialize": {
        if (params !== undefined && !isObject(params)) {
          return errorResponse(id, -32602, "params must be an object");
        }
        const requested = params?.protocolVersion;
        if (requested !== undefined && typeof requested !== "string") {
          return errorResponse(id, -32602, "protocolVersion must be a string");
        }
        const version =
          typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : PROTOCOL_VERSIONS[0];
        const instructions =
          `Portless MCP server. Active profiles: ${profiles.join(", ")}. ` +
          "Use portless_get to find an app's URL, portless_list to see active routes. " +
          "Start dev servers with `portless run <cmd>` in a shell; MCP does not run them. " +
          "Call portless_tools_profiles to see other tool profiles.";
        return resultResponse(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "portless", title: "Portless", version: VERSION },
          instructions,
        });
      }
      case "ping":
        return resultResponse(id, {});
      case "tools/list": {
        if (params !== undefined && !isObject(params)) {
          return errorResponse(id, -32602, "params must be an object");
        }
        const cursor = params?.cursor;
        const page = TOOLS.filter((def) => enabled.has(def.name));
        let start = 0;
        if (cursor !== undefined && cursor !== null) {
          if (typeof cursor !== "string" || !/^\d+$/.test(cursor)) {
            return errorResponse(id, -32602, "Invalid tools/list cursor");
          }
          start = Number(cursor);
          if (start > page.length) {
            return errorResponse(id, -32602, "Invalid tools/list cursor");
          }
        }
        const slice = page.slice(start, start + PAGE_SIZE);
        const result: Record<string, unknown> = { tools: slice };
        if (start + PAGE_SIZE < page.length) result.nextCursor = String(start + PAGE_SIZE);
        return resultResponse(id, result);
      }
      case "tools/call": {
        if (!isObject(params)) {
          return errorResponse(id, -32602, "params must be an object");
        }
        if (typeof params.name !== "string") {
          return errorResponse(id, -32602, "params.name must be a string");
        }
        const toolName = params.name;
        const rawArgs = params.arguments;
        if (rawArgs !== undefined && rawArgs !== null && !isObject(rawArgs)) {
          return errorResponse(id, -32602, "tool arguments must be an object");
        }
        const args = isObject(rawArgs) ? rawArgs : {};
        const meta = metaFor(toolName);
        if (!meta) return errorResponse(id, -32602, `Unknown tool: ${toolName}`);
        if (!enabled.has(toolName)) {
          return errorResponse(
            id,
            -32602,
            `Tool ${toolName} is not enabled. Restart with portless mcp --tools all or add a profile that includes it.`
          );
        }

        const accepted = new Set([...meta.own, ...(meta.shared ? SHARED_FIELDS : [])]);
        const unknown = Object.keys(args)
          .filter((key) => !accepted.has(key))
          .sort();
        if (unknown.length > 0) {
          const own = meta.own.length > 0 ? meta.own.join(", ") : "none";
          return errorResponse(
            id,
            -32602,
            `Unknown argument(s) for ${toolName}: ${unknown.join(", ")}. Tool arguments: ${own}.`
          );
        }

        try {
          if (meta.inProcess) {
            const text = profilesText(profiles);
            return resultResponse(id, {
              content: [{ type: "text", text }],
              structuredContent: { text },
              isError: false,
            });
          }
          const argv = buildArgv(toolName, args);
          const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
          const timeoutMs =
            typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
          const run = await runChild(argv, cwd, timeoutMs);
          return resultResponse(id, toToolResult(run));
        } catch (error) {
          if (error instanceof McpError) {
            return errorResponse(id, error.code, error.message);
          }
          return errorResponse(id, -32603, `Failed to run portless: ${(error as Error).message}`);
        }
      }
      case "shutdown": {
        shutdown = true;
        return resultResponse(id, {});
      }
      default:
        return errorResponse(id, -32601, `Method not found: ${method}`);
    }
  }

  return {
    async handleLine(line: string): Promise<Record<string, unknown> | null> {
      if (line.trim().length === 0) return null;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        return errorResponse(null, -32700, `Parse error: ${(error as Error).message}`);
      }
      if (!isObject(message)) {
        return null;
      }
      return handleRequest(message);
    },
    get shutdown() {
      return shutdown;
    },
  };
}

/** Print help for `portless mcp`. */
export function printMcpHelp(): void {
  process.stdout.write(
    [
      "Usage: portless mcp [--tools <profiles>]",
      "",
      "Start a Model Context Protocol server over stdio. The client launches this",
      "process and exchanges newline-delimited JSON-RPC messages on stdin/stdout;",
      "stdout carries only protocol messages and diagnostics go to stderr.",
      "",
      "Profiles:",
      "  core         Everyday route lookup and static aliases.",
      "  proxy        Start and stop the shared portless proxy.",
      "  diagnostics  Health checks, cleanup, and version information.",
      "  all          Every available tool.",
      "",
      "Common tools:",
      "  portless_list            List active routes.",
      "  portless_get             Print an app URL.",
      "  portless_alias_add       Register a static route.",
      "  portless_tools_profiles  Show active and available profiles.",
      "",
      "Pass --tools with a comma separated list of profiles. The default is core.",
      "Aliases: default = core, full = all. Use the extraArgs argument on any tool",
      "to append CLI flags that are not typed into the tool schema.",
      "",
      "Environment:",
      "  PORTLESS_STATE_DIR  Directory for portless state.",
      "  PORTLESS_PORT       Default proxy port.",
      "  PORTLESS_TLD        Default TLD or comma separated TLD list.",
      "",
      "Client config:",
      '  {"mcpServers":{"portless":{"command":"portless","args":["mcp"]}}}',
      '  {"mcpServers":{"portless":{"command":"portless","args":["mcp","--tools","all"]}}}',
      "",
    ].join("\n")
  );
}

/** Run the stdio MCP server. */
export async function runMcp(args: string[]): Promise<void> {
  let toolsValue: string | undefined;

  const usageError = (message: string): void => {
    console.error(colors.red(`Error: ${message}`));
    console.error("Usage: portless mcp [--tools <profiles>]");
    process.exit(1);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      printMcpHelp();
      return;
    }
    if (arg === "--tools") {
      if (index + 1 >= args.length) usageError("--tools requires a value");
      toolsValue = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--tools=")) {
      toolsValue = arg.slice("--tools=".length);
      continue;
    }
    usageError(`Unknown argument: ${arg}`);
  }

  let profiles: string[];
  try {
    profiles = toolsValue === undefined ? ["core"] : parseToolsFlag(toolsValue);
  } catch (error) {
    usageError((error as Error).message);
    return;
  }

  const server = createServer(profiles);
  let streamFailed = false;
  const onStreamError = (): void => {
    streamFailed = true;
  };
  process.stdout.on("error", onStreamError);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const response = await server.handleLine(line);
    if (response !== null) {
      try {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch {
        break;
      }
    }
    if (server.shutdown || streamFailed) break;
  }
  rl.close();
  process.stdout.off("error", onStreamError);
}
