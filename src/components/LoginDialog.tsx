"use client";
import { AlertCircle, Bot, Brain, Eye, EyeOff, FileSearch, KeyRound, Mail, MessagesSquare, ShieldCheck, Sparkles, WandSparkles } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { TAB_LABELS, getLoginTrigger, useStore } from "@/lib/store";
import { BlurIn } from "./fx";
import { Button, Dialog, Field, Input, Logo, Segmented, cn } from "./ui";

export const AUTH_ERRORS: Record<string, string> = {
  state_mismatch: "That login didn't start in this browser, so it was stopped. Please try again.",
  expired: "That login took too long. Please try again.",
  denied: "Login was cancelled.",
  unverified_email: "That account's email isn't verified with the provider, so it can't be used to log in.",
  provider_error: "The login provider had a problem. Please try again.",
  identity_taken: "That account is already connected to a different Morphie account. Sign in to that one to disconnect it first.",
  link_session: "Your session changed while connecting. Sign in again, then connect.",
};

/**
 * The only way in: one popup for logging in and signing up (the same step does both). A visitor sees the page and the
 * Chat tab; anything else that needs an account opens this over a dimmed, blurred, inert page. Closing it (Esc,
 * clicking outside, the X) changes nothing and returns focus to whatever opened it.
 */
export function LoginDialog() {
  const open = useStore((s) => s.loginOpen);
  const closeLogin = useStore((s) => s.closeLogin);
  const wanted = useStore((s) => s.pendingTab);
  const intro = "New here? The same step creates your account.";
  return (
    <Dialog
      open={open} onClose={closeLogin} title="Log in or sign up" width="max-w-md md:max-w-3xl"
      description={wanted && wanted !== "chat" ? `Log in required to open ${TAB_LABELS[wanted]}. ${intro}` : intro}
      returnFocus={getLoginTrigger} scrimClassName="backdrop-blur-md" aside={<BrandPanel />}
    >
      <LoginForm />
    </Dialog>
  );
}

const FEATURES = [
  { icon: MessagesSquare, text: "Chat with any model" }, { icon: Bot, text: "Agents that ask first" }, { icon: WandSparkles, text: "Design studio" },
  { icon: FileSearch, text: "Search your documents" }, { icon: Brain, text: "Long-term memory" }, { icon: ShieldCheck, text: "Keys encrypted at rest" },
];

