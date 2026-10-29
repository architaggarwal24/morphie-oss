import { emailLoginEnabled } from "../email";
import { oauthProviderEnabled } from "./oauth";

/** Email + password is on unless MORPHIE_PASSWORD_LOGIN=false. It needs no mail server, so it always works. */
export const passwordLoginEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.MORPHIE_PASSWORD_LOGIN?.trim().toLowerCase() !== "false";

/** Which sign-in methods this server offers right now (drives the sign-in dialog). */
export function loginMethods(): { email: boolean; google: boolean; github: boolean; password: boolean } {
  return { email: emailLoginEnabled(), google: oauthProviderEnabled("google"), github: oauthProviderEnabled("github"), password: passwordLoginEnabled() };
}
