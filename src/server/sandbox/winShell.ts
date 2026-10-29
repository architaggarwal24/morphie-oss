import path from "node:path";

/**
 * Which bash to use on Windows: Git for Windows' bash, never the WSL launcher.
 *
 * `bash.exe` in System32 and in …\WindowsApps\ is the WSL launcher. Without a WSL distro installed it hangs for about a
 * minute and then fails ("Class not registered … Bash/CallMsi/Install"), so it must not be picked even though `where
 * bash` lists it. Git for Windows' bash is found from where Git is installed. MORPHIE_BASH overrides everything.
 * Pure (Windows paths, injected lookups) so it can be tested anywhere.
 */
export function pickWindowsBash(o: { override?: string; whereBash: string[]; whereGit: string[]; programDirs: string[]; exists: (p: string) => boolean }): string | undefined {
  const w = path.win32;
  const isWsl = (p: string) => /\\(system32|sysnative|windowsapps)\\/i.test(p);
  const candidates: string[] = [];
  if (o.override?.trim()) candidates.push(o.override.trim());
  // Next to git.exe: Git\cmd\git.exe, Git\bin\git.exe or Git\mingw64\bin\git.exe → Git\bin\bash.exe.
  for (const g of o.whereGit) {
    const dir = w.dirname(g.trim());
    candidates.push(w.join(dir, "..", "bin", "bash.exe"), w.join(dir, "..", "..", "bin", "bash.exe"), w.join(dir, "bash.exe"));
  }
  for (const base of o.programDirs) candidates.push(w.join(base, "Git", "bin", "bash.exe"));
  candidates.push(...o.whereBash.map((l) => l.trim()).filter(Boolean));
  return candidates.map((c) => w.normalize(c)).find((c) => !isWsl(c) && o.exists(c));
}
