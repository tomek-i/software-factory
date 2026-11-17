import type { RunRow } from "../lib/api";
import { webLink } from "../lib/failure";

/**
 * The unresolved review threads and failed optional checks a run's merge waits on, each with its
 * link, so they are seen before anyone approves. Written on GitHub by anyone: text only.
 */
export function OpenFeedback({ run }: { run: RunRow }) {
  if (run.failure?.kind !== "feedback") return null;
  return (
    <ul className="space-y-1 text-sm xl:max-w-3xl" aria-label="Open on the pull request">
      {run.failure.items.map((item, i) => {
        const link = webLink(item.link);
        const where = item.file ? ` at ${item.file}${item.line ? `:${item.line}` : ""}` : "";
        return (
          <li key={i} className="break-words">
            {link ? (
              <a href={link} target="_blank" rel="noreferrer" className="font-medium underline">
                {item.name}
              </a>
            ) : (
              <span className="font-medium">{item.name}</span>
            )}
            <span className="text-muted-foreground">{where}</span>
            {item.summary && <span>: {item.summary}</span>}
          </li>
        );
      })}
    </ul>
  );
}
