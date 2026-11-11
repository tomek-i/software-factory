import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runIssues, runQueue, runSync } from "./commands/issues.js";
import { runLessons, runLessonsApprove, runLessonsReject } from "./commands/lessons.js";
import { runApprove, runCancel, runLogs, runReject, runResume, runRun, runStatus } from "./commands/runs.js";
import { runShow } from "./commands/show.js";
import { styleFor } from "./style.js";

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
      console.log(await runRun(process.cwd(), issues, options, { style: styleFor(process.stdout) }));
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
      const text = runShow(process.cwd(), ref, file);
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    });

  program
    .command("approve")
    .description("let a run waiting at a gate continue, and keep running it")
    .argument("<run>", "run id, id prefix, or issue number")
    .option("-m, --message <text>", "why (stored with the decision)")
    .option("--no-run", "only record the approval; continue later with `factory run`")
    .action(async (ref: string, options: { message?: string; run: boolean }) => {
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
      console.log(await runResume(process.cwd(), ref, options, { style: styleFor(process.stdout) }));
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
    .description("stop a run and its agent; the worktree is kept")
    .argument("<run>", "run id, id prefix, or issue number")
    .option("-m, --message <text>", "why (stored with the decision)")
    .action((ref: string, options: { message?: string }) => {
      console.log(runCancel(process.cwd(), ref, options));
    });

  return program;
}
