import { githubProfileDir, loginGithub, NotSignedInError } from "@factory/core";
import { CliError } from "../context.js";

export interface LoginDeps {
  login?: typeof loginGithub;
  /** Where the "waiting for you" line goes; the result goes to stdout. */
  say?: (line: string) => void;
}

/**
 * `factory login github`: sign in to GitHub once in the factory's own browser profile, so the engine
 * can attach screenshots and videos to its PRs. Run again to check who is signed in.
 */
export async function runLogin(service: string, deps: LoginDeps = {}): Promise<string> {
  if (service !== "github") throw new CliError(`Unknown service "${service}". Only \`factory login github\` is supported.`);
  const login = deps.login ?? loginGithub;
  const say = deps.say ?? ((line: string) => console.error(line));
  try {
    const user = await login({ onWaiting: () => say("Sign in to GitHub in the browser window that opened (waiting up to 15 minutes)...") });
    return [
      `Signed in to GitHub as ${user}. The factory now attaches screenshots and videos to its PRs.`,
      `The session is kept in ${githubProfileDir()}: it gives access to your GitHub account, so keep that folder private.`,
    ].join("\n");
  } catch (err) {
    if (err instanceof NotSignedInError) throw new CliError("Nobody signed in to GitHub, so PR media stays in draft releases (maintainers only). Run `factory login github` again to retry.");
    throw new CliError(`Could not open the browser: ${(err as Error).message.split("\n")[0]}`);
  }
}
