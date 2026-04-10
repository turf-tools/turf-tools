import * as Crypto from "expo-crypto";

// Generate a fresh UUID for a single canvass-result mutation. The native app
// passes this through to the server submit RPCs, which use it as an
// idempotency key — a retried network call writes one row, not many.
export function newClientMutationId(): string {
  return Crypto.randomUUID();
}
