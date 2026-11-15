import { ghPort, type GithubPort } from "../github/port.js";
import { publishLessons, type PublishedLessons } from "../lessons/publish.js";
import type { Project, StoredLesson, Store } from "../store/store.js";
import type { CommandRunner } from "../util/exec.js";
import { ServiceError } from "./errors.js";
import type { ServiceContext } from "./runs.js";

/** A lesson with the issue of the run it was learned from, when that run had one. */
export type LessonEntry = StoredLesson & { issue_number?: number | null };

function withIssue(store: Store, lesson: StoredLesson): LessonEntry {
  return { ...lesson, issue_number: store.getRun(lesson.run_id)?.issue_number };
}

/** The project's lessons waiting for a decision; with `all`, every lesson. */
export function listLessons(store: Store, project: Project, options: { all?: boolean } = {}): LessonEntry[] {
  return store.listLessons({ project_id: project.id, status: options.all ? undefined : "proposed" }).map((l) => withIssue(store, l));
}

/** The project's proposed lessons with these ids, or a ServiceError naming every one that is not. */
export function proposedLessons(store: Store, project: Project, ids: number[]): StoredLesson[] {
  const problems: string[] = [];
  const lessons = ids.flatMap((id) => {
    const lesson = store.getLesson(id);
    if (!lesson || lesson.project_id !== project.id) problems.push(`No lesson ${id}.`);
    else if (lesson.status !== "proposed") problems.push(`Lesson ${id} is already ${lesson.status}.`);
    else return [lesson];
    return [];
  });
  if (problems.length) throw new ServiceError(`${problems.join("\n")}\nSee \`factory lessons --all\`.`);
  return lessons;
}

/**
 * One PR that appends these lessons to `.factory/lessons.md` (the lessons PR still open, if there
 * is one). They are marked approved only once they are on that PR, and agents see them once it is
 * merged.
 */
export function approveLessons(ctx: ServiceContext, ids: number[], deps: { run?: CommandRunner; github?: GithubPort; now?: Date } = {}): PublishedLessons {
  const { store, project, config } = ctx;
  const lessons = proposedLessons(store, project, ids);
  let published: PublishedLessons;
  try {
    published = publishLessons({
      root: project.repo_path,
      defaultBranch: config.project.default_branch,
      lessons: lessons.map((l) => withIssue(store, l)),
      github: deps.github ?? ghPort(project, deps.run),
      inPullRequest: (number) =>
        store
          .listLessons({ project_id: project.id, status: "approved" })
          .filter((l) => l.pull_request === number)
          .map((l) => withIssue(store, l)),
      run: deps.run,
      now: deps.now,
    });
  } catch (err) {
    throw new ServiceError(`Could not publish the lessons; nothing was approved: ${(err as Error).message}`);
  }
  try {
    store.decideLessons(ids, "approved", { pull_request: published.number });
  } catch (err) {
    throw new ServiceError(`Pushed the lessons to PR #${published.number}, but could not record the approval: ${(err as Error).message}`);
  }
  return published;
}

/** The lessons are kept, marked rejected, and never applied. */
export function rejectLessons(store: Store, project: Project, ids: number[], comment?: string): void {
  proposedLessons(store, project, ids);
  store.decideLessons(ids, "rejected", { comment: comment?.trim() || undefined });
}
