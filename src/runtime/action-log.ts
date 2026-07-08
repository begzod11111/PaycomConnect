import { saveActionLog } from './persistence';

export type ActionLogLevel = 'info' | 'warn' | 'error';
export type ActionLogCategory = 'message' | 'connection' | 'jira' | 'onboarding' | 'system';

export interface ActionLogEntry {
  action: string;
  category?: ActionLogCategory;
  level?: ActionLogLevel;
  source?: 'telegram' | 'slack' | 'system';
  message?: string;
  actor?: {
    userId?: string;
    userName?: string;
    isEmployee?: boolean;
    userRef?: unknown;
  };
  connectionInn?: string;
  externalId?: string;
  context?: Record<string, unknown>;
}

// Persist a single action log. Best-effort: logging must never break the
// message pipeline, so any storage error is swallowed (and mirrored to stderr).
export async function logAction(entry: ActionLogEntry): Promise<void> {
  try {
    await saveActionLog({
      level: 'info',
      category: 'system',
      source: 'system',
      message: '',
      context: {},
      ...entry,
      createdAt: new Date(),
    });
  } catch (error: any) {
    // eslint-disable-next-line no-console
    console.warn(`Failed to persist action log "${entry.action}":`, error?.message ?? error);
  }
}
