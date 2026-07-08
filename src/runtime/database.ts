import mongoose from 'mongoose';

import { env } from '../core/env';

// Faithful port of services/databaseService.js: connect to Mongo if configured,
// otherwise run in memory mode (data in the persistence layer's in-memory store).
const state = {
  mode: env.mongoUri ? 'connecting' : 'memory',
  connected: false,
  lastError: env.mongoUri ? null : 'MONGODB_URI is not configured',
};

let connectionPromise: Promise<typeof state> | undefined;

export async function connectDatabase(): Promise<typeof state> {
  if (connectionPromise) return connectionPromise;
  if (!env.mongoUri) return state;

  connectionPromise = mongoose
    .connect(env.mongoUri, { serverSelectionTimeoutMS: 4000 })
    .then(() => {
      state.mode = 'mongodb';
      state.connected = true;
      state.lastError = null;
      return state;
    })
    .catch((error: any) => {
      state.mode = 'memory';
      state.connected = false;
      state.lastError = error.message;
      return state;
    });

  return connectionPromise;
}

export function getDatabaseStatus() {
  return { ...state };
}

export function isMongoConnected(): boolean {
  return state.connected;
}
