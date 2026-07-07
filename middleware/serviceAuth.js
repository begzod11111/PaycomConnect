import crypto from 'crypto';

import { env } from '../config/env.js';

// Service-to-service authorization for calls coming from the Balancer project.
//
// Scheme (see docs/service-auth.md):
//   Authorization: Basic base64("<clientName>:<secret>")
// Also accepted:
//   Authorization: Service base64("<clientName>:<secret>")
//   X-Service-Authorization: <base64 or "Basic <base64>">
// Optional target check:
//   X-Target-Service: paycomconnect   (must match env.serviceName when present)
//
// The secret is a 36-char key (letters + digits) issued by PaycomConnect and
// stored on the Balancer side. This authenticates the *service*, not an end user
// (the user auth stays on the Balancer/authorization service).

function timingSafeEqualStr(a, b) {
  const bufferA = Buffer.from(String(a), 'utf8');
  const bufferB = Buffer.from(String(b), 'utf8');

  if (bufferA.length !== bufferB.length) {
    // Compare against itself so the branch cost stays roughly constant.
    crypto.timingSafeEqual(bufferA, bufferA);
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

function decodeBase64Credential(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    return null;
  }

  const schemeMatch = value.match(/^(?:Basic|Service)\s+(.+)$/i);
  const base64Part = schemeMatch ? schemeMatch[1].trim() : value;

  let decoded;
  try {
    decoded = Buffer.from(base64Part, 'base64').toString('utf8');
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return null;
  }

  return {
    name: decoded.slice(0, separatorIndex),
    secret: decoded.slice(separatorIndex + 1),
  };
}

function extractCredential(req) {
  const header = req.headers.authorization || req.headers['x-service-authorization'];
  return decodeBase64Credential(header);
}

// Express middleware. When service auth is disabled (no clients configured and no
// explicit flag) it is a pass-through, so local/dev and the test suite are unaffected.
export function requireServiceAuth(req, res, next) {
  if (!env.serviceAuthEnabled) {
    return next();
  }

  const targetService = req.headers['x-target-service'];
  if (
    targetService &&
    env.serviceName &&
    String(targetService).toLowerCase() !== String(env.serviceName).toLowerCase()
  ) {
    return res.status(403).json({ error: 'Request addressed to a different service' });
  }

  const credential = extractCredential(req);
  if (!credential || !credential.name || !credential.secret) {
    res.setHeader('WWW-Authenticate', 'Basic realm="paycomconnect-service"');
    return res.status(401).json({ error: 'Service authorization required' });
  }

  const expectedSecret = env.serviceClients[credential.name];
  if (!expectedSecret || !timingSafeEqualStr(credential.secret, expectedSecret)) {
    return res.status(401).json({ error: 'Invalid service credentials' });
  }

  req.serviceClient = { name: credential.name };
  return next();
}

export default requireServiceAuth;
