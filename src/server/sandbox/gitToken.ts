import { splitCommand } from "../code/permissions";

/**
 * Does this command need the user's GitHub token? Only git's network commands (push, pull, fetch, clone, ls-remote,
 * submodule) and gh do. Every other command runs without it, so a prompt-injected `env`, `printenv`, `curl … $GH_TOKEN`
 * or a project script can't read it. A command qualifies only when EVERY part of it (split on && ; | etc.) is one of
 * those, or a harmless `cd` / `true` / `false`, and nothing in it can run other code or print the token: no command
 * or process substitution, no $GITHUB_TOKEN / $GH_TOKEN / ${…}, no leading VAR=…, and no git options that run
 * programs (-c, aliases, --upload-pack, core.sshCommand, ext::, credential, submodule foreach), and no gh auth / alias /
 * extension commands or other hosts.
 * While the token is present, git hooks are switched off (see gitTokenEnv), so a hook the project ships can't read it.
 */
const NETWORK_GIT = new Set(["push", "pull", "fetch", "clone", "ls-remote", "submodule"]);
const GH_REFUSED = new Set(["auth", "alias", "extension", "extensions", "config", "secret", "variable"]);
const ANYWHERE = /\$\(|`|<\(|>\(|\$\{|\$(GITHUB_TOKEN|GH_TOKEN|GIT_CONFIG)/;
const GIT_RUNS_CODE = /(^|\s)(-c|--config-env|--upload-pack|--receive-pack|--exec|-u)(=|\s|$)|core\.sshCommand|ext::|\bcredential\b|\balias\b/i;

export function needsGitHubToken(command: string): boolean {
  if (ANYWHERE.test(command)) return false;
  let networked = false;
  for (const part of splitCommand(command)) {
    // Redirections of git's own output (2>&1, >/dev/null) are fine; a word like `VAR=x` up front is not.
    const words = part.replace(/\d*>&\d/g, "").replace(/\d*>{1,2}\s*\/dev\/null/g, "").trim().split(" ");
    const [cmd, sub] = words;
    if (/^\w+=/.test(cmd)) return false;
    if (cmd === "cd" || cmd === "true" || cmd === "false") continue;
    if (cmd === "git") {
      // `git push -u origin HEAD` is the one -u that's safe (it's --set-upstream there, not --upload-pack).
      const rest = sub === "push" ? part.replace(/(^|\s)-u(\s|$)/, " ") : part;
      if (!NETWORK_GIT.has(sub) || GIT_RUNS_CODE.test(rest)) return false;
      // `git submodule foreach <command>` runs a command: only the plain submodule subcommands qualify.
      if (sub === "submodule" && !/^(update|init|sync|status)$/.test(words[2] ?? "")) return false;
      networked = true;
      continue;
    }
    if (cmd === "gh") {
      // --hostname (or a full URL) would send the token to another host.
      if (!sub || GH_REFUSED.has(sub) || /--hostname|:\/\//.test(part)) return false;
      networked = true;
      continue;
    }
    return false;
  }
  return networked;
}
