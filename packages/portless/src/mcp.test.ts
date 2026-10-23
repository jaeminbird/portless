import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, PROFILES, buildArgv, parseToolsFlag, toToolResult, createServer } from "./mcp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../dist/cli.js");

async function call(profiles: string[], method: string, params?: unknown) {
  const server = createServer(profiles);
  const res = await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  return res as {
    result: {
      tools: typeof TOOLS;
      content: { text: string }[];
      isError: boolean;
      structuredContent?: unknown;
      protocolVersion: string;
      serverInfo: { name: string };
      capabilities: unknown;
    };
    error?: { code: number; message: string };
  };
}

const MIN_ARGS: Record<string, Record<string, unknown>> = {
  get: { name: "backend" },
  alias_add: { name: "db", port: 5432 },
  alias_remove: { name: "db" },
};

describe("tool registry", () => {
  it("has unique names, each in a non-all profile, and buildArgv covers them", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    const inProfile = new Set<string>();
    for (const [name, p] of Object.entries(PROFILES)) {
      if (name !== "all" && p.tools !== "all") p.tools.forEach((t) => inProfile.add(t));
    }
    for (const name of names) {
      expect(inProfile.has(name)).toBe(true);
      if (name !== "tools_profiles") {
        expect(() => buildArgv(name, MIN_ARGS[name] ?? {})).not.toThrow();
      }
    }
  });
});

describe("buildArgv", () => {
  it.each([
    ["get", { name: "backend", noWorktree: true }, ["get", "backend", "--no-worktree"]],
    ["get", { name: "backend", noWorktree: false }, ["get", "backend"]],
    ["alias_add", { name: "db", port: 5432, force: true }, ["alias", "db", "5432", "--force"]],
    ["alias_remove", { name: "db" }, ["alias", "--remove", "db"]],
    [
      "proxy_start",
      { port: 1355, noTls: true, tld: ["test", "localhost"] },
      ["proxy", "start", "-p", "1355", "--no-tls", "--tld", "test", "--tld", "localhost"],
    ],
    ["version", {}, ["--version"]],
    ["list", { extraArgs: ["--x"], cwd: "/tmp", timeoutMs: 5 }, ["list", "--x"]],
    ["proxy_stop", { port: 1356 }, ["proxy", "stop", "-p", "1356"]],
    ["prune", { force: true }, ["prune", "--force"]],
  ] as const)(
    "builds %s argv without cwd or timeoutMs and appends extraArgs last",
    (tool, args, argv) => {
      expect(buildArgv(tool, args)).toEqual(argv);
    }
  );

  it("rejects a flag-shaped name so it cannot become a CLI flag", () => {
    expect(() => buildArgv("alias_add", { name: "--remove", port: 5432 })).toThrow(
      expect.objectContaining({ code: -32602 })
    );
  });

  it("rejects --foreground for proxy start with -32602", () => {
    expect(() => buildArgv("proxy_start", { extraArgs: ["--foreground"] })).toThrow(
      expect.objectContaining({ code: -32602 })
    );
  });
});

describe("profiles", () => {
  it("parses the tools flag", () => {
    expect(parseToolsFlag(" core, ,proxy ")).toEqual(["core", "proxy"]);
    expect(parseToolsFlag("full")).toEqual(["all"]);
    expect(parseToolsFlag("default")).toEqual(["core"]);
    expect(() => parseToolsFlag("nope")).toThrow(/core/);
    expect(() => parseToolsFlag(" , ")).toThrow();
  });

  it("lists only enabled tools: default excludes proxy, core,proxy includes it", async () => {
    const names = async (p: string[]) =>
      (await call(p, "tools/list")).result.tools.map((t: { name: string }) => t.name);
    const core = await names(["core"]);
    expect(core).toContain("get");
    expect(core).not.toContain("proxy_start");
    expect(await names(["core", "proxy"])).toContain("proxy_start");
    expect(await names(["all"])).toHaveLength(TOOLS.length);
  });

  it("returns an error result for a disabled tool", async () => {
    const res = await call(["core"], "tools/call", { name: "proxy_start", arguments: {} });
    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("not enabled");
  });
});

