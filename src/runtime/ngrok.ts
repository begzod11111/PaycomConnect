import { env } from '../core/env';

export interface NgrokState {
  enabled: boolean;
  url?: string;
  reason?: string;
}

// Lazily required so the native binding is only loaded when a tunnel is actually
// requested (keeps `npm start` working on hosts where ngrok is not needed/installed).
type NgrokModule = {
  forward: (options: Record<string, unknown>) => Promise<{ url: () => string | null }>;
  disconnect?: (url?: string) => Promise<void>;
};

let activeUrl: string | undefined;

/**
 * Open an ngrok tunnel to the local server when enabled.
 *
 * Enablement is controlled in `core/env.ts`: by default a tunnel is only opened
 * outside production and only when NGROK_AUTHTOKEN is present. It never throws —
 * a failed tunnel must not take the HTTP server down.
 */
export async function startNgrokTunnel(port: number): Promise<NgrokState> {
  if (!env.ngrokEnabled) {
    return { enabled: false, reason: 'disabled' };
  }

  if (!env.ngrokAuthtoken) {
    return {
      enabled: false,
      reason: 'NGROK_AUTHTOKEN is not set (get one at https://dashboard.ngrok.com/get-started/your-authtoken)',
    };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ngrok = require('@ngrok/ngrok') as NgrokModule;
    const listener = await ngrok.forward({
      addr: port,
      authtoken: env.ngrokAuthtoken,
      ...(env.ngrokDomain ? { domain: env.ngrokDomain } : {}),
    });
    const url = listener.url() ?? undefined;
    activeUrl = url;
    return { enabled: true, url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { enabled: false, reason: `failed to open tunnel: ${message}` };
  }
}

export async function stopNgrokTunnel(): Promise<void> {
  if (!activeUrl) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ngrok = require('@ngrok/ngrok') as NgrokModule;
    await ngrok.disconnect?.(activeUrl);
  } catch {
    // best-effort cleanup
  } finally {
    activeUrl = undefined;
  }
}