/** The decorative side of the login popup: aurora, the mark, a headline, and a drifting row of what Morphie does. */
function BrandPanel() {
  const reduce = useReducedMotion();
  return (
    <div className="relative flex h-full flex-col justify-between overflow-hidden bg-sunken p-7">
      <div className="absolute -left-16 -top-16 size-64 rounded-full bg-accent/40 blur-3xl" />
      <div className="absolute -bottom-20 -right-10 size-64 rounded-full bg-accent-2/30 blur-3xl" />
      <div className="absolute inset-0 dotgrid opacity-60" />
      <motion.div className="relative" initial={reduce ? false : { rotate: -12, scale: 0.8, opacity: 0 }} animate={{ rotate: 0, scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }}>
        <Logo className="size-12 drop-shadow-[0_10px_30px_rgb(var(--accent)/0.55)]" />
      </motion.div>
      <div className="relative">
        <p className="font-display text-3xl font-semibold leading-tight tracking-tight">
          <BlurIn delay={0.1} lines={["Your models.", <span key="g" className="text-gradient">One workspace.</span>]} />
        </p>
        <p className="mt-3 max-w-[16rem] text-sm leading-relaxed text-muted">Chat, agents, design and documents, with whichever AI provider you bring.</p>
      </div>
      <div className="marquee-wrap relative -mx-7 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_15%,#000_85%,transparent)]">
        <div className="marquee">
          {[...FEATURES, ...FEATURES].map((f, i) => (
            <span key={i} className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-panel/70 px-3 py-1.5 text-xs text-muted backdrop-blur"><f.icon className="size-3.5 text-accent" />{f.text}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Six boxes drawn over one real input (the child), so paste, autofill of one-time codes, screen readers and tests all
 * see a single ordinary field. The box after the last digit glows while the field has focus.
 */
function CodeBoxes({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <div className="group/code relative">
      {children}
      <div className="grid grid-cols-6 gap-2" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => {
          const ch = value[i];
          const next = i === Math.min(value.length, 5) && value.length < 6;
          return (
            <span key={i} className={cn("grid h-12 place-items-center rounded-xl border bg-sunken/70 font-mono text-xl font-semibold tabular-nums transition duration-200",
              ch ? "border-accent/50 bg-accent/[0.07] text-fg" : "border-line text-faint",
              next && "group-focus-within/code:border-accent group-focus-within/code:shadow-[0_0_0_4px_rgb(var(--accent)/0.15)]")}>
              {ch ? <span className="check-pop">{ch}</span> : next ? <span className="h-5 w-px animate-pulse-dot bg-accent opacity-0 group-focus-within/code:opacity-100" /> : "·"}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Rough strength (0-4) for the meter: length and variety. Advice only; the server enforces the real rule. */
export function passwordScore(pw: string): number {
  if (!pw) return 0;
  let s = pw.length >= 10 ? 1 : 0;
  if (pw.length >= 14) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  else if (/\d|[^A-Za-z0-9]/.test(pw) || pw.includes(" ")) s += pw.length >= 16 ? 1 : 0;
  return Math.min(4, s);
}
const SCORE_LABEL = ["Too short", "Okay", "Good", "Strong", "Excellent"];

export function PasswordInput({ id, value, onChange, autoComplete, label = "Password", meter, onEnter }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; label?: string; meter?: boolean; onEnter?: () => void }) {
  const [show, setShow] = useState(false);
  const score = passwordScore(value);
  return (
    <Field label={label} htmlFor={id}>
      <div className="relative">
        <Input id={id} type={show ? "text" : "password"} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} className="pr-11" maxLength={200}
          onKeyDown={(e) => { if (e.key === "Enter" && onEnter) { e.preventDefault(); onEnter(); } }} />
        <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}
          className="absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-muted transition hover:bg-raised hover:text-fg pointer-coarse:size-11">
          {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      </div>
      {meter && value && (
        <div className="flex items-center gap-2 pt-1" aria-live="polite">
          <div className="flex flex-1 gap-1" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-1 flex-1 overflow-hidden rounded-full bg-line">
                <motion.span className={cn("block h-full rounded-full", score >= 3 ? "bg-ok" : score >= 2 ? "bg-accent" : "bg-warn")} initial={false} animate={{ width: i < score ? "100%" : "0%" }} transition={{ type: "spring", stiffness: 300, damping: 30 }} />
              </span>
            ))}
          </div>
          <span className={cn("w-20 text-right text-xs", score >= 3 ? "text-ok" : "text-muted")}>{SCORE_LABEL[score]}</span>
        </div>
      )}
    </Field>
  );
}

/** Email + password: log in, or create an account. Works with no mail server at all. */
function PasswordForm({ onDone, onForgot }: { onDone: (created: boolean) => Promise<void>; onForgot?: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = email.includes("@") && password.length >= (mode === "signup" ? 10 : 1) && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      if (mode === "login") await api("/api/auth/password/login", { method: "POST", body: { email, password } });
      else await api("/api/auth/password/signup", { method: "POST", body: { email, password, name: name.trim() || undefined } });
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    await onDone(mode === "signup");
  };
  return (
    <form className="space-y-3" aria-label={mode === "login" ? "Log in with a password" : "Create an account"} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {mode === "signup" && (
        <Field label="Name (optional)" htmlFor="pw-name"><Input id="pw-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Ada Lovelace" /></Field>
      )}
      <Field label="Email" htmlFor="pw-email"><Input id="pw-email" data-autofocus type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></Field>
      <PasswordInput id="pw-password" value={password} onChange={setPassword} autoComplete={mode === "login" ? "current-password" : "new-password"} meter={mode === "signup"} />
      {/* Forgot it: log in with an email code instead, then set a new password in Account. Only where email works. */}
      {mode === "login" && onForgot && <div className="-mt-1 text-right"><button type="button" onClick={onForgot} className="text-xs font-medium text-accent underline-offset-4 hover:underline pointer-coarse:min-h-11">Forgot password?</button></div>}
      {mode === "signup" && <p className="text-xs text-muted">At least 10 characters. A few random words make a strong, memorable password.</p>}
      {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-err/30 bg-err/[0.07] px-3 py-2 text-sm text-err"><AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />{error}</p>}
      <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!ready}><KeyRound className="size-4" aria-hidden /> {mode === "login" ? "Log in" : "Create account"}</Button>
      <p className="text-center text-sm text-muted">
        {mode === "login" ? "New here? " : "Already have an account? "}
        <button type="button" className="font-medium text-accent underline-offset-4 hover:underline pointer-coarse:min-h-11" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(null); }}>
          {mode === "login" ? "Create an account" : "Log in instead"}
        </button>
      </p>
    </form>
  );
}

/** A link that looks like a secondary Button: one tab stop, no button nested inside an anchor. */
const PROVIDER_LINK = "btn-surface spotlight inline-flex h-10 flex-1 basis-40 pointer-coarse:h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium text-fg transition-[translate,box-shadow,scale] duration-200 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98]";

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
      <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z" />
    </svg>
  );
}

