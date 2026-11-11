import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git, repoWithRemote } from "../../test/helpers.js";
import { ConfigError } from "./load.js";
import { loadTrustedConfig, trustedReader } from "./trusted.js";

const CONFIG = "version: 1\nchecks:\n  - name: test\n    run: npm test\ntrust:\n  authors: [alice]\n";

describe("loadTrustedConfig", () => {
  it("reads the config from the remote default branch, ignoring the working copy", () => {
    const { root } = repoWithRemote({ ".factory/config.yaml": CONFIG });
    // A checked-out branch weakens its own checks and trusts everyone.
    git(root, "checkout", "-qb", "contributor");
    writeFileSync(join(root, ".factory", "config.yaml"), "version: 1\nchecks: []\ntrust:\n  everyone: true\n");
    git(root, "commit", "-qam", "weaken");

    const config = loadTrustedConfig(trustedReader(root, "main"), "main");

    expect(config.checks.map((c) => c.run)).toEqual(["npm test"]);
    expect(config.trust.everyone).toBe(false);
  });

  it("sees changes pushed to the default branch", () => {
    const { root, base } = repoWithRemote({ ".factory/config.yaml": CONFIG });
    const other = join(base, "other");
    git(base, "clone", "-q", join(base, "remote.git"), other);
    mkdirSync(join(other, ".factory"), { recursive: true });
    writeFileSync(join(other, ".factory", "config.yaml"), CONFIG.replace("npm test", "npm run ci"));
    git(other, "-c", "user.email=o@example.invalid", "-c", "user.name=o", "commit", "-qam", "ci");
    git(other, "push", "-q", "origin", "main");

    expect(loadTrustedConfig(trustedReader(root, "main"), "main").checks[0]!.run).toBe("npm run ci");
  });

  it("explains when the config was never pushed", () => {
    const { root } = repoWithRemote();
    expect(() => loadTrustedConfig(trustedReader(root, "main"), "main")).toThrow(ConfigError);
    expect(() => loadTrustedConfig(trustedReader(root, "main"), "main")).toThrow(/commit and push/);
  });
});
