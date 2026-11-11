import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runIssues, runQueue, runSync } from "./commands/issues.js";

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

  program
    .command("sync")
    .description("pull open issues from GitHub into the local database")
    .action(() => {
      console.log(runSync(process.cwd()));
    });

  program
    .command("issues")
    .description("list synced issues")
    .option("-q, --queued", "only issues queued for the factory")
    .option("-a, --all", "include closed issues")
    .action((options: { queued?: boolean; all?: boolean }) => {
      console.log(runIssues(process.cwd(), options));
    });

  program
    .command("queue")
    .description("queue issues for the factory to work on")
    .argument("<numbers...>", "issue numbers, e.g. 12 15 #18")
    .action((numbers: string[]) => {
      console.log(runQueue(process.cwd(), numbers, true));
    });

  program
    .command("unqueue")
    .description("remove issues from the factory's queue")
    .argument("<numbers...>", "issue numbers")
    .action((numbers: string[]) => {
      console.log(runQueue(process.cwd(), numbers, false));
    });

  return program;
}
