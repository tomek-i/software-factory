import { Command, Option, type HelpConfiguration } from "commander";
import { DEFAULT_MAX_RUNS } from "@factory/core";
import { DEFAULT_PORT } from "@factory/server";
import { runChecksList, runDismiss } from "./commands/checks.js";
import { runCleanup } from "./commands/cleanup.js";
import { runConfigReset } from "./commands/config.js";
import { runInit } from "./commands/init.js";
import { runIssues, runQueue, runSync } from "./commands/issues.js";
import { runLessons, runLessonsApprove, runLessonsReject } from "./commands/lessons.js";
import { runLogin } from "./commands/login.js";
import { runNew, type NewOptions } from "./commands/new.js";
import { runProjects, runProjectsRemove } from "./commands/projects.js";
import { runApprove, runCancel, runLogs, runReject, runResume, runRun, runStatus } from "./commands/runs.js";
import { parsePort, runServe } from "./commands/serve.js";
import { runShow } from "./commands/show.js";
import { runExport, runImport } from "./commands/snapshot.js";
import { runListLeases, runUpgrade } from "./commands/upgrade.js";
import { parseMaxRuns, refuseRunningOnAnyProject, runStop, runWork } from "./commands/work.js";
import { refuseRunningOnItself } from "./self.js";
import { colourEnabled, createStyle, styleFor, type Style } from "./style.js";

/** How help looks: titles, command names and option flags styled, descriptions plain. */
export function helpStyle(style: Style): HelpConfiguration {
  return {
    styleTitle: (text) => style.title(text),
    styleCommandText: (text) => style.command(text),
    styleSubcommandText: (text) => style.command(text),
    styleOptionText: (text) => style.option(text),
    styleArgumentText: (text) => style.option(text),
  };
}

/** An error message with its leading `error:` label styled, as `main.ts` prints the factory's own errors. */
export function styleError(message: string, style: Style): string {
  return message.replace(/^error:/, (label) => style.error(label));
}

