import { existsSync, readFileSync, rmSync } from "node:fs";
import { parseVerdict, VerdictParseError, type ParsedVerdict, type VerdictKind } from "@factory/shared";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "./runner.js";

export type TurnResult<K extends VerdictKind> =
  | { status: "ok"; verdict: ParsedVerdict<K>; agent: AgentRunResult }
  /** The output was still invalid after the retry; problems say why. */
  | { status: "invalid"; problems: string[]; agent: AgentRunResult }
  | { status: "failed"; agent: AgentRunResult };

export interface TurnOptions<K extends VerdictKind> {
  run: AgentRunner;
  agent: AgentRunOptions;
  kind: K;
  outputFile: string;
  /** Further checks on a well-formed output (e.g. the commit is pushed). Returns problems. */
  validate?: (verdict: ParsedVerdict<K>) => string[];
}

function readOutput<K extends VerdictKind>(kind: K, path: string): { verdict?: ParsedVerdict<K>; problems: string[] } {
  if (!existsSync(path)) return { problems: [`the output file ${path} was not written`] };
  try {
    return { verdict: parseVerdict(kind, readFileSync(path, "utf8")), problems: [] };
  } catch (err) {
    if (err instanceof VerdictParseError) return { problems: err.problems };
    throw err;
  }
}

/**
 * Run an agent whose job ends in one output file. If the file is missing or malformed, the same
 * session gets exactly one more turn with the problems; after that the caller escalates.
 */
export async function runTurn<K extends VerdictKind>(options: TurnOptions<K>): Promise<TurnResult<K>> {
  // A file left over from an earlier round must not count as this round's answer.
  rmSync(options.outputFile, { force: true });

  let agent = await options.run(options.agent);
  for (let attempt = 0; ; attempt++) {
    if (agent.outcome.kind !== "ok") return { status: "failed", agent };

    const { verdict, problems } = readOutput(options.kind, options.outputFile);
    const all = verdict ? [...problems, ...(options.validate?.(verdict) ?? [])] : problems;
    if (verdict && all.length === 0) return { status: "ok", verdict, agent };
    if (attempt === 1) return { status: "invalid", problems: all, agent };

    rmSync(options.outputFile, { force: true });
    agent = await options.run({
      ...options.agent,
      resumeSessionId: agent.sessionId,
      prompt: [
        "Your hand-over was not accepted:",
        ...all.map((p) => `- ${p}`),
        "",
        "Fix these problems and write the output file again, keeping the exact header format",
        "described in your instructions.",
        "",
        `Output file: \`${options.outputFile}\``,
      ].join("\n"),
    });
  }
}
