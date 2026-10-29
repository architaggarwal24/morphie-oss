/** On Windows, code projects use Git for Windows' bash, never the WSL launcher (which hangs and fails without WSL). */
import { describe, expect, it } from "vitest";
import { pickWindowsBash } from "@/server/sandbox/winShell";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const WSL_ALIAS = "C:\\Users\\Archit\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe";
const WSL_SYS = "C:\\Windows\\System32\\bash.exe";

describe("pickWindowsBash", () => {
  it("skips the WSL launchers that `where bash` lists first, and finds Git's bash from git.exe", () => {
    const installed = new Set([GIT_BASH, WSL_ALIAS, WSL_SYS]);
    expect(pickWindowsBash({ whereBash: [WSL_SYS, WSL_ALIAS], whereGit: ["C:\\Program Files\\Git\\cmd\\git.exe"], programDirs: [], exists: (p) => installed.has(p) })).toBe(GIT_BASH);
    expect(pickWindowsBash({ whereBash: [WSL_ALIAS], whereGit: ["C:\\Program Files\\Git\\mingw64\\bin\\git.exe"], programDirs: [], exists: (p) => installed.has(p) })).toBe(GIT_BASH);
  });

  it("looks in Program Files when git isn't on PATH, takes MORPHIE_BASH first, and gives up (→ cmd.exe) with only WSL", () => {
    expect(pickWindowsBash({ whereBash: [WSL_ALIAS], whereGit: [], programDirs: ["C:\\Program Files"], exists: (p) => p === GIT_BASH })).toBe(GIT_BASH);
    expect(pickWindowsBash({ override: "D:\\tools\\bash.exe", whereBash: [], whereGit: [], programDirs: [], exists: () => true })).toBe("D:\\tools\\bash.exe");
    expect(pickWindowsBash({ whereBash: [WSL_SYS, WSL_ALIAS], whereGit: [], programDirs: ["C:\\Program Files"], exists: (p) => p !== GIT_BASH })).toBeUndefined();
  });
});
