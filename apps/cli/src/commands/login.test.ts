import { describe, expect, it } from "vitest";
import { NotSignedInError } from "@factory/core";
import { CliError } from "../context.js";
import { runLogin } from "./login.js";

describe("factory login", () => {
  it("signs in to GitHub and says where the session is kept", async () => {
    const said: string[] = [];
    const out = await runLogin("github", {
      login: async (options) => {
        options?.onWaiting?.();
        return "alice";
      },
      say: (line) => said.push(line),
    });
    expect(out).toContain("Signed in to GitHub as alice.");
    expect(out).toMatch(/github-browser: it gives access to your GitHub account/);
    expect(said).toEqual(["Sign in to GitHub in the browser window that opened (waiting up to 15 minutes)..."]);
  });

  it("says what happens when nobody signs in, the browser cannot open or the service is unknown", async () => {
    const nobody = async () => {
      throw new NotSignedInError();
    };
    await expect(runLogin("github", { login: nobody })).rejects.toThrow(/Nobody signed in to GitHub, so PR media stays in draft releases/);
    const broken = async () => {
      throw new Error("Executable doesn't exist at /x/chrome\nmore");
    };
    await expect(runLogin("github", { login: broken })).rejects.toThrow("Could not open the browser: Executable doesn't exist at /x/chrome");
    await expect(runLogin("gitlab")).rejects.toBeInstanceOf(CliError);
  });
});
