import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildCloudflareArgs, extractCloudflareUrl, startCloudflare } from "./cloudflare.js";
import {
  buildNgrokArgs,
  ensureNgrokAvailable,
  extractNgrokUrl,
  startNgrok,
  stopNgrokProcess,
  type TunnelCommandRunner as NgrokCommandRunner,
  type TunnelChildProcess as NgrokChildProcess,
  type TunnelSpawner as NgrokSpawner,
} from "./tunnel.js";

class MockNgrokChild extends EventEmitter {
  pid = 12345;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedWith: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
    return true;
  }
}

function createSpawner(child: MockNgrokChild, calls: string[][] = []): NgrokSpawner {
  return (args: string[]) => {
    calls.push(args);
    return child as unknown as NgrokChildProcess;
  };
}

describe("ngrok", () => {
  describe("ensureNgrokAvailable", () => {
    it("checks the ngrok CLI version", () => {
      const calls: string[][] = [];
      const runner: NgrokCommandRunner = (args) => {
        calls.push(args);
        return { status: 0, stdout: "ngrok version 3.0.0", stderr: "" };
      };

      expect(() => ensureNgrokAvailable(runner)).not.toThrow();
      expect(calls).toEqual([["version"]]);
    });

    it("throws an install hint when the ngrok CLI is missing", () => {
      const error = Object.assign(new Error("spawn ngrok ENOENT"), { code: "ENOENT" });
      const runner: NgrokCommandRunner = () => ({
        status: null,
        stdout: "",
        stderr: "",
        error,
      });

      expect(() => ensureNgrokAvailable(runner)).toThrow("ngrok CLI not found");
    });

    it("throws command output when the version check fails", () => {
      const runner: NgrokCommandRunner = () => ({
        status: 1,
        stdout: "",
        stderr: "permission denied",
      });

      expect(() => ensureNgrokAvailable(runner)).toThrow("permission denied");
    });
  });

  describe("buildNgrokArgs", () => {
    it("forwards HTTP traffic to the local app port with host rewriting", () => {
      expect(buildNgrokArgs(4123)).toEqual([
        "http",
        "--log=stdout",
        "--log-format=logfmt",
        "--host-header=rewrite",
        "http://127.0.0.1:4123",
      ]);
    });

    it("uses the requested upstream host header", () => {
      expect(buildNgrokArgs(4123, "myapp.localhost")).toEqual([
        "http",
        "--log=stdout",
        "--log-format=logfmt",
        "--host-header=myapp.localhost",
        "http://127.0.0.1:4123",
      ]);
    });
  });

  describe("extractNgrokUrl", () => {
    it("extracts the public URL from text output", () => {
      const output = "Forwarding https://abc123.ngrok.app -> http://127.0.0.1:4123";
      expect(extractNgrokUrl(output)).toBe("https://abc123.ngrok.app");
    });

    it("extracts the public URL from structured log output", () => {
      const output =
        't=2026-06-04 lvl=info msg="started tunnel" obj=tunnels url=https://abc123.ngrok-free.app';
      expect(extractNgrokUrl(output)).toBe("https://abc123.ngrok-free.app");
    });

    it("ignores ngrok docs URLs from errors", () => {
      const output = "ERROR see https://ngrok.com/docs/errors/err_ngrok_4018";
      expect(extractNgrokUrl(output)).toBeNull();
    });
  });

  describe("startNgrok", () => {
    it("spawns ngrok and resolves with the public URL", async () => {
      const child = new MockNgrokChild();
      const calls: string[][] = [];
      const promise = startNgrok(4123, {
        spawner: createSpawner(child, calls),
        timeoutMs: 1000,
      });

      child.stdout.write("Forwarding https://abc123.ngrok.app -> http://127.0.0.1:4123\n");

      await expect(promise).resolves.toMatchObject({
        url: "https://abc123.ngrok.app",
        pid: 12345,
      });
      expect(calls).toEqual([
        [
          "http",
          "--log=stdout",
          "--log-format=logfmt",
          "--host-header=rewrite",
          "http://127.0.0.1:4123",
        ],
      ]);
    });

    it("notifies when ngrok exits after startup", async () => {
      const child = new MockNgrokChild();
      const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
      const promise = startNgrok(4123, {
        onExit: (code, signal) => exits.push({ code, signal }),
        spawner: createSpawner(child),
        timeoutMs: 1000,
      });

      child.stdout.write("Forwarding https://abc123.ngrok.app -> http://127.0.0.1:4123\n");

      await expect(promise).resolves.toMatchObject({
        url: "https://abc123.ngrok.app",
      });
      child.emit("exit", 0, null);
      expect(exits).toEqual([{ code: 0, signal: null }]);
    });

    it("throws an install hint when the ngrok CLI is missing", async () => {
      const error = Object.assign(new Error("spawn ngrok ENOENT"), { code: "ENOENT" });
      const spawner: NgrokSpawner = () => {
        throw error;
      };

      await expect(startNgrok(4123, { spawner })).rejects.toThrow("ngrok CLI not found");
    });

    it("throws an auth hint when ngrok exits with auth output", async () => {
      const child = new MockNgrokChild();
      const promise = startNgrok(4123, {
        spawner: createSpawner(child),
        timeoutMs: 1000,
      });

      child.stderr.write("ERROR authtoken is required\n");
      child.emit("exit", 1, null);

      await expect(promise).rejects.toThrow("authentication is not configured");
    });

    it("kills ngrok when no public URL appears before the timeout", async () => {
      const child = new MockNgrokChild();
      const promise = startNgrok(4123, {
        spawner: createSpawner(child),
        timeoutMs: 1,
      });

      await expect(promise).rejects.toThrow("Timed out waiting for ngrok");
      expect(child.killedWith).toBe("SIGTERM");
    });
  });

  describe("stopNgrokProcess", () => {
    it("terminates the child process", () => {
      const child = new MockNgrokChild();
      stopNgrokProcess(child as unknown as NgrokChildProcess);
      expect(child.killedWith).toBe("SIGTERM");
    });
  });
});

