import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RotateCcw, Save, Trash2, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input, Select, Textarea } from "../components/ui/input";
import { api, ApiError, type ProjectSettings, type SavedSettings, type SettingChange, type SettingView } from "../lib/api";
import { useProject } from "../lib/project";
import { cn } from "../lib/utils";

/** A setting's edit: a new value, or back to the default. */
type Edit = { value: unknown } | { reset: true };
type Check = { name: string; run: string; timeout_sec?: number; retries?: number };
type ModelEntry = { model?: string; effort?: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A list as typed may end in an empty line; it is not an entry. */
const cleaned = (value: unknown) => (Array.isArray(value) && value.every((v) => typeof v === "string") ? value.filter((v) => v !== "") : value);

/** A value as a short line of text, for hints and the list of changes. */
function show(value: unknown): string {
  if (value === undefined || value === null || value === "") return "not set";
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    return value.map((v) => (typeof v === "object" && v !== null && "name" in v ? String((v as Check).name) : String(v))).join(", ");
  }
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, ModelEntry | string>);
    if (entries.length === 0) return "none";
    return entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : [v.model, v.effort].filter(Boolean).join(" ")}`).join(", ");
  }
  return String(value);
}

/**
 * The project's `.factory/config.yaml` as runs use it, from its default branch, as a form. Saving
 * commits the changes to that branch and pushes them, after a confirmation that lists them.
 */
export function Settings() {
  const { project } = useProject();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const usable = projects.data?.filter((p) => p.status === "ok") ?? [];
  const [picked, setPicked] = useState("");
  const target = picked || (usable.some((p) => p.key === project) ? project! : (usable[0]?.key ?? ""));
  const settings = useQuery({ queryKey: ["settings", target], queryFn: () => api.settings(target), enabled: !!target });
  const [saved, setSaved] = useState<SavedSettings & { project: string }>();

  return (
    <section className="max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <p className="text-sm text-muted-foreground">
        The project's <code className="font-mono">.factory/config.yaml</code> as runs use it: from its default branch on GitHub. Saving commits your changes to
        that branch and pushes them.
      </p>
      <label className="flex items-center gap-2 text-sm">
        Project
        <Select value={target} onChange={(e) => setPicked(e.target.value)}>
          {usable.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </Select>
      </label>
      {projects.data && usable.length === 0 && <p className="text-sm text-muted-foreground">No project opens. Run `factory init` in a repository first.</p>}
      <p role="status" className="text-sm">
        {saved?.project === target && (
          <>
            Saved as commit <code className="font-mono">{saved.commit.slice(0, 7)}</code> on {saved.branch}. Runs use it from now on; a local checkout sees it after a
            pull.
          </>
        )}
      </p>
      {settings.isPending && target && <p className="text-sm text-muted-foreground">Loading the settings...</p>}
      {settings.error && (
        <p className="whitespace-pre-wrap text-sm text-destructive" role="alert">
          {settings.error.message}
        </p>
      )}
      {settings.data && (
        <Editor key={`${target}/${settings.data.head}`} project={target} data={settings.data} onSaved={(s) => setSaved({ ...s, project: target })} onEdit={() => setSaved(undefined)} />
      )}
    </section>
  );
}

function Editor({ project, data, onSaved, onEdit }: { project: string; data: ProjectSettings; onSaved: (s: SavedSettings) => void; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [confirming, setConfirming] = useState(false);
  const byPath = new Map(data.settings.map((s) => [s.path, s]));

  const change = (setting: SettingView, edit: Edit | undefined) => {
    onEdit();
    setConfirming(false);
    setEdits((current) => {
      const next = { ...current };
      // Back to what the file has: no change at all.
      const unchanged = !edit || ("reset" in edit ? setting.value === undefined : same(edit.value, setting.value));
      if (unchanged) delete next[setting.path];
      else next[setting.path] = edit;
      return next;
    });
  };
  const changes: SettingChange[] = Object.entries(edits).map(([path, edit]) => ("reset" in edit ? { path, reset: true } : { path, value: cleaned(edit.value) }));
  const save = useMutation({
    mutationFn: () => api.saveSettings(project, data.head, changes),
    onSuccess: (result) => {
      onSaved(result);
      return queryClient.invalidateQueries({ queryKey: ["settings", project] });
    },
  });
  const stale = save.error instanceof ApiError && save.error.status === 409;

  return (
    <div className="space-y-6 pb-24">
      {data.problems.length > 0 && (
        <div className="space-y-1 text-sm text-destructive" role="alert">
          <p>The config on {data.branch} is not valid, so runs can't start; below are the defaults. Fix the file, or save settings here to write a valid one.</p>
          <ul className="list-disc pl-5">
            {data.problems.map((p) => (
              <li key={p} className="break-words">
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.sections.map((section) => (
        <section key={section.key} aria-labelledby={`section-${section.key}`} className="space-y-3">
          <div>
            <h2 id={`section-${section.key}`} className="font-semibold">
              {section.title}
            </h2>
            <p className="text-sm text-muted-foreground">{section.about}</p>
          </div>
          <Card>
            <CardContent className="divide-y">
              {data.settings
                .filter((s) => s.section === section.key)
                .map((s) => (
                  <Field key={s.path} setting={s} edit={edits[s.path]} builtinPaths={data.builtinPaths} onChange={(e) => change(s, e)} />
                ))}
            </CardContent>
          </Card>
        </section>
      ))}

      {changes.length > 0 && (
        <div className="sticky bottom-0 -mx-4 border-t bg-background px-4 py-3 shadow-sm">
          {confirming ? (
            <div className="space-y-3" role="group" aria-label="Confirm the changes">
              <p className="text-sm font-medium">
                Commit and push {changes.length === 1 ? "this change" : `these ${changes.length} changes`} to {data.branch}?
              </p>
              <ul className="space-y-1 text-sm">
                {changes.map((c) => {
                  const setting = byPath.get(c.path)!;
                  const after = "reset" in c ? `the default (${show(setting.default)})` : show(c.value);
                  return (
                    <li key={c.path} className="break-words">
                      <code className="font-mono">{c.path}</code>: {show(setting.value ?? setting.default)} to {after}
                      {setting.sensitive && (
                        <span className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                          {setting.sensitive}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {save.error && (
                <p className="whitespace-pre-wrap text-sm text-destructive" role="alert">
                  {save.error.message}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {stale ? (
                  <Button onClick={() => void queryClient.invalidateQueries({ queryKey: ["settings", project] })}>
                    <RotateCcw aria-hidden /> Reload the settings
                  </Button>
                ) : (
                  <Button disabled={save.isPending} onClick={() => save.mutate()}>
                    <Save aria-hidden /> {save.isPending ? "Saving..." : `Save to ${data.branch}`}
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  Keep editing
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{changes.length === 1 ? "1 change" : `${changes.length} changes`}</span>
              <span className="ml-auto flex gap-2">
                <Button variant="ghost" onClick={() => setEdits({})}>
                  Discard
                </Button>
                <Button onClick={() => setConfirming(true)}>
                  <Save aria-hidden /> Review and save
                </Button>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One setting: its label, help and input, whether the file sets it, and a way back to the default. */
function Field({ setting, edit, builtinPaths, onChange }: { setting: SettingView; edit?: Edit; builtinPaths: string[]; onChange: (edit: Edit | undefined) => void }) {
  const id = `setting-${setting.path.replace(/\./g, "-")}`;
  // What the input shows: the edit, else what the file sets; nothing means the default applies.
  const current = edit ? ("reset" in edit ? undefined : edit.value) : setting.value;
  const isSet = current !== undefined;
  const set = (value: unknown) => onChange(value === undefined ? (setting.value === undefined ? undefined : { reset: true }) : { value });

  let state = "Default";
  if (edit) state = "Changed";
  else if (setting.value !== undefined) state = "Set in the file";

  return (
    <div className="space-y-1.5 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <label htmlFor={id} className="text-sm font-medium">
          {setting.label}
        </label>
        <span className={cn("text-xs", edit ? "font-medium text-foreground" : "text-muted-foreground")}>{state}</span>
        {isSet && !setting.readOnly && (
          <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={() => onChange(setting.value === undefined ? undefined : { reset: true })}>
            <RotateCcw aria-hidden /> Use default
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {setting.help}
        {setting.kind.type !== "checks" && setting.kind.type !== "models" && setting.path !== "hard_rules.paths" && <> Default: {show(setting.default)}.</>}
      </p>
      {setting.readOnly ? (
        <p className="text-sm">
          <span className="break-words">{show(setting.effective)}</span>
          <span className="block text-xs text-muted-foreground">{setting.readOnly}</span>
        </p>
      ) : (
        <SettingInput id={id} setting={setting} value={current} builtinPaths={builtinPaths} set={set} />
      )}
    </div>
  );
}

function SettingInput({ id, setting, value, builtinPaths, set }: { id: string; setting: SettingView; value: unknown; builtinPaths: string[]; set: (v: unknown) => void }): ReactNode {
  const kind = setting.kind;
  switch (kind.type) {
    case "boolean":
      return (
        <Select id={id} value={value === undefined ? "" : String(value)} onChange={(e) => set(e.target.value === "" ? undefined : e.target.value === "true")}>
          <option value="">Default ({show(setting.default)})</option>
          <option value="true">On</option>
          <option value="false">Off</option>
        </Select>
      );
    case "enum":
      return (
        <Select id={id} value={value === undefined ? "" : String(value)} onChange={(e) => set(e.target.value || undefined)}>
          <option value="">Default ({show(setting.default)})</option>
          {kind.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    case "integer":
    case "number":
      return (
        <Input
          id={id}
          type="number"
          className="w-40"
          min={kind.type === "integer" ? kind.min : undefined}
          step={kind.type === "integer" ? 1 : "any"}
          placeholder={show(setting.default)}
          value={value === undefined ? "" : String(value)}
          onChange={(e) => set(e.target.value === "" || Number.isNaN(e.target.valueAsNumber) ? undefined : e.target.valueAsNumber)}
        />
      );
    case "string":
      return <Input id={id} placeholder={setting.default === undefined ? "" : show(setting.default)} value={value === undefined ? "" : String(value)} onChange={(e) => set(e.target.value === "" ? undefined : e.target.value)} />;
    case "list":
      if (kind.options) {
        const chosen = (value ?? setting.default ?? []) as string[];
        return (
          <fieldset id={id} className="flex flex-wrap gap-x-4 gap-y-1" aria-label={setting.label}>
            {kind.options.map((o) => (
              <label key={o} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.includes(o)}
                  onChange={(e) => set(e.target.checked ? kind.options!.filter((x) => x === o || chosen.includes(x)) : chosen.filter((x) => x !== o))}
                />
                {o}
              </label>
            ))}
          </fieldset>
        );
      }
      return (
        <>
          {setting.path === "hard_rules.paths" && (
            <p className="break-words text-xs text-muted-foreground">Always protected: {builtinPaths.join(", ")}.</p>
          )}
          <Textarea
            id={id}
            rows={3}
            placeholder="One per line"
            value={value === undefined ? "" : (value as string[]).join("\n")}
            onChange={(e) => {
              const lines = e.target.value.split("\n");
              // Kept as typed while editing; empty lines are dropped once there is nothing else.
              set(lines.every((l) => l.trim() === "") ? undefined : lines.map((l) => l.trim()).filter((l, i, all) => l !== "" || i === all.length - 1));
            }}
          />
        </>
      );
    case "checks":
      return <Checks id={id} checks={(value ?? []) as Check[]} set={(checks) => set(checks.length ? checks : undefined)} />;
    case "models":
      return <Models id={id} keys={kind.keys} entries={(value ?? {}) as Record<string, ModelEntry | string>} set={(m) => set(Object.keys(m).length ? m : undefined)} />;
  }
}

function Checks({ id, checks, set }: { id: string; checks: Check[]; set: (checks: Check[]) => void }) {
  // An empty name or command stays, so saving says which check lacks one.
  const update = (i: number, patch: Partial<Check>) => set(checks.map((c, k) => (k === i ? dropUnset({ ...c, ...patch }) : c)));
  return (
    <div id={id} className="space-y-2">
      {checks.length === 0 && <p className="text-sm text-muted-foreground">No checks: the quality gate only scans for secrets.</p>}
      {checks.map((check, i) => (
        <div key={i} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[8rem_1fr_6rem_5rem_auto] sm:items-end">
          <label className="space-y-1 text-xs">
            Name
            <Input value={check.name} onChange={(e) => update(i, { name: e.target.value })} />
          </label>
          <label className="space-y-1 text-xs">
            Command
            <Input className="font-mono" value={check.run} onChange={(e) => update(i, { run: e.target.value })} />
          </label>
          <label className="space-y-1 text-xs">
            Timeout (s)
            <Input type="number" min={1} placeholder="900" value={check.timeout_sec ?? ""} onChange={(e) => update(i, { timeout_sec: numberOrUndefined(e.target.valueAsNumber) })} />
          </label>
          <label className="space-y-1 text-xs">
            Retries
            <Input type="number" min={0} max={5} placeholder="1" value={check.retries ?? ""} onChange={(e) => update(i, { retries: numberOrUndefined(e.target.valueAsNumber) })} />
          </label>
          <Button variant="ghost" size="sm" aria-label={`Remove check ${check.name || i + 1}`} onClick={() => set(checks.filter((_, k) => k !== i))}>
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => set([...checks, { name: "", run: "" }])}>
        <Plus aria-hidden /> Add a check
      </Button>
    </div>
  );
}

// Claude Code's --effort levels (EFFORT_LEVELS in the shared package, which the page doesn't bundle).
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function Models({ id, keys, entries, set }: { id: string; keys: string[]; entries: Record<string, ModelEntry | string>; set: (m: Record<string, ModelEntry>) => void }) {
  const entry = (key: string): ModelEntry => {
    const e = entries[key];
    return typeof e === "string" ? { model: e } : (e ?? {});
  };
  const update = (key: string, patch: ModelEntry) => {
    const next: Record<string, ModelEntry> = {};
    for (const k of keys) {
      const e = dropEmpty(k === key ? { ...entry(k), ...patch } : entry(k));
      if (Object.keys(e).length) next[k] = e;
    }
    set(next);
  };
  return (
    <div id={id} className="grid gap-x-3 gap-y-1.5 sm:grid-cols-[8rem_1fr_8rem]">
      {keys.map((key) => (
        <div key={key} className="contents">
          <span className="pt-2 text-sm">{key.replace("_", " ")}</span>
          <Input aria-label={`${key} model`} placeholder="recommended" value={entry(key).model ?? ""} onChange={(e) => update(key, { model: e.target.value || undefined })} />
          <Select aria-label={`${key} effort`} value={entry(key).effort ?? ""} onChange={(e) => update(key, { effort: e.target.value || undefined })}>
            <option value="">effort: recommended</option>
            {EFFORTS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </div>
      ))}
    </div>
  );
}

const numberOrUndefined = (n: number) => (Number.isNaN(n) ? undefined : n);

/** Without the fields left unset, so they fall back to their defaults. */
function dropUnset<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Without the fields left empty, so they fall back to their defaults. */
function dropEmpty<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as T;
}