export function buildProgram(): Command {
  const program = new Command()
    .name("factory")
    .description("AI software factory: turns GitHub issues into reviewed, tested pull requests")
    .version("0.6.0"); // x-release-please-version (release-please bumps it on each release)

  // Set before any subcommand is added: commander copies these settings to each subcommand it creates.
  program
    .configureOutput({
      // Commander's own test ignores NODE_DISABLE_COLORS and TERM=dumb; ask the one the commands use.
      getOutHasColors: () => colourEnabled(process.stdout),
      getErrHasColors: () => colourEnabled(process.stderr),
      outputError: (message, write) => write(styleError(message, styleFor(process.stderr))),
    })
    // Help is always painted: commander strips the codes when its stream gets no colour, so plain help is unchanged.
    .configureHelp(helpStyle(createStyle(true)))
    .showSuggestionAfterError();

  program
    .command("init")
    .description("set up the factory in the current git repository")
    .action(() => {
      console.log(runInit(process.cwd()));
    });

  const config = program.command("config").description("manage .factory/config.yaml");

  config
    .command("reset")
    .description("take settings out of .factory/config.yaml so the factory's defaults apply to them")
    .argument("[settings...]", "sections or dotted entries, e.g. models or models.roles.builder")
    .option("--all", "reset everything except project, checks, app and trust")
    .action((settings: string[], options: { all?: boolean }) => {
      console.log(runConfigReset(process.cwd(), settings, options));
    });

  const projects = program
    .command("projects")
    .description("list the repositories the factory manages (added by `factory init`)")
    .action(() => {
      console.log(runProjects({}, styleFor(process.stdout)));
    });

  projects
    .command("remove")
    .description("drop a repository from the list; the repository and its database are untouched")
    .argument("<path>", "the repository's folder")
    .action((path: string) => {
      console.log(runProjectsRemove(process.cwd(), path));
    });

  program
    .command("login")
    .description("sign in to GitHub in the factory's browser, so it can attach screenshots and videos to PRs")
    .argument("<service>", "github")
    .action(async (service: string) => {
      console.log(await runLogin(service));
    });

  program
    .command("sync")
    .description("pull open issues from GitHub into the local database")
    .action(() => {
      console.log(runSync(process.cwd()));
    });

  program
    .command("export")
    .description("write this project's local state (queue, finished runs, lessons, drafts) as JSON, to move it to another machine")
    .argument("[file]", "where to write it, outside the repo (default: stdout)")
    .action((file: string | undefined) => {
      const text = runExport(process.cwd(), file);
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    });

  program
    .command("import")
    .description("merge a snapshot from `factory export` into this project's local state")
    .argument("<file>", "the snapshot; only import your own")
    .option("--dry-run", "list what would be added or changed, write nothing")
    .action((file: string, options: { dryRun?: boolean }) => {
      console.log(runImport(process.cwd(), file, options));
    });

  program
    .command("new")
    .description("draft a GitHub issue from an idea, and create it once approved")
    .argument("[idea...]", 'the idea, e.g. "export orders as CSV"')
    .option("--approve <draft>", "create a saved draft on GitHub")
    .option("--discard <draft>", "drop a saved draft")
    .option("--list", "list drafts waiting for approval")
    .option("--queue", "queue the created issues for the factory to work on")
    .action(async (idea: string[], options: NewOptions) => {
      // Drafting runs the issue writer agent in the checkout; the other options only handle saved drafts.
      if (!options.approve && !options.discard && !options.list) refuseRunningOnItself(process.cwd());
      console.log(await runNew(process.cwd(), idea, options, { style: styleFor(process.stdout) }));
    });

  program
    .command("issues")
    .description("list synced issues")
    .option("-q, --queued", "only issues queued for the factory")
    .option("-a, --all", "include closed issues")
    .action((options: { queued?: boolean; all?: boolean }) => {
      console.log(runIssues(process.cwd(), options, undefined, styleFor(process.stdout)));
    });

  program
    .command("queue")
    .description("queue issues for the factory to work on")
    .argument("<numbers...>", "issue numbers, e.g. 12 15 18")
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

  program
    .command("run")
    .description("run issues through the pipeline until they need you, several at once (syncs and queues them first if needed)")
    .argument("<issues...>", "issue numbers, e.g. 12 15")
    .option("--unsafe", "lift hard rules for these runs only (untrusted authors still wait for you)")
    .action(async (issues: string[], options: { unsafe?: boolean }) => {
      refuseRunningOnItself(process.cwd());
      console.log(await runRun(process.cwd(), issues, options, { style: styleFor(process.stdout) }));
    });

  program
    .command("work")
    .description("work through the queues of every registered project until stopped: continue stopped runs, start queued issues")
    .option("--max-runs <n>", `runs at once, across projects (default ${DEFAULT_MAX_RUNS})`, parseMaxRuns)
    .action(async (options: { maxRuns?: number }) => {
      refuseRunningOnAnyProject();
      // Ctrl+C interrupts the runs (kills their agents, gives the leases back) so they can be continued.
      const interrupt = new AbortController();
      process.once("SIGINT", () => interrupt.abort());
      const { message } = await runWork(options, { style: styleFor(process.stdout), signal: interrupt.signal });
      console.log(message);
      // The interrupted drives are left behind, not awaited, so end the process here.
      process.exit(interrupt.signal.aborted ? 130 : 0);
    });

  program
    .command("serve")
    .description("open the web app on this machine, and work through the queues as `factory work` does")
    .option("--port <n>", `port on 127.0.0.1 (default ${DEFAULT_PORT})`, parsePort)
    .option("--max-runs <n>", `runs at once, across projects (default ${DEFAULT_MAX_RUNS})`, parseMaxRuns)
    .option("--no-open", "print the link without opening the browser")
    .action(async (options: { port?: number; maxRuns?: number; open: boolean }) => {
      refuseRunningOnAnyProject();
      const interrupt = new AbortController();
      process.once("SIGINT", () => interrupt.abort());
      const { message } = await runServe(options, { style: styleFor(process.stdout), signal: interrupt.signal });
      console.log(message);
      // As for `work`: interrupted drives are left behind, so end the process here.
      process.exit(interrupt.signal.aborted ? 130 : 0);
    });

  program
    .command("stop")
    .description("ask running `factory work` and `factory serve` processes to finish their runs and exit")
    .option("--now", "interrupt their runs instead (they can be continued later)")
    .action((options: { now?: boolean }) => {
      console.log(runStop(options));
    });

  program
    .command("status")
    .description("list runs")
    .option("-a, --all", "include finished runs")
    .action((options: { all?: boolean }) => {
      console.log(runStatus(process.cwd(), options, { style: styleFor(process.stdout) }));
    });

  program
    .command("logs")
    .description("show a run's events and agent logs")
    .argument("<run>", "run id, id prefix, or issue number")
    .option("-f, --follow", "keep printing until the run stops")
    .action(async (ref: string, options: { follow?: boolean }) => {
      console.log(await runLogs(process.cwd(), ref, options, { style: styleFor(process.stdout) }));
    });

  program
    .command("show")
    .description("show a run's overview and verdict summaries, or one file from its run folder")
    .argument("<run>", "run id, id prefix, or issue number")
    .argument("[file]", "file in the run folder, e.g. round-2/checks.md, or triage, build, checks (latest round)")
    .action((ref: string, file: string | undefined) => {
      const text = runShow(process.cwd(), ref, file, { style: styleFor(process.stdout) });
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    });

  program
    .command("approve")
    .description("let a run waiting at a gate continue, and keep running it")
    .argument("<run>", "run id, id prefix, or issue number")
    .option("-m, --message <text>", "why (stored with the decision)")
    .option("--no-run", "only record the approval; continue later with `factory run`")
    .action(async (ref: string, options: { message?: string; run: boolean }) => {
      if (options.run) refuseRunningOnItself(process.cwd());
      console.log(await runApprove(process.cwd(), ref, options, { style: styleFor(process.stdout) }));
    });

  program
    .command("reject")
    .description("end a run waiting at a gate")
    .argument("<run>", "run id, id prefix, or issue number")
    .requiredOption("-m, --message <text>", "why (required, stored with the decision)")
    .action((ref: string, options: { message: string }) => {
      console.log(runReject(process.cwd(), ref, options));
    });

  program
    .command("resume")
    .description("send a run that needs you back to a stage (e.g. after an escalation)")
    .argument("<run>", "run id, id prefix, or issue number")
    .requiredOption("--to <stage>", "stage to continue from, e.g. build")
    .requiredOption("-m, --message <text>", "why (required, stored with the decision)")
    .option("--reset-loops", "give the build and review loops a fresh budget")
    .option("--no-run", "only record the decision; continue later with `factory run`")
    .action(async (ref: string, options: { to: string; message: string; resetLoops?: boolean; run: boolean }) => {
      if (options.run) refuseRunningOnItself(process.cwd());
      console.log(await runResume(process.cwd(), ref, options, { style: styleFor(process.stdout) }));
    });

  program
    .command("checks")
    .description("list the required checks that failed on a run's PR, with their open code scanning alerts")
    .argument("<run>", "run id, id prefix, or issue number")
    .action((ref: string) => {
      console.log(runChecksList(process.cwd(), ref));
    });

  program
    .command("dismiss")
    .description("dismiss a code scanning alert that fails a run's required check (e.g. a false positive); the run goes back to merge once the check passes")
    .argument("<run>", "run id, id prefix, or issue number")
    .argument("<alert>", "alert number, as `factory checks` lists it")
    .requiredOption("--reason <reason>", "false-positive, wont-fix or used-in-tests")
    .requiredOption("-m, --message <text>", "why (required, sent to GitHub and stored with the decision)")
    .action((ref: string, alert: string, options: { reason: string; message: string }) => {
      console.log(runDismiss(process.cwd(), ref, alert, options));
    });

  const lessons = program
    .command("lessons")
    .description("list the lessons the learner proposed after runs; approve or reject them")
    .option("-a, --all", "include approved and rejected lessons")
    .action((options: { all?: boolean }) => {
      console.log(runLessons(process.cwd(), options));
    });

  lessons
    .command("approve")
    .description("append lessons to .factory/lessons.md through one pull request")
    .argument("<ids...>", "lesson ids, e.g. 3 4")
    .action((ids: string[]) => {
      console.log(runLessonsApprove(process.cwd(), ids));
    });

  lessons
    .command("reject")
    .description("reject lessons; they are never applied")
    .argument("<ids...>", "lesson ids")
    .option("-m, --message <text>", "why (stored with the lesson)")
    .action((ids: string[], options: { message?: string }) => {
      console.log(runLessonsReject(process.cwd(), ids, options));
    });

  program
    .command("cancel")
    .description("stop a run and its agent; its worktree is removed unless it holds unpushed work")
    .argument("<run>", "run id, id prefix, or issue number")
    .option("-m, --message <text>", "why (stored with the decision)")
    .action((ref: string, options: { message?: string }) => {
      console.log(runCancel(process.cwd(), ref, options));
    });

  program
    .command("cleanup")
    .description("remove the worktrees and branches of finished runs that still have them")
    .option("--dry-run", "list what would be removed and kept, change nothing")
    .action((options: { dryRun?: boolean }) => {
      console.log(runCleanup(process.cwd(), options));
    });

  program
    .command("upgrade")
    .description("install the latest published version of the factory, with the package manager that installed it")
    .option("--check", "only say whether a newer version is available")
    // Internal: `factory upgrade` reads the runs' leases through a child process (see leasesFromChild).
    .addOption(new Option("--list-leases").hideHelp())
    .action((options: { check?: boolean; listLeases?: boolean }) => {
      if (options.listLeases) return console.log(runListLeases());
      console.log(runUpgrade(options, { installed: program.version()! }));
    });

  return program;
}
