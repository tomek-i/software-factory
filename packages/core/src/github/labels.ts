export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

/** Labels the factory reads and writes. `prefix` is the configurable trigger label (default "factory"). */
export function factoryLabels(prefix: string): LabelSpec[] {
  return [
    { name: prefix, color: "5319e7", description: "Picked up by the software factory" },
    { name: `${prefix}:in-progress`, color: "1d76db", description: "The factory is working on this" },
    { name: `${prefix}:needs-info`, color: "fbca04", description: "The factory needs more information to continue" },
    { name: `${prefix}:needs-human`, color: "d93f0b", description: "The factory escalated this to a human" },
    { name: `${prefix}:unsafe`, color: "b60205", description: "Built with hard rules lifted (--unsafe)" },
  ];
}
