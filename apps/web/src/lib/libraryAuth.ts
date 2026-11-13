/**
 * Credentials for Biblioteca HTTP calls (hub requires control operator).
 * Updated from the active Control session (wsTicket / accessToken).
 */

type LibraryAuth = {
  credential?: string;
  accessToken?: string;
};

let current: LibraryAuth = {};

export function setLibraryAuth(next: LibraryAuth): void {
  current = {
    credential: next.credential?.trim() || undefined,
    accessToken: next.accessToken?.trim() || undefined,
  };
}

export function clearLibraryAuth(): void {
  current = {};
}

export function libraryAuthHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  // Send both: after a hub restart the wsTicket dies first; the hub can still
  // accept the accessToken when the Bearer ticket is stale.
  if (current.credential) {
    headers.Authorization = `Bearer ${current.credential}`;
  }
  if (current.accessToken) {
    headers["X-ProMedia-Access-Token"] = current.accessToken;
  }
  return headers;
}

/** Append token query for <a href> downloads that cannot set headers. */
export function libraryAuthQuery(): string {
  if (current.credential) {
    return `credential=${encodeURIComponent(current.credential)}`;
  }
  if (current.accessToken) {
    return `accessToken=${encodeURIComponent(current.accessToken)}`;
  }
  return "";
}
