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
];
