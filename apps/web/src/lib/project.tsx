import { createContext, useContext, useState, type ReactNode } from "react";

const KEY = "factory.project";

interface Selected {
  /** A project key, or undefined for all projects. */
  project?: string;
  setProject: (key: string | undefined) => void;
}

const ProjectContext = createContext<Selected>({ setProject: () => {} });

export const useProject = () => useContext(ProjectContext);

// Remembered per browser as a convenience; storage can be missing or blocked.
function load(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function save(key: string | undefined): void {
  try {
    if (key) localStorage.setItem(KEY, key);
    else localStorage.removeItem(KEY);
  } catch {
    // Not remembered; the choice still holds for this page.
  }
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setSelected] = useState<string | undefined>(load);
  const setProject = (key: string | undefined) => {
    setSelected(key);
    save(key);
  };
  return <ProjectContext.Provider value={{ project, setProject }}>{children}</ProjectContext.Provider>;
}
