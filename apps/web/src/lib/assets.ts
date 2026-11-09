import { hubHttpBase } from "./hub";

/** Build authenticated URL for a session-scoped media asset (img-friendly). */
export function buildAssetUrl(
  sessionId: string,
  assetId: string,
  credential: string,
): string {
  const q = new URLSearchParams({ credential });
  return `${hubHttpBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(assetId)}?${q}`;
}

/** Hub-persisted venue logo for sceneMode "logo" (cache-busted by updatedAt). */
export function buildBrandingLogoUrl(
  sessionId: string,
  credential: string,
  updatedAt?: string | null,
): string {
  const q = new URLSearchParams({
    sessionId,
    credential,
  });
  if (updatedAt) {
    q.set("v", updatedAt);
  }
  return `${hubHttpBase()}/api/v1/branding/logo?${q}`;
}

/** Upload / replace the permanent branding logo (survives sessions). */
export async function uploadBrandingLogo(
  sessionId: string,
  credential: string,
  file: File,
): Promise<{ mime: string; updatedAt: string; size: number }> {
  const form = new FormData();
  form.append("file", file);
  const q = new URLSearchParams({ sessionId });
  const res = await fetch(
    `${hubHttpBase()}/api/v1/branding/logo?${q}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
      },
      body: form,
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `logo_upload_failed_${res.status}`);
  }
  const data = (await res.json()) as {
    logo: { mime: string; updatedAt: string; size: number };
  };
  return data.logo;
}

export async function uploadSessionAsset(
  sessionId: string,
  credential: string,
  file: File,
): Promise<{ id: string; mime: string; size?: number; originalName?: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(
    `${hubHttpBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/assets`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
      },
      body: form,
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `upload_failed_${res.status}`);
  }
  const data = (await res.json()) as {
    asset: {
      id: string;
      mime: string;
      size?: number;
      originalName?: string;
    };
  };
  return data.asset;
}

/** Soft UI warning threshold (no hard cap). */
export const LARGE_IMAGE_WARN_BYTES = 20 * 1024 * 1024;

/** Soft UI warning for large video files (no hard cap). */
export const LARGE_VIDEO_WARN_BYTES = 100 * 1024 * 1024;
