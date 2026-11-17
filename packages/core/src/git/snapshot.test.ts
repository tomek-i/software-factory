import { describe, expect, it } from "vitest";
import { snapshot, type GitEvidence } from "./worktrees.js";

/** A GitEvidence that counts its reads; `state` is what git would answer now. */
function counting(state: { head: string; clean: boolean; ahead: number; remote: string }) {
  const reads: string[] = [];
  const git: GitEvidence = {
    head: () => (reads.push("head"), state.head),
    isClean: () => (reads.push("isClean"), state.clean),
    commitsAhead: () => (reads.push("commitsAhead"), state.ahead),
    isPushed: (head) => (reads.push(head === undefined ? "isPushed" : `isPushed(${head})`), state.remote === (head ?? state.head)),
  };
  return { git, reads, state };
}

describe("snapshot", () => {
  it("reads each fact once, and isPushed compares against the HEAD it read", () => {
    const { git, reads } = counting({ head: "a", clean: true, ahead: 1, remote: "a" });
    const facts = snapshot(git);

    for (let i = 0; i < 3; i++) {
      expect(facts.head()).toBe("a");
      expect(facts.isClean()).toBe(true);
      expect(facts.commitsAhead()).toBe(1);
      expect(facts.isPushed()).toBe(true);
    }
    expect(reads).toEqual(["head", "isClean", "commitsAhead", "isPushed(a)"]);
  });

  it("reads isPushed only when asked, so a push made before then counts", () => {
    const { git, state } = counting({ head: "a", clean: true, ahead: 1, remote: "" });
    const facts = snapshot(git);
    expect(facts.head()).toBe("a");

    state.remote = "a";
    expect(facts.isPushed()).toBe(true);
  });

  it("keeps the facts it read, so a new snapshot is needed after anything that can change them", () => {
    const { git, state } = counting({ head: "a", clean: true, ahead: 1, remote: "a" });
    const facts = snapshot(git);
    expect(facts.head()).toBe("a");

    state.head = "b";
    expect(facts.head()).toBe("a");
    expect(snapshot(git).head()).toBe("b");
  });

  it("takes a HEAD the caller has just read instead of asking git", () => {
    const { git, reads } = counting({ head: "a", clean: true, ahead: 1, remote: "a" });
    const facts = snapshot(git, "a");

    expect(facts.head()).toBe("a");
    expect(facts.isPushed()).toBe(true);
    expect(reads).toEqual(["isPushed(a)"]);
  });
});
