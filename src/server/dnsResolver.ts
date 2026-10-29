import dns from "node:dns";

export type Resolver = (hostname: string, opts: dns.LookupAllOptions) => Promise<dns.LookupAddress[]>;

const defaultResolver: Resolver = (hostname, opts) =>
  new Promise((resolve, reject) => dns.lookup(hostname, opts, (err, addrs) => (err ? reject(err) : resolve(addrs))));

let current: Resolver = defaultResolver;

/** The one place hostnames are resolved, so the pre-check and the connection can be tested (and trusted) together. */
export const resolveAll: Resolver = (hostname, opts) => current(hostname, opts);

/** Test hook: replace DNS (pass undefined to restore). */
export function _setResolverForTests(r?: Resolver): void {
  current = r ?? defaultResolver;
}
