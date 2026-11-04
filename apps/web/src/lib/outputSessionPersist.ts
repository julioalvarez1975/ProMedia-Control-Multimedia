/** Persist last Output join so a projector refresh stays on the same session. */

const KEY = "promedia.output.session.v1";

export type PersistedOutputSession = {
  code?: string;
  accessToken?: string;
  savedAt: number;
};

export function loadPersistedOutputSession(): PersistedOutputSession | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedOutputSession;
    if (!parsed?.code && !parsed?.accessToken) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function savePersistedOutputSession(opts: {
  code?: string;
  accessToken?: string;
}): void {
  try {
    const payload: PersistedOutputSession = {
      code: opts.code?.trim().toUpperCase() || undefined,
      accessToken: opts.accessToken?.trim() || undefined,
      savedAt: Date.now(),
    };
    if (!payload.code && !payload.accessToken) {
      return;
    }
    window.localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}
