import { ghPort, publishLessons, type CommandRunner, type GithubPort, type Project, type StoredLesson, type Store } from "@factory/core";
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

function describeLesson(store: Store, lesson: StoredLesson): string {
  const issue = store.getRun(lesson.run_id)?.issue_number;
  const status =
    lesson.status === "approved" && lesson.pull_request !== null
      ? `approved (PR #${lesson.pull_request})`
      : lesson.status === "rejected" && lesson.comment
        ? `rejected: ${lesson.comment}`
        : lesson.status;
  return [
    `${lesson.id}  ${status}  ${lesson.run_id}${issue ? ` (#${issue})` : ""}`,
    `    rule:      ${lesson.rule}`,
    `    observed:  ${lesson.observation.replace(/\s+/g, " ").trim()}`,
    `    evidence:  ${lesson.evidence.replace(/\s+/g, " ").trim()}`,
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
 * `factory lessons approve <id...>`: open one PR that appends these lessons to `.factory/lessons.md`.
 * They are marked approved only once the PR exists, and agents see them once it is merged.
 */
export function runLessonsApprove(cwd: string, values: string[], deps: LessonDeps = {}): string {
  const ids = parseIds(values);
  return withProject(
    cwd,
    ({ store, project, config }) => {
      const lessons = proposedLessons(store, project, ids);
      const defaultBranch = config.project.default_branch;
      let published: { branch: string; number: number };
      try {
        published = publishLessons({
          root: project.repo_path,
          defaultBranch,
          lessons: lessons.map((l) => ({ ...l, issue_number: store.getRun(l.run_id)?.issue_number })),
          github: deps.github ?? ghPort(project, deps.run),
          run: deps.run,
          now: deps.now,
        });
      } catch (err) {
        throw new CliError(`Could not open the lessons PR; nothing was approved: ${(err as Error).message}`);
      }
      try {
        store.decideLessons(ids, "approved", { pull_request: published.number });
      } catch (err) {
        throw new CliError(`Opened PR #${published.number}, but could not record the approval: ${(err as Error).message}`);
      }
      const url = project.github_repo ? ` https://github.com/${project.github_repo}/pull/${published.number}` : "";
      const which = ids.length === 1 ? `lesson ${ids[0]}` : `lessons ${ids.join(", ")}`;
      return [
        `Approved ${which}. PR #${published.number} adds ${ids.length === 1 ? "it" : "them"} to .factory/lessons.md:${url}`,
        `Agents read lessons from ${defaultBranch}, so ${ids.length === 1 ? "it applies" : "they apply"} to runs that start after the PR is merged.`,
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
