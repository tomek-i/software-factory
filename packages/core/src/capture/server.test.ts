import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../../test/helpers.js";
import { isAlive } from "../util/process.js";
import { appEnv, AppStartError, appUrl, freePort, startApp } from "./server.js";

// A tiny app: writes its own pid (the server process, not the shell around it), answers with
// which of the variables the test sets it can see, and listens on $PORT, unless told not to.
const APP_JS = `const fs = require("fs");
fs.writeFileSync("pid.txt", String(process.pid));
if (process.argv[2] === "exit") process.exit(3);
if (process.argv[2] === "silent") setInterval(() => {}, 1000);
else require("http").createServer((req, res) => {
  const seen = (name) => name in process.env;
  res.end(JSON.stringify({ port: process.env.PORT, gh: seen("GH_TOKEN"), anthropic: seen("ANTHROPIC_API_KEY"), personal: seen("FACTORY_TEST_PERSONAL"), passed: seen("FACTORY_TEST_PASSED") }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

function app(mode = "") {
  const dir = tempDir("factory-app-");
  writeFileSync(join(dir, "app.js"), APP_JS);
  return { dir, command: `"${process.execPath}" app.js ${mode}`.trim(), pid: () => Number(readFileSync(join(dir, "pid.txt"), "utf8")) };
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !isAlive(pid);
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("startApp", () => {
  it("starts the app on the port with only the allowed env, and kills its whole tree when stopped", async () => {
    process.env.GH_TOKEN = "secret";
    process.env.ANTHROPIC_API_KEY = "secret";
    process.env.FACTORY_TEST_PERSONAL = "the user's own";
    process.env.FACTORY_TEST_PASSED = "wanted by the app";
    const { dir, command, pid } = app();
    const port = await freePort();
    const server = await startApp({
      command,
      cwd: dir,
      port,
      portEnv: "PORT",
      // A token asked for by name is still not passed.
      passEnv: ["FACTORY_TEST_PASSED", "GH_TOKEN"],
      url: appUrl("http://127.0.0.1:{port}/", port),
      logFile: join(dir, "logs", "server.log"),
      timeoutMs: 30_000,
      pollMs: 50,
    });

    expect(server.url).toBe(`http://127.0.0.1:${port}/`);
    expect(await (await fetch(server.url)).json()).toEqual({ port: String(port), gh: false, anthropic: false, personal: false, passed: true });
    const serverPid = pid();
    expect(isAlive(serverPid)).toBe(true);

    // A second stop waits for the first, so neither returns while the server still runs.
    await Promise.all([server.stop(), server.stop().then(() => expect(isAlive(server.pid)).toBe(false))]);
    await server.stop();
    expect(await gone(serverPid)).toBe(true);
    expect(await gone(server.pid)).toBe(true);
    await expect(fetch(server.url)).rejects.toThrow();
  });

  it("gives up when the URL never answers, and leaves nothing running", async () => {
    const { dir, command, pid } = app("silent");
    const port = await freePort();
    const started = startApp({ command, cwd: dir, port, portEnv: "PORT", url: appUrl("http://127.0.0.1:{port}", port), logFile: join(dir, "server.log"), timeoutMs: 1500, pollMs: 50 });
    await expect(started).rejects.toThrow(/did not answer within 2s/);
    await expect(started).rejects.toBeInstanceOf(AppStartError);
    expect(existsSync(join(dir, "pid.txt"))).toBe(true);
    expect(await gone(pid())).toBe(true);
  });

  it("reports an app that exits before it answers, with the end of its output", async () => {
    const { dir } = app();
    const port = await freePort();
    const command = `"${process.execPath}" -e "console.log('missing env file'); process.exit(3)"`;
    await expect(
      startApp({ command, cwd: dir, port, portEnv: "PORT", url: appUrl("http://127.0.0.1:{port}", port), logFile: join(dir, "server.log"), timeoutMs: 30_000, pollMs: 50 }),
    ).rejects.toThrow(/exited \(code 3\) before [\s\S]*missing env file/);
  });

  it("stops waiting and kills the app when cancelled", async () => {
    const { dir, command, pid } = app("silent");
    const port = await freePort();
    const controller = new AbortController();
    const started = startApp({ command, cwd: dir, port, portEnv: "PORT", url: appUrl("http://127.0.0.1:{port}", port), logFile: join(dir, "server.log"), timeoutMs: 30_000, pollMs: 50, signal: controller.signal });
    for (let i = 0; i < 100 && !existsSync(join(dir, "pid.txt")); i++) await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await expect(started).rejects.toThrow(/cancelled/);
    expect(await gone(pid())).toBe(true);
  });
});

describe("appEnv", () => {
  it("keeps what a shell and Node need, the names asked for and the port, never a token", () => {
    const env = { Path: "C:\\bin", SystemRoot: "C:\\Windows", APPDATA: "x", HOME: "/h", GH_TOKEN: "t", github_token: "t", AWS_SECRET_ACCESS_KEY: "s", DATABASE_URL: "d", PORT: "1" };
    expect(appEnv(env, "APP_PORT", 4701, ["DATABASE_URL", "GH_TOKEN"])).toEqual({
      Path: "C:\\bin",
      SystemRoot: "C:\\Windows",
      APPDATA: "x",
      HOME: "/h",
      DATABASE_URL: "d",
      APP_PORT: "4701",
      BROWSER: "none",
    });
  });
});

describe("freePort", () => {
  const listen = (port: number) =>
    new Promise<Server>((resolve) => {
      const server = createServer();
      server.listen({ port, host: "127.0.0.1" }, () => resolve(server));
    });

  it("takes the first free port of the run's block, or any free one when they are all taken", async () => {
    const busy = await listen(0);
    const port = (busy.address() as { port: number }).port;
    try {
      const next = await freePort([port, port + 1]);
      expect(next).not.toBe(port);
      expect(await freePort([port])).not.toBe(port);
      expect(await freePort()).toBeGreaterThan(0);
    } finally {
      busy.close();
    }
  });
});

describe("appUrl", () => {
  it("fills in the port", () => {
    expect(appUrl("http://localhost:{port}/app?p={port}", 4701)).toBe("http://localhost:4701/app?p=4701");
  });
});
