import { ghPort, publishLessons, type CommandRunner, type PublishedLessons, type GithubPort, type Project, type StoredLesson, type Store } from "@factory/core";
import { isUnprintable } from "@factory/shared";
import { CliError, withProject } from "../context.js";

export interface LessonDeps {
  run?: CommandRunner;
  github?: GithubPort;
  now?: Date;
}

/** Lesson ids from the command line: whole numbers, each once. */
function parseIds(values: string[]): number[] {
  const ids = values.map((value) => {
    const id = Number(value.replace(/^#/, ""));
    if (!Number.isInteger(id) || id <= 0) throw new CliError(`"${value}" is not a lesson id; see \`factory lessons\`.`);
    return id;
  });
  return [...new Set(ids)];
}

/** The project's proposed lessons with these ids, or a CliError naming every one that is not. */
function proposedLessons(store: Store, project: Project, ids: number[]): StoredLesson[] {
  const problems: string[] = [];
  const lessons = ids.flatMap((id) => {
    const lesson = store.getLesson(id);
    if (!lesson || lesson.project_id !== project.id) problems.push(`No lesson ${id}.`);
    else if (lesson.status !== "proposed") problems.push(`Lesson ${id} is already ${lesson.status}.`);
    else return [lesson];
    return [];
  });
  if (problems.length) throw new CliError(`${problems.join("\n")}\nSee \`factory lessons --all\`.`);
  return lessons;
}

/**
 * Text written by an agent, made safe to print: whitespace runs become one space, and control and
 * invisible-direction characters are shown as `[U+001B]`, so a terminal escape cannot hide or reorder
 * what the human approving a lesson reads.
 */
export function printable(text: string): string {
  return Array.from(text.replace(/\s+/g, " ").trim(), (ch) => {
    const code = ch.codePointAt(0)!;
    return isUnprintable(code) ? `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]` : ch;
  }).join("");
}

function describeLesson(store: Store, lesson: StoredLesson): string {
  const issue = store.getRun(lesson.run_id)?.issue_number;
  const status =
    lesson.status === "approved" && lesson.pull_request !== null
      ? `approved (PR #${lesson.pull_request})`
      : lesson.status === "rejected" && lesson.comment
        ? `rejected: ${printable(lesson.comment)}`
        : lesson.status;
  return [
    `${lesson.id}  ${status}  ${lesson.run_id}${issue ? ` (#${issue})` : ""}`,
    `    rule:      ${printable(lesson.rule)}`,
    `    observed:  ${printable(lesson.observation)}`,
    `    evidence:  ${printable(lesson.evidence)}`,
  ].join("\n");
}

/** `factory lessons`: the lessons waiting for a decision; with --all, every lesson. */
export function runLessons(cwd: string, options: { all?: boolean } = {}, run?: CommandRunner): string {
  return withProject(
    cwd,
    ({ store, project }) => {
      const lessons = store.listLessons({ project_id: project.id, status: options.all ? undefined : "proposed" });
      if (lessons.length === 0) return options.all ? "No lessons yet." : "No lessons waiting. `factory lessons --all` shows decided ones.";
      const waiting = lessons.some((l) => l.status === "proposed");
      return [
        ...lessons.map((l) => describeLesson(store, l)),
        ...(waiting ? ['Approve with `factory lessons approve <id...>`, or reject with `factory lessons reject <id...> -m "<why>"`.'] : []),
      ].join("\n\n");
    },
    run,
  );
}

/**
 * `factory lessons approve <id...>`: one PR that appends these lessons to `.factory/lessons.md` (the
 * lessons PR still open, if there is one). They are marked approved only once they are on that PR,
 * and agents see them once it is merged.
 */
export function runLessonsApprove(cwd: string, values: string[], deps: LessonDeps = {}): string {
  const ids = parseIds(values);
  return withProject(
    cwd,
    ({ store, project, config }) => {
      const lessons = proposedLessons(store, project, ids);
      const defaultBranch = config.project.default_branch;
      const withIssue = (l: StoredLesson) => ({ ...l, issue_number: store.getRun(l.run_id)?.issue_number });
      let published: PublishedLessons;
      try {
        published = publishLessons({
          root: project.repo_path,
          defaultBranch,
          lessons: lessons.map(withIssue),
          github: deps.github ?? ghPort(project, deps.run),
          inPullRequest: (number) =>
            store
              .listLessons({ project_id: project.id, status: "approved" })
              .filter((l) => l.pull_request === number)
              .map(withIssue),
          run: deps.run,
          now: deps.now,
        });
      } catch (err) {
        throw new CliError(`Could not publish the lessons; nothing was approved: ${(err as Error).message}`);
      }
      try {
        store.decideLessons(ids, "approved", { pull_request: published.number });
      } catch (err) {
        throw new CliError(`Pushed the lessons to PR #${published.number}, but could not record the approval: ${(err as Error).message}`);
      }
      const url = project.github_repo ? ` https://github.com/${project.github_repo}/pull/${published.number}` : "";
      const which = ids.length === 1 ? `lesson ${ids[0]}` : `lessons ${ids.join(", ")}`;
      const them = ids.length === 1 ? "it" : "them";
      return [
        published.addedToOpen
          ? `Approved ${which}. Added ${them} to the open lessons PR #${published.number}:${url}`
          : `Approved ${which}. PR #${published.number} adds ${them} to .factory/lessons.md:${url}`,
        `Agents read lessons from ${defaultBranch}, so ${ids.length === 1 ? "it applies" : "they apply"} to runs that start after the PR is merged.`,
        ...(published.warning ? [`Warning: ${published.warning}`] : []),
      ].join("\n");
    },
    deps.run,
  );
}

/** `factory lessons reject <id...> [-m why]`: the lessons are kept, marked rejected, and never applied. */
export function runLessonsReject(cwd: string, values: string[], options: { message?: string } = {}, run?: CommandRunner): string {
  const ids = parseIds(values);
  return withProject(
    cwd,
    ({ store, project }) => {
      proposedLessons(store, project, ids);
      store.decideLessons(ids, "rejected", { comment: options.message?.trim() || undefined });
      return `Rejected ${ids.length === 1 ? `lesson ${ids[0]}` : `lessons ${ids.join(", ")}`}.`;
    },
    run,
  );
}

/** The `factory status` note when lessons wait for a decision. */
export function lessonsNote(store: Store, project: Project): string | undefined {
  const count = store.listLessons({ project_id: project.id, status: "proposed" }).length;
  return count ? `${count} lesson${count > 1 ? "s" : ""} waiting: \`factory lessons\`` : undefined;
}
