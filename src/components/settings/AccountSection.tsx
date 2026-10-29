"use client";
import { BadgeCheck, Check, Copy, ExternalLink, KeyRound, Laptop, Link2, Lock, LogOut, Mail, MonitorSmartphone, Pencil, Settings2, ShieldAlert, Smartphone, Trash2, Unlink, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useStore } from "@/lib/store";
import { Stagger, spotlight } from "../fx";
import { PasswordInput } from "../LoginDialog";
import { BrandMark } from "../BrandMark";
import { Avatar, Badge, Button, ConfirmDialog, Dialog, Field, Input, cn } from "../ui";

interface AccountView { email: string; displayName: string | null; emailVerified: boolean; hasPassword: boolean; createdAt: number; identities: Array<{ provider: string; email: string }> }
interface SessionRow { id: string; current: boolean; createdAt: number; lastSeenAt: number; ip: string | null; userAgent: string | null }
interface AccountResponse { account?: AccountView; sessions?: SessionRow[] }

/** "Chrome on macOS" from a user-agent string. Good enough to recognise your own devices; never used for anything else. */
export function describeDevice(ua: string | null): { label: string; mobile: boolean } {
  if (!ua) return { label: "Unknown device", mobile: false };
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return { label: os ? `${browser} on ${os}` : browser, mobile: /Mobi|iPhone|Android/.test(ua) };
}

function Card({ title, icon: Icon, children, tone }: { title: string; icon: LucideIcon; children: React.ReactNode; tone?: "danger" }) {
  return (
    <section onPointerMove={spotlight} aria-label={title} className={cn("card-surface spotlight rounded-2xl p-5", tone === "danger" && "ring-1 ring-err/30")}>
      <h3 className={cn("mb-4 flex items-center gap-2.5 text-sm font-semibold", tone === "danger" && "text-err")}><span className={cn("grid size-7 place-items-center rounded-lg ring-1 ring-inset", tone === "danger" ? "bg-err/10 text-err ring-err/25" : "bg-accent/12 text-accent ring-accent/25")}><Icon className="size-3.5" aria-hidden /></span> {title}</h3>
      {children}
    </section>
  );
}

