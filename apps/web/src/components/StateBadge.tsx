import type { RunState } from "@factory/shared";
import { STATE_TONE, TONE_CLASS } from "../lib/states";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

export function StateBadge({ state, className }: { state: RunState; className?: string }) {
  return <Badge className={cn("font-mono", TONE_CLASS[STATE_TONE[state]], className)}>{state}</Badge>;
}
