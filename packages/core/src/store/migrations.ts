/**
 * Forward-only schema migrations. Append new entries; never edit an applied one.
 * Plain SQL keeps the store dependency-free beyond better-sqlite3.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE projects (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    repo_path    TEXT NOT NULL UNIQUE,
    github_repo  TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE runs (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES projects(id),
    issue_number      INTEGER,
    title             TEXT NOT NULL,
    state             TEXT NOT NULL,
    unsafe            INTEGER NOT NULL DEFAULT 0,
    branch            TEXT,
    worktree_path     TEXT,
    pr_number         INTEGER,
    build_iterations  INTEGER NOT NULL DEFAULT 0,
    review_rounds     INTEGER NOT NULL DEFAULT 0,
    critic_rounds     INTEGER NOT NULL DEFAULT 0,
    waiting_gate      TEXT,
    lease_owner       TEXT,
    lease_expires_at  TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  CREATE INDEX runs_project_state ON runs(project_id, state);

  CREATE TABLE run_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    from_state  TEXT,
    to_state    TEXT NOT NULL,
    reason      TEXT NOT NULL,
    data        TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX run_events_run ON run_events(run_id, id);

  CREATE TABLE decisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    gate        TEXT NOT NULL,
    mode        TEXT NOT NULL,
    outcome     TEXT NOT NULL,
    actor       TEXT NOT NULL,
    comment     TEXT NOT NULL,
    commit_sha  TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX decisions_run ON decisions(run_id, id);

  CREATE TABLE agent_runs (
    id             TEXT PRIMARY KEY,
    run_id         TEXT NOT NULL REFERENCES runs(id),
    role           TEXT NOT NULL,
    model          TEXT,
    session_id     TEXT,
    status         TEXT NOT NULL,
    cost_usd       REAL,
    input_tokens   INTEGER,
    output_tokens  INTEGER,
    log_path       TEXT,
    excerpt        TEXT,
    started_at     TEXT NOT NULL,
    ended_at       TEXT
  );
  CREATE INDEX agent_runs_run ON agent_runs(run_id);
  `,
  // Issues mirrored from GitHub. queued_at is the local intake decision: only the
  // factory's user sets it, so nobody on GitHub can feed work in.
  `
  CREATE TABLE issues (
    project_id     TEXT NOT NULL REFERENCES projects(id),
    number         INTEGER NOT NULL,
    title          TEXT NOT NULL,
    body           TEXT NOT NULL,
    state          TEXT NOT NULL,
    author         TEXT NOT NULL,
    labels         TEXT NOT NULL,
    url            TEXT NOT NULL,
    gh_updated_at  TEXT NOT NULL,
    synced_at      TEXT NOT NULL,
    queued_at      TEXT,
    PRIMARY KEY (project_id, number)
  );
  CREATE INDEX issues_queued ON issues(project_id, queued_at);
  `,
  // parked_from limits where a human can resume a parked run; queue_seq gives a total queue order
  // (queued_at alone ties when several issues are queued in the same millisecond).
  `
  ALTER TABLE runs ADD COLUMN parked_from TEXT;
  ALTER TABLE issues ADD COLUMN queue_seq INTEGER;
  `,
  // port_base: first port of the run's block for dev servers and browsers. pid lets another
  // process (e.g. `factory cancel`) stop a running agent.
  `
  ALTER TABLE runs ADD COLUMN port_base INTEGER;
  ALTER TABLE agent_runs ADD COLUMN pid INTEGER;
  `,
  // effort: the --effort an agent ran with, so usage can be compared per model and effort.
  `
  ALTER TABLE agent_runs ADD COLUMN effort TEXT;
  `,
  // round: how many times the run has entered the quality gate. It names the round-N folder of
  // checks, reviews and verification, so a run sent back to build never overwrites an earlier round.
  // Existing runs continue from the last folder they used: build_iterations + 1 as it was when they
  // last entered the gate, which is one less now if the gate sent them back to build since.
  `
  ALTER TABLE runs ADD COLUMN round INTEGER NOT NULL DEFAULT 0;
  UPDATE runs SET round = CASE
    WHEN NOT EXISTS (SELECT 1 FROM run_events g WHERE g.run_id = runs.id AND g.to_state = 'gate') THEN 0
    WHEN EXISTS (
      SELECT 1 FROM run_events b
      WHERE b.run_id = runs.id AND b.from_state = 'gate' AND b.to_state = 'build'
        AND b.id > (SELECT MAX(g.id) FROM run_events g WHERE g.run_id = runs.id AND g.to_state = 'gate')
    ) THEN build_iterations
    ELSE build_iterations + 1
  END;
  `,
  // created_by_factory: the factory itself opened the issue on GitHub (`factory new`), from the
  // operator's own idea, so its text counts as trusted whoever the gh login is. Only set locally,
  // never read from GitHub, so a sync cannot set or clear it.
  `
  ALTER TABLE issues ADD COLUMN created_by_factory INTEGER NOT NULL DEFAULT 0;
  `,
  // What `factory new --approve` has created from a draft so far, so an interrupted approval
  // resumes instead of creating issues again. Kept here, not in the draft folder: a file in the
  // working tree could come from a branch and name someone else's issue as the factory's.
  // fingerprint ties each number to the draft entry it was created from.
  `
  CREATE TABLE draft_issues (
    project_id   TEXT NOT NULL REFERENCES projects(id),
    draft_id     TEXT NOT NULL,
    position     INTEGER NOT NULL,
    number       INTEGER NOT NULL,
    fingerprint  TEXT NOT NULL,
    linked       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, draft_id, position)
  );
  CREATE TABLE drafts_done (
    project_id  TEXT NOT NULL REFERENCES projects(id),
    draft_id    TEXT NOT NULL,
    done_at     TEXT NOT NULL,
    PRIMARY KEY (project_id, draft_id)
  );
  `,
  // Lessons the learner proposed after a run. They only reach `.factory/lessons.md` (through a PR)
  // once a human approves them; pull_request is that PR, comment why a human rejected one.
  `
  CREATE TABLE lessons (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    TEXT NOT NULL REFERENCES projects(id),
    run_id        TEXT NOT NULL REFERENCES runs(id),
    status        TEXT NOT NULL,
    observation   TEXT NOT NULL,
    evidence      TEXT NOT NULL,
    rule          TEXT NOT NULL,
    comment       TEXT,
    pull_request  INTEGER,
    created_at    TEXT NOT NULL,
    decided_at    TEXT
  );
  CREATE INDEX lessons_project_status ON lessons(project_id, status);
  `,
];