export function AccountSection() {
  const session = useStore((s) => s.session);
  const methods = useStore((s) => s.methods);
  const toast = useStore((s) => s.toast);
  const [data, setData] = useState<AccountResponse | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [pwOpen, setPwOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [setup, setSetup] = useState<"google" | "github" | null>(null);
  const [unlink, setUnlink] = useState<"google" | "github" | null>(null);

  const load = useCallback(async () => { try { setData(await api<AccountResponse>("/api/account")); } catch { /* the page still shows what the session knows */ } }, []);
  useEffect(() => { void load(); }, [load]);

  const signOut = async (everywhere: boolean) => {
    try { await api(everywhere ? "/api/auth/logout-all" : "/api/auth/logout", { method: "POST" }); location.reload(); }
    catch (e) { toast("error", (e as Error).message); }
  };

  if (!session) return null; // the app shows the sign-in screen instead of ever reaching here
  const account = data?.account;
  const email = account?.email ?? session.user.email ?? "";
  const displayName = account?.displayName ?? session.user.displayName;

  const saveName = async () => {
    const v = name.trim();
    if (!v) return;
    setBusy("name");
    try {
      const r = await api<AccountResponse>("/api/account", { method: "PATCH", body: { displayName: v } });
      setData(r);
      useStore.setState((s) => (s.session ? { session: { ...s.session, user: { ...s.session.user, displayName: r.account?.displayName ?? v } } } : {}));
      setEditingName(false);
      toast("ok", "Name updated.");
    } catch (e) { toast("error", (e as Error).message); } finally { setBusy(null); }
  };

  const savePassword = async () => {
    setBusy("pw"); setPwError(null);
    try {
      const r = await api<{ signedOutOthers: number }>("/api/account/password", { method: "POST", body: { next, current: account?.hasPassword ? current : undefined } });
      setPwOpen(false); setCurrent(""); setNext("");
      toast("ok", `${account?.hasPassword ? "Password changed" : "Password set"}.${r.signedOutOthers ? ` Signed out ${r.signedOutOthers} other session${r.signedOutOthers === 1 ? "" : "s"}.` : ""}`);
      void load();
    } catch (e) { setPwError((e as Error).message); } finally { setBusy(null); }
  };

  const revoke = async (id: string) => {
    try { const r = await api<{ sessions: SessionRow[] }>(`/api/account/sessions/${id}`, { method: "DELETE" }); setData((d) => ({ ...d, sessions: r.sessions })); toast("ok", "That device was signed out."); }
    catch (e) { toast("error", (e as Error).message); }
  };

  const deleteAccount = async () => {
    setBusy("delete");
    try { await api("/api/account", { method: "DELETE", body: { confirmEmail: confirm } }); location.reload(); }
    catch (e) { toast("error", (e as Error).message); setBusy(null); }
  };

  const identity = (p: string) => account?.identities.find((i) => i.provider === p);
  const disconnect = async (p: "google" | "github") => {
    setBusy(`unlink:${p}`);
    try { setData(await api<AccountResponse>(`/api/account/identities/${p}`, { method: "DELETE" })); toast("ok", `${p === "google" ? "Google" : "GitHub"} disconnected.`); }
    catch (e) { toast("error", (e as Error).message); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-6">
      <header>
        <h2 className="font-display text-2xl font-semibold tracking-tight">Account</h2>
        <p className="mt-1 max-w-xl text-sm text-muted">Your chats, documents, memories and designs belong to this account and follow you across devices.</p>
      </header>

      <Stagger className="space-y-4">{[
        // ---- profile
        <section key="profile" aria-label="Profile" className="relative overflow-hidden rounded-3xl border border-line bg-panel/80 backdrop-blur">
          <div className="relative h-24 overflow-hidden" aria-hidden>
            <div className="absolute inset-0 bg-linear-to-r/oklch from-accent/60 via-accent-3/50 to-accent-2/50" />
            <div className="absolute inset-0 dotgrid opacity-40" />
          </div>
          <div className="px-5 pb-5">
            <Avatar name={displayName} email={email} className="-mt-9 size-[72px] border-4 border-panel text-2xl" />
            <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                {editingName ? (
                  <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void saveName(); }}>
                    <Input autoFocus aria-label="Display name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="h-9! w-56" onKeyDown={(e) => e.key === "Escape" && setEditingName(false)} />
                    <Button type="submit" size="sm" variant="primary" loading={busy === "name"} disabled={!name.trim()}><Check className="size-4" aria-hidden /> Save</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditingName(false)} aria-label="Cancel"><X className="size-4" aria-hidden /></Button>
                  </form>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="truncate font-display text-xl font-semibold tracking-tight">{displayName || "Add your name"}</span>
                    <Button size="sm" variant="ghost" onClick={() => { setName(displayName ?? ""); setEditingName(true); }}><Pencil className="size-3.5" aria-hidden /> Edit name</Button>
                  </div>
                )}
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                  <span className="text-fg">{email}</span>
                  {account && (account.emailVerified ? <Badge tone="ok"><BadgeCheck className="size-3" aria-hidden /> Verified</Badge> : <Badge tone="warn">Not verified</Badge>)}
                </p>
                {account && <p className="mt-1 text-xs text-faint">Member since {new Date(account.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => signOut(false)}><LogOut className="size-4" aria-hidden /> Sign out</Button>
                <Button variant="ghost" onClick={() => signOut(true)}>Sign out everywhere</Button>
              </div>
            </div>
            {account && !account.emailVerified && (
              <p className="mt-4 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-fg">
                This address hasn't been proven yet{methods.email ? ": log in once with an email code to verify it" : methods.google || methods.github ? ": log in once with Google or GitHub using it to verify it" : ""}. Until then it can't be linked to other sign-in methods, and if its real owner proves it, they take this account over.
              </p>
            )}
          </div>
        </section>,

        // ---- sign-in methods
        <Card key="methods" title="Sign-in methods" icon={KeyRound}>
          <ul className="space-y-2">
            <li className="method-row">
              <div className="flex flex-wrap items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-raised text-fg ring-1 ring-line"><Lock className="size-[18px]" aria-hidden /></span>
                <div className="min-w-0 flex-1"><div className="flex items-center gap-2 text-sm font-medium">Password{account?.hasPassword && <Badge tone="ok"><Check className="size-3" aria-hidden /> Set</Badge>}</div><p className="text-xs text-muted">{account?.hasPassword ? "Log in with your email and password." : "Not set. Add one to log in without an email code."}</p></div>
                {account && <Button size="sm" variant={account.hasPassword ? "secondary" : "primary"} aria-expanded={pwOpen} onClick={() => { setPwOpen((o) => !o); setPwError(null); }}>{account.hasPassword ? "Change password" : "Set a password"}</Button>}
              </div>
              {pwOpen && account && (
                <form aria-label="Password" className="mt-4 space-y-3 rounded-xl border border-line bg-sunken/50 p-4 animate-rise" onSubmit={(e) => { e.preventDefault(); void savePassword(); }}>
                  {account.hasPassword && <PasswordInput id="acct-current" label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" />}
                  <PasswordInput id="acct-next" label="New password" value={next} onChange={setNext} autoComplete="new-password" meter />
                  {pwError && <p role="alert" className="text-sm text-err">{pwError}</p>}
                  <p className="text-xs text-muted">Your other devices will be signed out.</p>
                  <div className="flex gap-2"><Button type="submit" variant="primary" loading={busy === "pw"} disabled={next.length < 10 || (account.hasPassword && !current)}>Save password</Button><Button type="button" variant="ghost" onClick={() => setPwOpen(false)}>Cancel</Button></div>
                </form>
              )}
            </li>
            <li className="method-row flex flex-wrap items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-raised text-fg ring-1 ring-line"><Mail className="size-[18px]" aria-hidden /></span>
              <div className="min-w-0 flex-1"><div className="text-sm font-medium">Email code</div><p className="text-xs text-muted">{methods.email ? `A 6-digit code sent to ${email}.` : "Not available on this server."}</p></div>
              <Badge tone={methods.email ? "ok" : "neutral"}>{methods.email ? "Available" : "Off"}</Badge>
            </li>
            {(["google", "github"] as const).map((p) => {
              const label = p === "google" ? "Google" : "GitHub";
              const id = identity(p);
              const enabled = methods[p];
              return (
                <li key={p} className={cn("method-row group flex flex-wrap items-center gap-3", id && "method-row-on")}>
                  <BrandMark kind={p} active={!!id} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">{label}{id && <Badge tone="ok"><Link2 className="size-3" aria-hidden /> Connected</Badge>}</div>
                    <p className="truncate text-xs text-muted">{id ? `Linked (${id.email}).` : enabled ? `Connect your ${label} account to sign in with one click.` : "Not set up on this server yet."}</p>
                  </div>
                  {id ? (
                    <Button size="sm" variant="ghost" className="hover:bg-err/10 hover:text-err" loading={busy === `unlink:${p}`} onClick={() => setUnlink(p)} aria-label={`Disconnect ${label}`}><Unlink className="size-3.5" aria-hidden /> Disconnect</Button>
                  ) : enabled ? (
                    <a href={`/api/auth/oauth/${p}/start?link=1`} className="btn-surface inline-flex h-8 items-center gap-2 rounded-xl px-3 text-[13px] font-medium text-fg transition-[translate,box-shadow] duration-200 hover:-translate-y-px active:translate-y-0 active:scale-[0.97] pointer-coarse:min-h-11"><Link2 className="size-3.5" aria-hidden /> Connect {label}</a>
                  ) : (
                    <Button size="sm" variant="soft" onClick={() => setSetup(p)}><Settings2 className="size-3.5" aria-hidden /> Set up</Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>,

        // ---- sessions
        <Card key="sessions" title="Where you're signed in" icon={MonitorSmartphone}>
          {!data?.sessions ? <p className="text-sm text-muted">Loading your devices…</p> : (
            <ul className="space-y-2" aria-label="Active sessions">
              {data.sessions.map((s) => {
                const d = describeDevice(s.userAgent);
                const Icon = d.mobile ? Smartphone : Laptop;
                return (
                  <li key={s.id} className={cn("flex items-center gap-3 rounded-xl border px-3 py-2.5", s.current ? "border-accent/40 bg-accent/5" : "border-line bg-raised/40")}>
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-raised text-muted"><Icon className="size-4" aria-hidden /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">{d.label}{s.current && <Badge tone="accent">This device</Badge>}</div>
                      <div className="text-xs tabular-nums text-muted">Active {timeAgo(s.lastSeenAt)}{s.ip ? ` · ${s.ip}` : ""} · since {new Date(s.createdAt).toLocaleDateString()}</div>
                    </div>
                    {!s.current && <Button size="sm" variant="ghost" onClick={() => void revoke(s.id)} aria-label={`Sign out ${d.label}`}><LogOut className="size-3.5" aria-hidden /> Sign out</Button>}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>,

        // ---- danger zone
        <Card key="danger" title="Delete account" icon={ShieldAlert} tone="danger">
          <p className="text-sm leading-relaxed text-muted">Permanently removes this account with everything in it: chats, documents, memories, designs, workspace files, provider keys and sign-in methods. This can't be undone.</p>
          {!deleting ? (
            <Button variant="danger" className="mt-4" onClick={() => setDeleting(true)}><Trash2 className="size-4" aria-hidden /> Delete my account</Button>
          ) : (
            <div className="mt-4 space-y-3 animate-rise">
              <Field label={`Type ${email} to confirm`} htmlFor="delete-confirm"><Input id="delete-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" placeholder={email} /></Field>
              <div className="flex gap-2">
                <Button variant="danger" loading={busy === "delete"} disabled={confirm.trim().toLowerCase() !== email.toLowerCase()} onClick={() => void deleteAccount()}>Delete forever</Button>
                <Button variant="ghost" onClick={() => { setDeleting(false); setConfirm(""); }}>Cancel</Button>
              </div>
            </div>
          )}
        </Card>,
      ]}</Stagger>
      <OAuthSetupDialog provider={setup} onClose={() => setSetup(null)} />
      <ConfirmDialog open={!!unlink} title={`Disconnect ${unlink === "google" ? "Google" : "GitHub"}?`} confirm="Disconnect"
        body={<>You won't be able to sign in with it until you connect it again. Your chats and data stay where they are.</>}
        onConfirm={() => unlink && void disconnect(unlink)} onClose={() => setUnlink(null)} />
    </div>
  );
}

function CopyField({ label, value, block }: { label: string; value: string; block?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div>
      <div className={cn("mb-1 text-[11px] font-semibold tracking-[0.08em] text-faint", !label.startsWith(".") && "uppercase")}>{label}</div>
      <div className={cn("group flex gap-2 rounded-xl border border-line bg-sunken/80 pl-3 pr-1 transition hover:border-faint/50", block ? "items-start py-2" : "items-center py-1")}>
        {block
          ? <pre className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-[12.5px] leading-relaxed text-fg">{value.split("\n").map((l, i) => <span key={i} className={cn("block", l.startsWith("#") && "text-faint")}>{l}</span>)}</pre>
          : <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg" title={value}>{value}</code>}
        <button type="button" aria-label={`Copy ${label}`} onClick={() => { void navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1400); }}
          className={cn("grid size-8 shrink-0 place-items-center rounded-lg transition active:scale-90 pointer-coarse:size-11", done ? "bg-ok/15 text-ok" : "text-muted hover:bg-fg/[0.07] hover:text-fg")}>
          {done ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        </button>
      </div>
    </div>
  );
}

/** Step-by-step setup for a sign-in provider the server hasn't been given credentials for yet. */
function OAuthSetupDialog({ provider, onClose }: { provider: "google" | "github" | null; onClose: () => void }) {
  if (!provider) return null;
  const origin = typeof location === "undefined" ? "" : location.origin;
  const label = provider === "google" ? "Google" : "GitHub";
  const callback = `${origin}/api/auth/oauth/${provider}/callback`;
  const ENV = provider === "google" ? "GOOGLE" : "GITHUB";
  const steps: Array<{ title: string; body: React.ReactNode }> = provider === "google" ? [
    { title: "Create an OAuth client", body: <>Open <a className="inline-flex items-center gap-0.5 text-accent hover:underline" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud → Credentials <ExternalLink className="size-3" aria-hidden /></a>, choose <b>Create credentials → OAuth client ID → Web application</b>. Configure the consent screen if asked (scopes: openid, email, profile).</> },
    { title: "Add the redirect URI", body: <>Under <b>Authorised redirect URIs</b> paste the address below exactly.</> },
    { title: "Give Morphie the keys", body: <>Add these lines to <code className="font-mono">.env.local</code> in the project folder (or your host's environment) and restart the server.</> },
  ] : [
    { title: "Register an OAuth app", body: <>Open <a className="inline-flex items-center gap-0.5 text-accent hover:underline" href="https://github.com/settings/applications/new" target="_blank" rel="noopener noreferrer">GitHub → Developer settings → New OAuth App <ExternalLink className="size-3" aria-hidden /></a>. Homepage URL: <code className="font-mono">{origin}</code>.</> },
    { title: "Set the callback URL", body: <>Paste the address below into <b>Authorization callback URL</b>, register, then <b>Generate a new client secret</b>.</> },
    { title: "Give Morphie the keys", body: <>Add these lines to <code className="font-mono">.env.local</code> in the project folder (or your host's environment) and restart the server.</> },
  ];
  return (
    <Dialog open onClose={onClose} title={`Set up ${label} sign-in`} description={`A one-time server setup. After a restart, "Connect ${label}" appears here.`} width="max-w-xl" icon={<BrandMark kind={provider} size="lg" active />}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <ol className="relative space-y-5 before:absolute before:bottom-3 before:left-[13px] before:top-3 before:w-px before:bg-linear-to-b before:from-accent/60 before:via-line before:to-transparent">
        {steps.map((st, i) => (
          <li key={i} className="relative flex gap-4">
            <span className="relative z-10 grid size-7 shrink-0 place-items-center rounded-full bg-panel text-xs font-semibold text-accent ring-1 ring-accent/40 shadow-[0_0_12px_-2px_rgb(var(--accent)/0.6)]">{i + 1}</span>
            <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
              <div className="text-sm font-medium">{st.title}</div>
              <p className="text-[13px] leading-relaxed text-muted">{st.body}</p>
              {i === 1 && <CopyField label="Redirect URI" value={callback} />}
              {i === 2 && <CopyField label=".env.local" block value={`# ${label} sign-in\n${ENV}_CLIENT_ID=your-client-id\n${ENV}_CLIENT_SECRET=your-client-secret\n# required in production (https):\n# MORPHIE_PUBLIC_URL=${origin}`} />}
            </div>
          </li>
        ))}
      </ol>
    </Dialog>
  );
}
