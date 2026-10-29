// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSection } from "@/components/settings/AccountSection";
import { useStore } from "@/lib/store";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let calls: Array<{ url: string; method: string; body: any }> = [];
const reload = vi.fn();

beforeEach(async () => {
  calls = []; reload.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    return json({ ok: true });
  }));
  vi.stubGlobal("location", { ...window.location, reload, pathname: "/" });
});
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); useStore.setState(useStore.getInitialState()); });

describe("Account section", () => {
  it("shows the account and offers sign out and sign out everywhere", async () => {
    useStore.setState({ session: { user: { email: "ada@example.com", displayName: "Ada" }, expiresAt: Date.now() + 86_400_000, idleExpiresAt: Date.now() + 86_400_000 } });
    const user = userEvent.setup();
    render(<AccountSection />);
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.queryByText(/guest/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: /Sign out everywhere/i }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/auth/logout-all" && c.method === "POST")).toBe(true));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("plain sign out ends only this browser's session", async () => {
    useStore.setState({ session: { user: { email: "ada@example.com", displayName: null }, expiresAt: 1, idleExpiresAt: 1 } });
    const user = userEvent.setup();
    render(<AccountSection />);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/auth/logout" && c.method === "POST")).toBe(true));
  });
});
