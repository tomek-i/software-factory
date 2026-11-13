# Repository settings

How `main` is protected and how the repo is set up, with the commands to apply it again.
Run them as a repo admin with the GitHub CLI.

## What is protected

The `protect-main` ruleset applies to the default branch:

- Changes land only through a pull request. No approving review is required: there is one maintainer, who cannot approve their own PRs.
- PRs merge only by squash, so history stays linear and the PR title becomes the commit.
- Required checks: `test (ubuntu-latest)` and `test (windows-latest)` from CI, and `conventional` from the PR-title check. They must come from GitHub Actions.
- The branch must be up to date with `main` before it merges. The factory merges `main` into its branch once, before it waits for the checks. If `main` moves during that wait, GitHub refuses the merge and the run stops for you.
- Force pushes and deleting `main` are refused.
- The `cla` check is not required, so GitHub does not block an outside contributor's PR that has no signed CLA. Check the CLA comment before merging one.

## Release PRs

release-please opens its release PR with the workflow's `GITHUB_TOKEN`. GitHub does not start workflows for events from that token, so CI and the PR-title check never run on it, and it could never merge.

- Repo admins may bypass the ruleset, but only by merging a pull request (`bypass_mode: pull_request`). Direct and force pushes stay refused for admins too.
- To merge a release PR, tick "Merge without waiting for requirements to be met".
- The factory waits for the required checks itself and stops when one fails, so the bypass is not what it relies on to merge.

## Repo settings

- Head branches are deleted after a merge. The factory keeps its local worktree and does not need the remote branch after the merge.
- Merge commits and rebase merges are off; squash only.
- Wiki and Discussions are off.
- Topics: `claude-code`, `ai-agents`, `github-automation`, `developer-tools`.

## Apply

Save the ruleset as `ruleset.json`:

```json
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [{ "actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "pull_request" }],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "test (ubuntu-latest)", "integration_id": 15368 },
          { "context": "test (windows-latest)", "integration_id": 15368 },
          { "context": "conventional", "integration_id": 15368 }
        ]
      }
    }
  ]
}
```

`actor_id: 5` is the admin role. `integration_id: 15368` is GitHub Actions.

Then:

```sh
REPO=tomek-i/software-factory

# Create the ruleset. To change it later: gh api -X PUT repos/$REPO/rulesets/<id> --input ruleset.json
gh api -X POST repos/$REPO/rulesets --input ruleset.json

gh api -X PATCH repos/$REPO \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true -F has_wiki=false -F has_discussions=false

gh api -X PUT repos/$REPO/topics \
  -f 'names[]=claude-code' -f 'names[]=ai-agents' -f 'names[]=github-automation' -f 'names[]=developer-tools'
```

Check:

```sh
gh api repos/$REPO/rules/branches/main --jq '.[].type'
gh repo view $REPO --json deleteBranchOnMerge,squashMergeAllowed,repositoryTopics
```