describe("tools/call validation", () => {
  it("names sorted unknown keys and only the tool's own fields", async () => {
    const res = await call(["core"], "tools/call", {
      name: "get",
      arguments: { zeta: 1, alpha: 2, cwd: "/tmp", timeoutMs: 5, name: "x" },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("alpha, zeta");
    expect(res.result.content[0].text).toContain("Tool arguments: name, noWorktree");
    expect(res.result.content[0].text).not.toMatch(/Unknown argument\(s\)[^.]*cwd/);

    const none = await call(["core"], "tools/call", {
      name: "list",
      arguments: { bogus: 1 },
    });
    expect(none.result.isError).toBe(true);
    expect(none.result.content[0].text).toContain("Tool arguments: none");
  });

  it("returns -32602 for an unknown tool and -32700 for a non-JSON line", async () => {
    const unknown = await call(["core"], "tools/call", {
      name: "nope",
      arguments: {},
    });
    expect(unknown.error?.code).toBe(-32602);

    const malformed = await createServer(["core"]).handleLine("not json");
    expect(malformed?.id).toBeNull();
    expect((malformed?.error as { code: number }).code).toBe(-32700);
  });

  it("returns an error result when the child cannot spawn", async () => {
    const cwd = "/definitely/not/a/real/dir-portless-mcp";
    const res = await call(["core"], "tools/call", {
      name: "list",
      arguments: { cwd },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain(cwd);
  });

  it("rejects timeoutMs above the 32-bit maximum", async () => {
    const res = await call(["core"], "tools/call", {
      name: "list",
      arguments: { timeoutMs: 2147483648 },
    });
    expect(res.result.isError).toBe(true);
  });
});

describe("initialize and tools/list", () => {
  it("echoes a supported version and falls back to the latest", async () => {
    expect(
      (await call(["core"], "initialize", { protocolVersion: "2024-11-05" })).result.protocolVersion
    ).toBe("2024-11-05");
    const res = await call(["core"], "initialize", { protocolVersion: "1999-01-01" });
    expect(res.result.protocolVersion).toBe("2025-11-25");
    expect(res.result.serverInfo.name).toBe("portless");
    expect(res.result.capabilities).toEqual({ tools: {} });
  });

  it("rejects a bad cursor with -32602", async () => {
    for (const cursor of ["abc", "-1", "9999", 3]) {
      const res = await call(["core"], "tools/list", { cursor });
      expect(res.error?.code).toBe(-32602);
      expect(res.error?.message).toContain("Invalid tools/list cursor");
    }
  });
});

describe("toToolResult", () => {
  it("appends stderr, flags non-zero exit, and fills empty output", () => {
    const ok = toToolResult({ exitCode: 0, stdout: "hi\n", stderr: "" });
    expect(ok.content[0].text).toBe("hi");
    expect(ok.isError).toBe(false);

    const bad = toToolResult({ exitCode: 1, stdout: "out", stderr: "boom\n" });
    expect(bad.content[0].text).toBe("out\n\nstderr:\nboom");
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.exitCode).toBe(1);

    expect(toToolResult({ exitCode: 0, stdout: "", stderr: "" }).content[0].text).toBe(
      "(no output)"
    );
  });
});

/** Every command in `portless --help` maps to an MCP tool or a deliberate omission. */
const CLI_COMMANDS: Record<string, string | { omitted: string }> = {
  "": { omitted: "zero-arg and named mode run foreground dev servers" },
  run: { omitted: "runs a foreground dev server" },
  "proxy start": "proxy_start",
  "proxy stop": "proxy_stop",
  mcp: { omitted: "the MCP server itself" },
  "service install": { omitted: "may prompt for sudo" },
  get: "get",
  alias: "alias_add",
  "alias --remove": "alias_remove",
  list: "list",
  doctor: "doctor",
  trust: { omitted: "may prompt for sudo" },
  clean: { omitted: "may prompt for sudo" },
  prune: "prune",
  "hosts sync": { omitted: "may prompt for sudo" },
  "hosts clean": { omitted: "may prompt for sudo" },
};

/** Per tool: which `--help` lines describe it, and the flags it types or deliberately rejects. */
const CLI_FLAGS: Record<
  string,
  { help: string; prefix: string; options?: boolean; known: string[] }
> = {
  get: { help: "get", prefix: "portless get", options: true, known: ["--no-worktree"] },
  alias_add: { help: "alias", prefix: "portless alias <", known: ["--force"] },
  alias_remove: { help: "alias", prefix: "portless alias --remove", known: ["--remove"] },
  proxy_start: {
    help: "proxy",
    prefix: "portless proxy start",
    known: ["-p", "--no-tls", "--lan", "--tld", "--wildcard", "--foreground"],
  },
  proxy_stop: { help: "proxy", prefix: "portless proxy stop", known: [] },
  doctor: { help: "doctor", prefix: "portless doctor", options: true, known: [] },
  prune: { help: "prune", prefix: "portless prune", options: true, known: ["--force"] },
};

function cliHelp(...args: string[]): string[] {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1" };
  delete env.PNPM_SCRIPT_SRC_DIR;
  if (env.npm_command === "exec") delete env.npm_command;
  const res = spawnSync(process.execPath, [CLI_PATH, ...args, "--help"], {
    encoding: "utf-8",
    timeout: 10_000,
    env,
  });
  return res.stdout.split("\n").map((line) => line.trim());
}

describe("CLI coverage", () => {
  it("maps every command in portless --help to a tool or an omission", () => {
    const usage = cliHelp();
    const start = usage.indexOf("Usage:");
    const commands = new Set<string>();
    for (const line of usage.slice(start + 1, usage.indexOf("", start))) {
      const words: string[] = [];
      for (const word of line.split(/\s+/).slice(1)) {
        if (!/^(--)?[a-z][a-z-]*$/.test(word)) break;
        words.push(word);
      }
      commands.add(words.join(" "));
    }
    for (const command of commands) {
      expect(
        CLI_COMMANDS[command],
        `"portless ${command}" is in --help but has no MCP tool. Add one in mcp.ts or list it as omitted.`
      ).toBeDefined();
    }
    const names = new Set(TOOLS.map((t) => t.name));
    for (const target of Object.values(CLI_COMMANDS)) {
      if (typeof target === "string") expect(names.has(target)).toBe(true);
    }
  });

  it("types or deliberately rejects every flag a tool's --help lists", () => {
    for (const [tool, { help, prefix, options, known }] of Object.entries(CLI_FLAGS)) {
      const lines = cliHelp(help).filter(
        (line) => line.startsWith(prefix) || (options === true && line.startsWith("-"))
      );
      const flags = new Set(
        lines.flatMap((line) => line.match(/(?<=^|\s)(-p|--[a-z][a-z-]*)\b/g) ?? [])
      );
      flags.delete("--help");
      for (const flag of flags) {
        expect(
          known,
          `"${flag}" is in "portless ${help} --help" but the ${tool} tool does not handle it. Type it in mcp.ts or reject it.`
        ).toContain(flag);
      }
    }
  });
});

describe("portless mcp end to end", () => {
  it("answers over stdio and matches the CLI output", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-mcp-"));
    const env: Record<string, string | undefined> = {
      ...process.env,
      PORTLESS_STATE_DIR: stateDir,
      NO_COLOR: "1",
    };
    delete env.PNPM_SCRIPT_SRC_DIR;
    if (env.npm_command === "exec") delete env.npm_command;

    try {
      const cli = spawnSync(process.execPath, [CLI_PATH, "get", "backend", "--no-worktree"], {
        encoding: "utf-8",
        timeout: 10_000,
        env,
      });
      const expected = cli.stdout.trim();
      expect(expected).not.toBe("");

      const lines = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get", arguments: { name: "backend", noWorktree: true } },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "get", arguments: { name: "backend", bogus: 1 } },
        },
        { jsonrpc: "2.0", id: 4, method: "shutdown" },
      ];

      const out = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
        const child = spawn(process.execPath, [CLI_PATH, "mcp"], {
          env: { ...env, PORTLESS: "0" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("mcp server did not exit"));
        }, 20_000);
        child.stdout.on("data", (d) => (stdout += d));
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ stdout, code });
        });
        child.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      });

      const responses = out.stdout
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      expect(responses.map((r) => r.id)).toEqual([1, 2, 3, 4]);
      expect(responses[1].result.content[0].text).toBe(expected);
      expect(responses[2].error).toBeUndefined();
      expect(responses[2].result.isError).toBe(true);
      expect(responses[2].result.content[0].text).toContain("bogus");
      expect(out.code).toBe(0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }, 40_000);
});
