/** Who is making a request. Every data-access function takes one and scopes by `userId` internally. */
export interface Actor {
  userId: string;
  /** SHA-256 of the session token (never the token itself). */
  sessionId: string;
}

/**
 * Who may call a route. There is no anonymous identity: a visitor without a valid session is nobody, and
 * everything except `public` routes (the page itself, bootstrap, health, the login flow) answers them with 401.
 */
export type AuthLevel = "public" | "user";
