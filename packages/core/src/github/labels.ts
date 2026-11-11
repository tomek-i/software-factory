export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

/** Status labels the factory writes when `github.status_labels` is on. It never reads them as input. */
export function factoryLabels(prefix: string): LabelSpec[] {
  return [
    { name: prefix, color: "5319e7", description: "Queued in the software factory" },
    { name: `${prefix}:in-progress`, color: "1d76db", description: "The factory is working on this" },
    { name: `${prefix}:needs-info`, color: "fbca04", description: "The factory needs more information to continue" },
    { name: `${prefix}:needs-human`, color: "d93f0b", description: "The factory escalated this to a human" },
    { name: `${prefix}:unsafe`, color: "b60205", description: "Built with hard rules lifted (--unsafe)" },
  ];
}