const DISCLAIMER =
  "2026-10-16T12:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms.\n";
const BANNER =
  "2026-10-16T12:00:01Z INF |  https://example-words-abcd.trycloudflare.com                                          |\n";
const REGISTERED =
  "2026-10-16T12:00:02Z INF Registered tunnel connection connIndex=0 connection=8a1f location=sjc01 protocol=quic\n";
const QUICK_URL = "https://example-words-abcd.trycloudflare.com";

describe("cloudflare", () => {
  it("builds a quick tunnel command that ignores the user config", () => {
    expect(buildCloudflareArgs(4123, "myapp.localhost", "/s/cloudflared.yml")).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--grace-period",
      "1s",
      "--config",
      "/s/cloudflared.yml",
      "--url",
      "http://127.0.0.1:4123",
      "--http-host-header",
      "myapp.localhost",
    ]);
  });

  it("reports the URL only once a connection is registered", () => {
    expect(extractCloudflareUrl(DISCLAIMER + BANNER)).toBeNull();
    expect(extractCloudflareUrl(DISCLAIMER + BANNER + REGISTERED)).toBe(QUICK_URL);
    expect(extractCloudflareUrl("https://api.trycloudflare.com\n" + REGISTERED)).toBeNull();
    const older = "INF Connection 4b2f8c1e-0d3a-4e5f-9a7b-1c2d3e4f5a6b registered connIndex=0\n";
    expect(extractCloudflareUrl(BANNER + older)).toBe(QUICK_URL);
  });

  it("writes an empty config and resolves once connected", async () => {
    const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "portless-cf-")), "c.yml");
    const child = new MockNgrokChild();
    const promise = startCloudflare(4123, {
      configPath,
      hostHeader: "myapp.localhost",
      spawner: createSpawner(child),
      timeoutMs: 1000,
    });
    expect(fs.readFileSync(configPath, "utf-8")).toBe("{}");
    child.stderr.write(DISCLAIMER + BANNER + REGISTERED);
    await expect(promise).resolves.toMatchObject({ url: QUICK_URL, pid: 12345 });
  });

  it("reports ERR lines, or a generic message, when cloudflared exits early", async () => {
    const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "portless-cf-")), "c.yml");
    const start = (output: string) => {
      const child = new MockNgrokChild();
      const promise = startCloudflare(4123, { configPath, spawner: createSpawner(child) });
      child.stderr.write(output);
      child.emit("exit", 1, null);
      return promise.catch((err: Error) => err.message);
    };
    const err = "2026-10-16T12:00:01Z ERR failed to request quick Tunnel: dial tcp: i/o timeout\n";
    const message = await start(DISCLAIMER + err);
    expect(message).toContain("ERR failed to request quick Tunnel: dial tcp: i/o timeout");
    expect(message).not.toContain("Thank you for trying");
    expect(message).toMatch(/ \(exit 1\)$/);
    expect(await start(DISCLAIMER)).toBe(
      "Failed to start Cloudflare tunnel: cloudflared exited before connecting (exit 1)"
    );
  });
});
