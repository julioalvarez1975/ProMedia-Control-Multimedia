/**
 * Open / focus the Output window as a full-canvas on the secondary display
 * (Window Management API), then ask Output to enter fullscreen.
 *
 * Limits: browsers need a user gesture for popup + screen permission;
 * true fullscreen (no address bar) still needs a gesture in the Output window
 * or successful `requestFullscreen({ screen })` after Window Management grant.
 */

export const OUTPUT_WINDOW_NAME = "promedia-output";

/** Same-origin Control ↔ Output bus (avoids window.open blank tabs on mobile). */
export const OUTPUT_BROADCAST_CHANNEL = "promedia-output-bus";

const PLACEMENT_CACHE_KEY = "promedia.output.placement.v1";

/** Last Output window opened from this Control tab (may be null / closed). */
let retainedOutputWindow: Window | null = null;

function rememberOutputWindow(win: Window | null): void {
  retainedOutputWindow = win && !win.closed ? win : null;
}

export type OutputPlacement = {
  left: number;
  top: number;
  width: number;
  height: number;
  /** True when coordinates came from getScreenDetails() on a non-current screen. */
  onSecondary: boolean;
  /** Window Management API available and used successfully. */
  usedScreenDetails: boolean;
};

export type OpenOutputResult = {
  url: string;
  opened: boolean;
  focusedExisting: boolean;
  placement: OutputPlacement | null;
  /** Popup blocked — caller should show the URL. */
  popupBlocked: boolean;
};

type ScreenDetailedLike = {
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  isPrimary?: boolean;
};

type ScreenDetailsLike = {
  screens: readonly ScreenDetailedLike[];
  currentScreen: ScreenDetailedLike;
};

function screensApi():
  | { getScreenDetails: () => Promise<ScreenDetailsLike> }
  | null {
  const w = window as Window & {
    getScreenDetails?: () => Promise<ScreenDetailsLike>;
  };
  return typeof w.getScreenDetails === "function"
    ? { getScreenDetails: () => w.getScreenDetails!() }
    : null;
}

