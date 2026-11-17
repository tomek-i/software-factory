import { readFileSync } from "node:fs";
import { styleText, stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./program.js";

const paint = (format: Parameters<typeof styleText>[0], text: string) => styleText(format, text, { validateStream: false });

describe("buildProgram", () => {
  it("reports the release version that release-please writes to the root package.json", () => {
    const root = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(buildProgram().version()).toBe(root.version);
  });
});

describe("help", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const help = (name?: string) => {
    const program = buildProgram();
    return (name ? program.commands.find((c) => c.name() === name)! : program).helpInformation();
  };

  it("colours titles, command names and option flags when colour is forced, and leaves descriptions plain", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    const root = help();
    expect(root).toContain(paint("bold", "Usage:"));
    expect(root).toContain(paint("bold", "Commands:"));
    expect(root).toContain(paint("cyan", "status"));
    expect(root).toContain(paint("green", "-V, --version"));
    expect(root).toContain("output the version number\n");
    const status = help("status");
    expect(status).toContain(paint("green", "-a, --all"));
    expect(status).toContain("include finished runs");
    expect(help("show")).toContain(paint("green", "<run>"));
  });

  it("is the same text with colour off, and has no escape codes", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    const coloured = [help(), help("status"), help("lessons")];
    vi.stubEnv("FORCE_COLOR", "0");
    const plain = [help(), help("status"), help("lessons")];
    expect(plain).toEqual(coloured.map((text) => stripVTControlCharacters(text)));
    for (const text of plain) expect(text).not.toContain("\x1b[");
    expect(plain[0]).toMatch(/^Usage: factory \[options\] \[command\]\n/);
  });

  it("follows NO_COLOR", () => {
    vi.stubEnv("FORCE_COLOR", undefined);
    vi.stubEnv("NO_COLOR", "1");
    expect(help()).not.toContain("\x1b[");
  });
});

describe("commander's errors", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** What commander writes to stderr for these arguments; it exits the process, so exit throws instead. */
  async function stderrOf(args: string[]): Promise<string> {
    let written = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written += String(chunk);
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    await expect(buildProgram().parseAsync(["node", "factory", ...args])).rejects.toThrow(/^exit 1$/);
    return written;
  }

  it("colours the error label and suggests the closest command when colour is forced", async () => {
    vi.stubEnv("FORCE_COLOR", "1");
    const text = await stderrOf(["stauts"]);
    expect(text).toBe(`${paint("red", "error:")} unknown command 'stauts'\n(Did you mean status?)\n`);
  });

  it("colours the label of a subcommand's error too", async () => {
    vi.stubEnv("FORCE_COLOR", "1");
    const label = paint("red", "error:");
    expect((await stderrOf(["status", "--bogus"])).split("\n")[0]).toBe(`${label} unknown option '--bogus'`);
    expect((await stderrOf(["show"])).split("\n")[0]).toBe(`${label} missing required argument 'run'`);
  });

  it("is plain text with colour off", async () => {
    vi.stubEnv("FORCE_COLOR", "0");
    expect(await stderrOf(["stauts"])).toBe("error: unknown command 'stauts'\n(Did you mean status?)\n");
  });
});
