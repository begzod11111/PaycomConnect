import mongoose from 'mongoose';

import { env } from '../config/env.js';

const state = {
  mode: env.mongoUri ? 'connecting' : 'memory',
  connected: false,
  lastError: env.mongoUri ? null : 'MONGODB_URI is not configured',
};

let connectionPromise;

export async function connectDatabase() {
  if (connectionPromise) {
    return connectionPromise;
  }

  if (!env.mongoUri) {
    return state;
  }

  connectionPromise = mongoose
    .connect(env.mongoUri, {
      serverSelectionTimeoutMS: 4000,
    })
    .then(() => {
      state.mode = 'mongodb';
      state.connected = true;
      state.lastError = null;
      return state;
    })
    .catch((error) => {
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

export function isMongoConnected() {
  return state.connected;
}