function readCachedPlacement(): OutputPlacement | null {
  try {
    const raw = window.sessionStorage.getItem(PLACEMENT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OutputPlacement;
    if (
      typeof parsed?.left !== "number" ||
      typeof parsed?.top !== "number" ||
      typeof parsed?.width !== "number" ||
      typeof parsed?.height !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function cachePlacement(placement: OutputPlacement): void {
  try {
    window.sessionStorage.setItem(
      PLACEMENT_CACHE_KEY,
      JSON.stringify(placement),
    );
  } catch {
    // ignore
  }
}

function placementFromScreen(
  target: ScreenDetailedLike,
  onSecondary: boolean,
): OutputPlacement {
  // Prefer full screen bounds (edge-to-edge canvas), not avail* (taskbar inset).
  const left = Math.round(
    typeof target.left === "number" ? target.left : target.availLeft,
  );
  const top = Math.round(
    typeof target.top === "number" ? target.top : target.availTop,
  );
  const width = Math.max(
    320,
    Math.round(
      typeof target.width === "number" ? target.width : target.availWidth,
    ),
  );
  const height = Math.max(
    240,
    Math.round(
      typeof target.height === "number" ? target.height : target.availHeight,
    ),
  );
  return {
    left,
    top,
    width,
    height,
    onSecondary,
    usedScreenDetails: true,
  };
}

/** Pick a screen that is not the one hosting Control, else any non-primary. */
export function pickSecondaryScreen(
  details: ScreenDetailsLike,
): ScreenDetailedLike | null {
  const screens = details.screens ?? [];
  if (screens.length < 2) {
    return null;
  }
  const current = details.currentScreen;
  return (
    screens.find((s) => s !== current) ??
    screens.find((s) => s.isPrimary === false) ??
    null
  );
}

/**
 * Resolve where to place Output as a full-monitor canvas.
 * May prompt for Window Management permission (Chrome).
 */
export async function resolveOutputPlacement(): Promise<OutputPlacement | null> {
  const api = screensApi();
  if (!api) {
    return null;
  }
  try {
    const details = await api.getScreenDetails();
    const secondary = pickSecondaryScreen(details);
    const target = secondary ?? details.currentScreen;
    return placementFromScreen(target, Boolean(secondary));
  } catch {
    return null;
  }
}

/** Only call getScreenDetails when already allowed (keeps user gesture for open). */
async function resolvePlacementIfGranted(): Promise<OutputPlacement | null> {
  try {
    const perms = navigator.permissions;
    if (perms && typeof perms.query === "function") {
      const status = await perms.query({
        name: "window-management" as PermissionName,
      });
      if (status.state === "denied") {
        return readCachedPlacement();
      }
      if (status.state === "granted") {
        return (await resolveOutputPlacement()) ?? readCachedPlacement();
      }
    }
  } catch {
    // Permissions API may not know window-management.
  }
  return readCachedPlacement();
}

/** Minimal chrome + absolute geometry for a full-canvas projection window. */
function projectionChromeFeatures(): string[] {
  return [
    "popup=yes",
    "toolbar=no",
    "location=no",
    "menubar=no",
    "status=no",
    "scrollbars=no",
  ];
}

function featuresFromPlacement(p: OutputPlacement): string {
  // Do NOT include noopener — we need the Window handle to navigate / resize.
  return [
    ...projectionChromeFeatures(),
    `left=${p.left}`,
    `top=${p.top}`,
    `width=${p.width}`,
    `height=${p.height}`,
  ].join(",");
}

function defaultProjectionFeatures(): string {
  return [...projectionChromeFeatures(), "width=1280", "height=720"].join(",");
}

export function codeOutputUrl(
  code: string,
  opts?: { autofullscreen?: boolean },
): string {
  const u = new URL(`${window.location.origin}/output`);
  u.searchParams.set("code", code);
  if (opts?.autofullscreen) {
    u.searchParams.set("autofullscreen", "1");
  }
  return u.toString();
}

export function opaqueOutputUrl(
  accessToken: string,
  opts?: { autofullscreen?: boolean },
): string {
  const u = new URL(`${window.location.origin}/output`);
  u.searchParams.set("token", accessToken);
  if (opts?.autofullscreen) {
    u.searchParams.set("autofullscreen", "1");
  }
  return u.toString();
}

function tryMoveResize(win: Window, p: OutputPlacement): void {
  try {
    win.moveTo(p.left, p.top);
  } catch {
    // Browser policy / not yet loaded
  }
  try {
    win.resizeTo(p.width, p.height);
  } catch {
    // ignore
  }
}

function scheduleCanvasPlacement(win: Window, placement: OutputPlacement): void {
  for (const ms of [0, 80, 200, 450, 900, 1600, 2800]) {
    window.setTimeout(() => {
      if (!win.closed) {
        tryMoveResize(win, placement);
      }
    }, ms);
  }
}

function postAutofullscreen(win: Window): void {
  try {
    win.postMessage(
      { type: "promedia.requestFullscreen" },
      window.location.origin,
    );
  } catch {
    // ignore
  }
  try {
    const bus = new BroadcastChannel(OUTPUT_BROADCAST_CHANNEL);
    bus.postMessage({ type: "promedia.requestFullscreen" });
    bus.close();
  } catch {
    // ignore
  }
}

function scheduleFullscreenNudges(win: Window): void {
  for (const ms of [150, 400, 900, 1600, 2500, 4000]) {
    window.setTimeout(() => {
      if (!win.closed) {
        postAutofullscreen(win);
      }
    }, ms);
  }
}

function postToOutputBus(message: { type: string }): void {
  try {
    const bus = new BroadcastChannel(OUTPUT_BROADCAST_CHANNEL);
    bus.postMessage(message);
    bus.close();
  } catch {
    // BroadcastChannel unsupported
  }
}

/**
 * Ask Output to unmute + play after Control En vivo (best-effort).
 * Never calls window.open — on mobile that created a blank tab when Output
 * was not already open. Uses BroadcastChannel + a retained window handle.
 */
export function postOutputUnmute(): void {
  const message = { type: "promedia.requestUnmute" as const };
  postToOutputBus(message);

  try {
    const win = retainedOutputWindow;
    if (!win || win.closed) {
      retainedOutputWindow = null;
      return;
    }
    try {
      const href = win.location.href;
      if (!href || href === "about:blank" || !href.includes("/output")) {
        return;
      }
    } catch {
      return;
    }
    win.postMessage(message, window.location.origin);
  } catch {
    // ignore
  }
}

function finishPlacedWindow(
  win: Window,
  url: string,
  placement: OutputPlacement | null,
  autofullscreen: boolean,
  focusedExisting: boolean,
): OpenOutputResult {
  try {
    if (win.location.href !== url) {
      win.location.replace(url);
    }
  } catch {
    try {
      win.location.href = url;
    } catch {
      // ignore
    }
  }
  if (placement) {
    scheduleCanvasPlacement(win, placement);
  }
  if (autofullscreen) {
    scheduleFullscreenNudges(win);
  }
  try {
    win.focus();
  } catch {
    // ignore
  }
  return {
    url,
    opened: true,
    focusedExisting,
    placement,
    popupBlocked: false,
  };
}

/**
 * Open Output as a full-canvas on the secondary monitor when possible.
 * Call from a click handler so popup + Window Management permission work.
 */
export async function openOutputWindow(
  code: string,
  opts?: { autofullscreen?: boolean; preferSecondary?: boolean },
): Promise<OpenOutputResult> {
  const autofullscreen = opts?.autofullscreen !== false;
  const preferSecondary = opts?.preferSecondary !== false;
  const url = codeOutputUrl(code, { autofullscreen });

  // Prefer opening already sized to the 2nd screen (permission previously granted).
  let placement = preferSecondary ? await resolvePlacementIfGranted() : null;
  if (placement) {
    cachePlacement(placement);
  }

  const features = placement
    ? featuresFromPlacement(placement)
    : defaultProjectionFeatures();

  // Open under the user gesture with full-monitor geometry when known.
  let win = window.open(url, OUTPUT_WINDOW_NAME, features);
  if (!win) {
    return {
      url,
      opened: false,
      focusedExisting: false,
      placement,
      popupBlocked: true,
    };
  }
  rememberOutputWindow(win);

  if (preferSecondary) {
    try {
      const fresh = await resolveOutputPlacement();
      if (fresh) {
        placement = fresh;
        cachePlacement(fresh);
        scheduleCanvasPlacement(win, fresh);
      } else if (placement) {
        scheduleCanvasPlacement(win, placement);
      }
    } catch {
      if (placement) {
        scheduleCanvasPlacement(win, placement);
      }
    }
  }

  if (autofullscreen) {
    scheduleFullscreenNudges(win);
  }
  try {
    win.focus();
  } catch {
    // ignore
  }

  return {
    url,
    opened: true,
    focusedExisting: false,
    placement,
    popupBlocked: false,
  };
}

/**
 * Primary CTA: ensure session, open Output as full canvas on secondary screen,
 * request autofullscreen.
 */
export async function startProjection(opts: {
  existingCode: string | null;
  ensureSession: () => Promise<string>;
}): Promise<OpenOutputResult & { code: string }> {
  if (opts.existingCode) {
    const result = await openOutputWindow(opts.existingCode, {
      autofullscreen: true,
      preferSecondary: true,
    });
    return { code: opts.existingCode, ...result };
  }

  // 1) Reserve named window under the gesture (with cached full-canvas size).
  const prePlacement = await resolvePlacementIfGranted();
  if (prePlacement) {
    cachePlacement(prePlacement);
  }
  const openFeatures = prePlacement
    ? featuresFromPlacement(prePlacement)
    : defaultProjectionFeatures();
  const popup = window.open("about:blank", OUTPUT_WINDOW_NAME, openFeatures);

  // 2) Resolve / prompt Window Management, then fill the secondary monitor.
  let placement: OutputPlacement | null = prePlacement;
  try {
    const fresh = await resolveOutputPlacement();
    if (fresh) {
      placement = fresh;
      cachePlacement(fresh);
    }
  } catch {
    // keep prePlacement
  }

  // 3) Create/resume session and navigate the canvas window.
  const code = await opts.ensureSession();
  const url = codeOutputUrl(code, { autofullscreen: true });
  const features = placement
    ? featuresFromPlacement(placement)
    : defaultProjectionFeatures();

  if (!popup) {
    const retry = window.open(url, OUTPUT_WINDOW_NAME, features);
    if (!retry) {
      return {
        code,
        url,
        opened: false,
        focusedExisting: false,
        placement,
        popupBlocked: true,
      };
    }
    rememberOutputWindow(retry);
    return {
      code,
      ...finishPlacedWindow(retry, url, placement, true, false),
    };
  }

  rememberOutputWindow(popup);
  return {
    code,
    ...finishPlacedWindow(popup, url, placement, true, false),
  };
}
