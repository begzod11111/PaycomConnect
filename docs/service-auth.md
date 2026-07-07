# Service-to-service authorization (Balancer → PaycomConnect)

PaycomConnect does **not** run its own user login. User authentication and the
authorization service stay on the **Balancer** side. PaycomConnect only needs to
answer one question for each incoming API call: **"is this a trusted service, and
is it allowed to use my API?"** — and then open the corresponding access.

This is a **per-service** credential (a JWT-like shared key for the *service*,
not for a user), exactly as requested.

> Status: implemented. Middleware `middleware/serviceAuth.js`, wired into the
> data/admin API in `routes/api.js`, config in `config/env.js`, tests in
> `tests/serviceAuth.test.js`.

## The scheme

A caller (e.g. the Balancer project) sends an HTTP `Authorization` header whose
value is **base64 of `"<clientName>:<secret>"`** — the same shape as HTTP Basic
auth, but the "username" is the **project/service name** and the "password" is a
**36-character key**.

```
Authorization: Basic base64("<clientName>:<secret>")
```

- `<clientName>` — the name of the calling project, e.g. `balancer`.
- `<secret>` — a 36-char key: uppercase + lowercase Latin letters and digits,
  issued by PaycomConnect and stored on the Balancer side.

Accepted variants (all equivalent):

| Header | Example value |
| --- | --- |
| `Authorization: Basic <base64>` | `Basic YmFsYW5jZXI6QWJD...` |
| `Authorization: Service <base64>` | `Service YmFsYW5jZXI6QWJD...` |
| `X-Service-Authorization: <base64>` | `YmFsYW5jZXI6QWJD...` (or with `Basic ` prefix) |

### Optional target check

To make the credential unusable against the wrong service, the caller may also
send the name of the service it *intends* to reach:

```
X-Target-Service: paycomconnect
```

When present, it must match `SERVICE_NAME`; otherwise the request is rejected
with `403`. When absent, the check is skipped (backward compatible).

### Example request

```http
GET /api/connections HTTP/1.1
Host: paycomconnect.internal
Authorization: Basic YmFsYW5jZXI6QWJDZEVm...   # base64("balancer:<36-char-key>")
X-Target-Service: paycomconnect
```

## How verification works

1. If service auth is **disabled** (see below) → pass through (dev/tests).
2. If `X-Target-Service` is present and does not equal `SERVICE_NAME` → `403`.
3. Decode the base64 credential → split on the first `:` into `name` + `secret`.
   Missing/garbled credential → `401` with `WWW-Authenticate`.
4. Look up `name` in the trusted registry. Compare `secret` in **constant time**
   (`crypto.timingSafeEqual`). Mismatch/unknown client → `401`.
5. On success attach `req.serviceClient = { name }` and continue.

## Configuration

In `.env` (see `.env.example`):

```bash
SERVICE_NAME=paycomconnect
# Trusted callers: "name:secret" pairs, comma-separated.
SERVICE_CLIENTS=balancer:AbC0dEf...36chars...,reporting:XyZ9...36chars...
# Optional override (true/false). If omitted, enforcement auto-enables when
# at least one client is configured.
SERVICE_AUTH_ENABLED=
```

**Enforcement rule:** enabled automatically once `SERVICE_CLIENTS` has at least
one entry; `SERVICE_AUTH_ENABLED=true|false` overrides. With no clients it is
**disabled**, so local development and the test suite are unaffected.

### Generating a key

```bash
npm run gen:service-key balancer
# -> balancer:Kf3aB...<36 chars>...   (paste straight into SERVICE_CLIENTS)

npm run gen:service-key
# -> just the 36-char key
```

## What is protected

Applied to the data/admin surface, which is exactly what the Balancer UI needs:

- `GET/PATCH/DELETE /api/connections[/:inn]`, `POST /api/connections/:inn/jira`
- `GET /api/analytics/summary`
- `GET /api/messages/recent`

**Not** protected (by design):

- `GET /api/health` — monitoring/liveness.
- Telegram/Slack webhooks and slash commands — these use their own provider
  verification (Telegram secret token / Slack signing secret), not service auth.

## How this fits the architecture

This is the auth layer for the **BFF/gateway** integration with the Balancer
project: the Balancer backend calls PaycomConnect's API with its service
credential and renders the data in the existing `tamada` UX. PaycomConnect can
then stay on a private network and never expose user-facing auth. See
[`architecture-recommendation.md`](./architecture-recommendation.md).

## Hardening notes

- Always serve the API over **HTTPS/mTLS or a private network** — a bearer-style
  secret in a header must never travel in clear text.
- **Rotate** keys by adding the new `name:secret` alongside the old one, moving
  the caller over, then removing the old entry (zero-downtime rotation).
- Give each caller its **own** client name so keys can be revoked independently.
- Consider adding inbound **rate limiting** per `req.serviceClient.name` (see the
  performance doc) once more callers exist.
