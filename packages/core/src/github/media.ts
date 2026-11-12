import { basename } from "node:path";
import type { Project } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { GithubError } from "./issues.js";

/** The release that holds a run's screenshots and video. */
export function mediaTag(runId: string): string {
  return `factory-media-${runId}`;
}

/**
 * Upload a run's media as assets of a prerelease (`factory-media-<run>`) and return each file's
 * download URL, by file name. Media never goes into the repository: the PR body links these.
 *
 * Why a prerelease: the browser upload that issue/PR attachments use cannot be scripted reliably
 * from a headless engine, and a draft release's asset URLs are only served to people with push
 * access (and change when the draft is published). A prerelease's assets are served to everyone who
 * can read the repo. The price is a tag `factory-media-<run>` on the default branch's head, which
 * `gh release delete <tag> --cleanup-tag` removes with the release; marked not latest, so it does
 * not replace a real release. In a private repo the images only show for people who are signed in
 * to GitHub with access to it.
 */
export function uploadMedia(project: Project, runId: string, files: string[], run: CommandRunner = runCommand): Record<string, string> {
  const repo = project.github_repo;
  if (!repo) throw new GithubError(`project ${project.name} has no GitHub repository`);
  const gh = (args: string[]) => {
    const result = run("gh", args, { cwd: project.repo_path });
    if (result.code !== 0) throw new GithubError(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr || result.stdout || "unknown error"}`);
    return result.stdout;
  };
  const tag = mediaTag(runId);
  // A later round of the same run uploads to the same release, replacing files of the same name.
  if (run("gh", ["release", "view", tag, "-R", repo, "--json", "tagName"], { cwd: project.repo_path }).code !== 0) {
    gh([
      "release",
      "create",
      tag,
      "-R",
      repo,
      "--prerelease",
      "--latest=false",
      "--title",
      `Factory media for run ${runId}`,
      "--notes",
      "Screenshots and walkthrough video taken by the software factory for a pull request. Not a release of the software.",
    ]);
  }
  if (files.length) gh(["release", "upload", tag, "-R", repo, "--clobber", ...files]);
  const out = gh(["release", "view", tag, "-R", repo, "--json", "assets"]);
  let assets: { name?: unknown; url?: unknown }[];
  try {
    assets = (JSON.parse(out) as { assets?: { name?: unknown; url?: unknown }[] }).assets ?? [];
  } catch {
    throw new GithubError(`gh release view returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
  }
  const urls = new Map(assets.flatMap((a) => (typeof a.name === "string" && typeof a.url === "string" ? [[a.name, a.url] as const] : [])));
  const result: Record<string, string> = {};
  for (const file of files) {
    const url = urls.get(basename(file));
    if (!url) throw new GithubError(`${basename(file)} is missing from release ${tag} after the upload`);
    result[basename(file)] = url;
  }
  return result;
}
