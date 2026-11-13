import { basename } from "node:path";
import type { Project } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { GithubError } from "./issues.js";

/** The release that holds a run's screenshots and video. */
export function mediaTag(runId: string): string {
  return `factory-media-${runId}`;
}

/** In the run folder once media was uploaded: the release to delete if the run ends unmerged. */
export const MEDIA_MARKER = "media-release.txt";

function ghFor(project: Project, run: CommandRunner) {
  const repo = project.github_repo;
  if (!repo) throw new GithubError(`project ${project.name} has no GitHub repository`);
  return (args: string[]) => {
    const result = run("gh", [...args, "-R", repo], { cwd: project.repo_path });
    if (result.code !== 0) throw new GithubError(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr || result.stdout || "unknown error"}`);
    return result.stdout;
  };
}

/**
 * Upload a run's media as assets of a DRAFT release (`factory-media-<run>`) and return each file's
 * download URL, by file name. Media never goes into the repository: the PR body links these.
 * This is the fallback for when the media cannot be attached to the PR (see publishMedia).
 *
 * Why a draft release: attachments need a browser signed in to GitHub. A published release (even a prerelease) would create a tag on
 * the default branch, fire `release` workflows (publish, deploy) and notify watchers; a draft does
 * none of that and creates no tag until it is published, which the factory never does. The price:
 * a draft's assets are only served to people with push access to the repo, signed in to GitHub;
 * anyone else sees broken images.
 */
export function uploadMedia(project: Project, runId: string, files: string[], run: CommandRunner = runCommand): Record<string, string> {
  const gh = ghFor(project, run);
  const tag = mediaTag(runId);
  // A later round of the same run uploads to the same release, replacing files of the same name.
  let exists = true;
  try {
    gh(["release", "view", tag, "--json", "tagName"]);
  } catch {
    exists = false;
  }
  if (!exists) {
    gh([
      "release",
      "create",
      tag,
      "--draft",
      "--title",
      `Factory media for run ${runId}`,
      "--notes",
      "Screenshots and walkthrough video taken by the software factory for a pull request. Not a release of the software; do not publish it.",
    ]);
  }
  if (files.length) gh(["release", "upload", tag, "--clobber", ...files]);
  const out = gh(["release", "view", tag, "--json", "assets"]);
  let assets: { name?: unknown; url?: unknown }[];
  try {
    assets = (JSON.parse(out) as { assets?: { name?: unknown; url?: unknown }[] }).assets ?? [];
  } catch {
    throw new GithubError(`gh release view returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
  }
  // `url` is the asset's browser download URL; a draft's live under releases/download/untagged-….
  const urls = new Map(assets.flatMap((a) => (typeof a.name === "string" && typeof a.url === "string" ? [[a.name, a.url] as const] : [])));
  const result: Record<string, string> = {};
  for (const file of files) {
    const url = urls.get(basename(file));
    if (!url) throw new GithubError(`${basename(file)} is missing from release ${tag} after the upload`);
    result[basename(file)] = url;
  }
  return result;
}

/** Where a run's media went. */
export interface PublishedMedia {
  /** File name -> URL. */
  urls: Record<string, string>;
  /** The draft release's tag, when the media went there instead of being attached to the PR. */
  release?: string;
  /** Why the media is not attached to the PR, for the PR. */
  fallback?: string;
}

export type AttachmentUploader = (repo: string, prNumber: number, files: string[]) => Promise<Record<string, string>>;

/**
 * Attach the run's media to its PR, which everyone who can see the repo can open; when that cannot
 * be done (no signed-in browser profile, GitHub's page changed, a file too big), upload it to the
 * run's draft release instead, which only maintainers can open, and say why. Throws only when the
 * draft release fails too.
 */
export async function publishMedia(
  project: Project,
  runId: string,
  prNumber: number | null,
  files: string[],
  attach: AttachmentUploader,
  run: CommandRunner = runCommand,
): Promise<PublishedMedia> {
  const repo = project.github_repo;
  if (!repo) throw new GithubError(`project ${project.name} has no GitHub repository`);
  let why: string;
  if (prNumber === null) why = "the run has no pull request";
  else {
    try {
      return { urls: await attach(repo, prNumber, files) };
    } catch (err) {
      why = (err as Error).message.split("\n")[0]!;
    }
  }
  return { urls: uploadMedia(project, runId, files, run), release: mediaTag(runId), fallback: why };
}

/** Delete a run's media release (a draft, so there is no tag to clean up). Throws when gh fails. */
export function deleteMedia(project: Project, runId: string, run: CommandRunner = runCommand): void {
  ghFor(project, run)(["release", "delete", mediaTag(runId), "--yes"]);
}
