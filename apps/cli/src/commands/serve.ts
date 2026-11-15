import { openRegisteredProject, ServiceError } from "@factory/core";
import { startServe, type ServeDeps, type ServeOptions } from "@factory/server";
import { CliError } from "../context.js";
import { refuseRunningOnItself } from "../self.js";
import { plain, type Style } from "../style.js";
import { describeSchedulerEvent } from "./work.js";

export function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new CliError(`--port must be a port number from 1 to 65535, not "${value}"`);
  return n;
}

/**
 * `factory serve`: the web app, with the scheduler working through every project's queue as
 * `factory work` does. Resolves with the last line to print once stopped.
 */
export async function runServe(options: ServeOptions, deps: ServeDeps & { style?: Style } = {}): Promise<{ message: string; interrupted: boolean }> {
  const style = deps.style ?? plain;
  const print = deps.print ?? console.log;
  const openProject = deps.openProject ?? openRegisteredProject;
  try {
    return await startServe(options, {
      ...deps,
      print,
      // Checked on every open, not only at start: a project can be registered while it runs.
      openProject: (entry) => {
        refuseRunningOnItself(entry.path);
        return openProject(entry);
      },
      onEvent: (event) => {
        const line = describeSchedulerEvent(event, style);
        if (line) print(line);
      },
    });
  } catch (err) {
    if (err instanceof ServiceError) throw new CliError(err.message);
    throw err;
  }
}
