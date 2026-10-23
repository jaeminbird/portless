import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, PROFILES, buildArgv, parseToolsFlag, toToolResult, createServer } from "./mcp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../dist/cli.js");

/** Send one JSON-RPC request to a fresh server and return the response. */
async function call(profiles: string[], method: string, params?: unknown) {
  const server = createServer(profiles);
  const res = await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  return res as { result?: any; error?: { code: number; message: string } };
}

const MIN_ARGS: Record<string, Record<string, unknown>> = {
  portless_get: { name: "backend" },
  portless_alias_add: { name: "db", port: 5432 },
  portless_alias_remove: { name: "db" },
};

describe("tool registry", () => {
  it("has unique portless_ names, each in a non-all profile, and buildArgv covers them", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    const inProfile = new Set<string>();
    for (const [name, p] of Object.entries(PROFILES)) {
      if (name !== "all" && p.tools !== "all") p.tools.forEach((t) => inProfile.add(t));
    }
    for (const name of names) {
      expect(name.startsWith("portless_")).toBe(true);
      expect(inProfile.has(name)).toBe(true);
      if (name !== "portless_tools_profiles") {
        expect(() => buildArgv(name, MIN_ARGS[name] ?? {})).not.toThrow();
      }
    }
  });
});

describe("buildArgv", () => {
  it("builds argv from typed args", () => {
    expect(buildArgv("portless_get", { name: "backend", noWorktree: true })).toEqual([
      "get",
      "backend",
      "--no-worktree",
    ]);
    expect(buildArgv("portless_get", { name: "backend", noWorktree: false })).toEqual([
      "get",
      "backend",
    ]);
    expect(buildArgv("portless_alias_add", { name: "db", port: 5432, force: true })).toEqual([
      "alias",
      "db",
      "5432",
      "--force",
    ]);
    expect(buildArgv("portless_alias_remove", { name: "db" })).toEqual(["alias", "--remove", "db"]);
    expect(
      buildArgv("portless_proxy_start", { port: 1355, noTls: true, tld: ["test", "localhost"] })
    ).toEqual(["proxy", "start", "-p", "1355", "--no-tls", "--tld", "test", "--tld", "localhost"]);
    expect(buildArgv("portless_version", {})).toEqual(["--version"]);
  });

  it("appends extraArgs last and drops cwd and timeoutMs", () => {
    expect(buildArgv("portless_list", { extraArgs: ["--x"], cwd: "/tmp", timeoutMs: 5 })).toEqual([
      "list",
      "--x",
    ]);
  });

  it("rejects --foreground for proxy start with -32602", () => {
    expect(() => buildArgv("portless_proxy_start", { extraArgs: ["--foreground"] })).toThrow(
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
    expect(core).toContain("portless_get");
    expect(core).not.toContain("portless_proxy_start");
    expect(await names(["core", "proxy"])).toContain("portless_proxy_start");
  });

  it("returns an error result for a disabled tool", async () => {
    const res = await call(["core"], "tools/call", { name: "portless_proxy_start", arguments: {} });
    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("not enabled");
    expect(res.result.structuredContent).toBeUndefined();
  });
});

describe("tools/call validation", () => {
  it("names sorted unknown keys and only the tool's own fields", async () => {
    const res = await call(["core"], "tools/call", {
      name: "portless_get",
      arguments: { zeta: 1, alpha: 2, cwd: "/tmp", timeoutMs: 5, name: "x" },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("alpha, zeta");
    expect(res.result.content[0].text).toContain("Tool arguments: name, noWorktree");
    expect(res.result.content[0].text).not.toMatch(/Unknown argument\(s\)[^.]*cwd/);
  });

  it("says none when the tool has no own fields", async () => {
    const res = await call(["core"], "tools/call", {
      name: "portless_list",
      arguments: { bogus: 1 },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("Tool arguments: none");
  });

  it("marks destructive tools", () => {
    const remove = TOOLS.find((t) => t.name === "portless_alias_remove");
    const add = TOOLS.find((t) => t.name === "portless_alias_add");
    expect(remove?.annotations.destructiveHint).toBe(true);
    expect(add?.annotations.destructiveHint).toBe(false);
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
          params: { name: "portless_get", arguments: { name: "backend", noWorktree: true } },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "portless_get", arguments: { name: "backend", bogus: 1 } },
        },
        { jsonrpc: "2.0", id: 4, method: "shutdown" },
      ];

      const out = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
        const child = spawn(process.execPath, [CLI_PATH, "mcp"], {
          env,
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