/** Google's "G" in its own colours (a brand mark, so not themed). */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.1-4 1.1-3.1 0-5.7-2.1-6.6-4.9h-4v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.4 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8z" />
    </svg>
  );
}

function LoginForm() {
  const methods = useStore((s) => s.methods);
  const boot = useStore((s) => s.boot);
  const toast = useStore((s) => s.toast);
  const saveLoginRedirect = useStore((s) => s.saveLoginRedirect);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the server says about delivery: "console" (development: nothing is emailed) or "failing" (the mail server rejected the last send).
  const [delivery, setDelivery] = useState<"console" | "failing" | null>(null);
  // Development without a mail server: the server hands the code over too, and it is filled in.
  const [devCode, setDevCode] = useState<string | null>(null);
  const [way, setWay] = useState<"password" | "email">(methods.password ? "password" : "email");
  const [attempt, setAttempt] = useState(0);
  const emailField = useRef<HTMLInputElement>(null);
  const hadCode = useRef(false);

  // Keyboard users shouldn't have to hunt: after the code is sent focus is on the code field (autoFocus below),
  // and if they pick a different address focus goes back to the email field.
  useEffect(() => { if (sentTo) hadCode.current = true; else if (hadCode.current) emailField.current?.focus(); }, [sentTo]);

  // A failed send happens after the answer has gone out, so look again shortly: the server remembers it (about itself, not the address).
  useEffect(() => {
    if (!attempt || delivery === "console") return;
    const timers = [3500, 9000].map((ms) => setTimeout(async () => {
      try { const s = await api<{ emailDelivery?: string }>("/api/auth/session"); setDelivery(s.emailDelivery === "failing" ? "failing" : null); } catch { /* keep what we have */ }
    }, ms));
    return () => timers.forEach(clearTimeout);
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (wait <= 0) return; const t = setTimeout(() => setWait(wait - 1), 1000); return () => clearTimeout(t); }, [wait]);

  const sendCode = async (address: string) => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ resendAfterSeconds: number; delivery?: "console" | "failing"; devCode?: string }>("/api/auth/email/request", { method: "POST", body: { email: address } });
      setSentTo(address.trim()); setWait(r.resendAfterSeconds); setCode(r.devCode ?? ""); setDevCode(r.devCode ?? null); setDelivery(r.delivery ?? null); setAttempt((n) => n + 1);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError(null);
    let passwordReset = false;
    try {
      const r = await api<{ passwordReset?: boolean }>("/api/auth/email/verify", { method: "POST", body: { email: sentTo, code } });
      passwordReset = !!r.passwordReset;
    } catch (e) { setError((e as Error).message); setBusy(false); return; }
    await finish(false, passwordReset);
  };
  // Signed in: load the account's data, which also closes this popup and resumes what the visitor was doing.
  const finish = async (created: boolean, passwordReset = false) => {
    await boot();
    if (!useStore.getState().session) return;
    toast("ok", created ? "Welcome to Morphie! Your account is ready." : "Logged in.");
    if (passwordReset) toast("info", "This email is now verified, so the password someone set for it was removed. Set a new one in Account.");
  };

  const noMethods = !methods.email && !methods.google && !methods.github && !methods.password;
  if (noMethods) {
    return <p className="text-sm text-muted">Login isn't set up on this server yet. Whoever runs it needs to turn on email codes, Google or GitHub (see the README).</p>;
  }

  const both = !!methods.password && methods.email;
  return (
    <div className="space-y-5">
      {both && (
        <Segmented kind="tab" label="How to log in" value={way} onChange={(v) => { setWay(v); setError(null); }} className="w-full [&>button]:flex-1"
          options={[{ value: "password", label: <><KeyRound className="size-4" aria-hidden /> Password</> }, { value: "email", label: <><Mail className="size-4" aria-hidden /> Email code</> }]} />
      )}
      {methods.password && way === "password" && <PasswordForm onDone={(created) => finish(created)} onForgot={methods.email ? () => { setWay("email"); setError(null); } : undefined} />}
      {methods.email && (!methods.password || way === "email") && (
        <section className="space-y-3" aria-label="Email">
          <Field label="Email address" htmlFor="login-email">
            <Input id="login-email" ref={emailField} data-autofocus type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" disabled={!!sentTo} onKeyDown={(e) => { if (e.key === "Enter" && !sentTo && email.includes("@") && !busy) void sendCode(email); }} />
          </Field>
          {!sentTo ? (
            <Button variant="primary" className="w-full" loading={busy} disabled={!email.includes("@")} onClick={() => sendCode(email)}><Mail className="size-4" aria-hidden /> Email me a code</Button>
          ) : (
            <div className="space-y-3">
              {devCode && (
                <p role="note" className="flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-fg">
                  <Sparkles className="size-4 shrink-0 text-accent" aria-hidden />
                  <span>Your code is <strong className="font-mono tracking-widest">{devCode}</strong>. It's filled in below: press Log in.</span>
                </p>
              )}
              {delivery === "console" ? (
                <p role="note" className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-fg">
                  Development mode: <strong>no email is sent</strong>. The code is printed in the terminal where the server is running, on lines starting with <code className="font-mono text-[13px]">[email:dev]</code>. It's valid for 10 minutes; type it here.
                </p>
              ) : (
                <p className="text-sm text-muted">If that address can receive email, a 6-digit code is on its way. It's valid for 10 minutes. Keep this page open and type it here.</p>
              )}
              {delivery === "failing" && (
                <p role="alert" className="text-sm text-err">
                  We couldn't send the email just now. Please try again in a few minutes{methods.google || methods.github ? ", or continue with Google or GitHub below" : ""}. If you run this server, the reason is in its log.
                </p>
              )}
              <Field label="6-digit code" htmlFor="login-code">
                <CodeBoxes value={code}>
                  <input id="login-code" autoFocus data-autofocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className="peer absolute inset-0 z-10 w-full cursor-text bg-transparent text-transparent caret-transparent opacity-0 outline-hidden" onKeyDown={(e) => { if (e.key === "Enter" && code.length === 6 && !busy) void verify(); }} />
                </CodeBoxes>
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" loading={busy} disabled={code.length !== 6} onClick={verify}>Log in</Button>
                <Button variant="ghost" className="tabular-nums" disabled={wait > 0 || busy} onClick={() => sendCode(sentTo)}>{wait > 0 ? `Send again in ${wait}s` : "Send again"}</Button>
                <Button variant="ghost" onClick={() => { setSentTo(null); setCode(""); setError(null); setDelivery(null); }}>Use a different address</Button>
              </div>
            </div>
          )}
        </section>
      )}
      {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-err/30 bg-err/[0.07] px-3 py-2 text-sm text-err"><AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />{error}</p>}
      {(methods.google || methods.github) && (
        <section className="space-y-3" aria-label="Other ways to log in">
          <h3 className="flex items-center gap-3 text-xs font-medium uppercase tracking-[0.08em] text-faint"><span className="h-px flex-1 bg-line" />{methods.email || methods.password ? "Or continue with" : "Continue with"}<span className="h-px flex-1 bg-line" /></h3>
          <div className="flex flex-wrap gap-2">
            {/* Leaving for the provider reloads the page: keep only the tab and the draft for the way back. */}
            {methods.google && <a href="/api/auth/oauth/google/start?returnTo=/" onClick={saveLoginRedirect} className={PROVIDER_LINK}><GoogleMark /> Continue with Google</a>}
            {methods.github && <a href="/api/auth/oauth/github/start?returnTo=/" onClick={saveLoginRedirect} className={PROVIDER_LINK}><GitHubMark /> Continue with GitHub</a>}
          </div>
          <p className="text-xs text-faint">Only an email the provider has verified is accepted. The same verified email always opens the same account.</p>
        </section>
      )}
    </div>
  );
}
