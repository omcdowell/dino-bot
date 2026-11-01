import { compare } from "bcryptjs";
import type { WSHelloMessage } from "@getpaseo/protocol/messages";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { matchesLocalCredential } from "./local-credential.js";
import type { SessionAdmission } from "./websocket-server.js";

export type AdmissionFailure = "password_required" | "incorrect_password" | "session_token_invalid";

/** How the hello proved itself; a token is issued only after a password or a token due for renewal. */
export type AdmissionMethod = "open" | "password" | "localCredential" | "sessionToken" | "relay";

type AdmissionResolution =
  | { admission: SessionAdmission; method: AdmissionMethod; renewToken?: boolean }
  | { rejection: AdmissionFailure };

export type SessionTokenVerifier = (
  token: string,
) => { principalId: string; permissions: SessionAdmission["permissions"]; renew: boolean } | null;

export async function resolveSessionAdmission(input: {
  credential: WSHelloMessage["auth"];
  passwordHash: string | undefined;
  localCredential: string | null;
  transport: "direct" | "relay";
  verifySessionToken?: SessionTokenVerifier;
}): Promise<AdmissionResolution> {
  const { credential, passwordHash, localCredential, transport } = input;
  const owner = { principalId: "owner", permissions: OWNER_PERMISSIONS };
  if (!passwordHash) {
    return { admission: owner, method: "open" };
  }
  if (!credential) {
    // COMPAT(relayPasswordOptional): added in v0.9.1, remove once release N mobile builds are live on App Store and Play.
    if (transport === "relay") {
      return { admission: owner, method: "relay" };
    }
    return { rejection: "password_required" };
  }
  if (credential.kind === "localCredential") {
    if (localCredential && matchesLocalCredential(localCredential, credential.token)) {
      return { admission: owner, method: "localCredential" };
    }
    return { rejection: "incorrect_password" };
  }
  if (credential.kind === "sessionToken") {
    const verified = input.verifySessionToken?.(credential.token) ?? null;
    if (!verified) return { rejection: "session_token_invalid" };
    return {
      admission: { principalId: verified.principalId, permissions: verified.permissions },
      method: "sessionToken",
      renewToken: verified.renew,
    };
  }
  return (await compare(credential.password, passwordHash))
    ? { admission: owner, method: "password" }
    : { rejection: "incorrect_password" };
}
