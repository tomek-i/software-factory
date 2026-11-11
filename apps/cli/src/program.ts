import { Command } from "commander";
import { runInit } from "./commands/init.js";

export function buildProgram(): Command {
  const program = new Command()
    .name("factory")
    .description("AI software factory: turns GitHub issues into reviewed, tested pull requests")
    .version("0.0.0");

  program
    .command("init")
    .description("set up the factory in the current git repository")
    .action(() => {
      console.log(runInit(process.cwd()));
    });

  return program;
}
