/** Persist last Control session so refresh / phone can resume the same hub session. */

const KEY = "promedia.control.session.v1";

export type PersistedControlSession = {
  code: string;
  accessToken?: string;
  savedAt: number;
};

function readStore(storage: Storage): PersistedControlSession | null {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedControlSession;
    if (!parsed?.code || typeof parsed.code !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStore(storage: Storage, payload: PersistedControlSession): void {
  try {
    storage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // private mode / quota
  }
}

export function loadPersistedControlSession(): PersistedControlSession | null {
  // Prefer localStorage (survives tab close; shared across Control tabs).
  const local = readStore(window.localStorage);
  if (local) {
    return local;
  }
  // Migrate legacy sessionStorage entries once.
  const legacy = readStore(window.sessionStorage);
  if (legacy) {
    writeStore(window.localStorage, legacy);
    try {
      window.sessionStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    return legacy;
  }
  return null;
}

export function savePersistedControlSession(opts: {
  code: string;
  accessToken?: string;
}): void {
  const payload: PersistedControlSession = {
    code: opts.code,
    accessToken: opts.accessToken,
    savedAt: Date.now(),
  };
  writeStore(window.localStorage, payload);
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

export function clearPersistedControlSession(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
