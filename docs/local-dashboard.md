# Local inspection dashboard

A small, **non-public** web UI to visually check what the bridge is doing:
action logs, messages (with their metadata), connections, and the running
process state. It has no build step and no external assets — a few simple HTML
pages plus a tiny vanilla-JS client that fetches JSON from read-only endpoints.

Intended usage: reach it over a **port-forward / SSH tunnel**, not by exposing
the port publicly.

## Enable / disable

Controlled by `ENABLE_DASHBOARD` (see `.env.example`):

- **Default**: enabled outside `production`, disabled in `production`.
- Force on/off: `ENABLE_DASHBOARD=true` / `ENABLE_DASHBOARD=false`.

When disabled, every dashboard route returns `404` (so it looks like it doesn't
exist at all). The dashboard is **read-only and unauthenticated**, which is why
it must stay behind a tunnel and off by default in production.

## Pages

All under the global `/api` prefix:

| Page | URL | Shows |
| --- | --- | --- |
| Overview | `/api/dashboard` | Service/runtime info, DB status, integration flags, process (pid, node, uptime, memory), and analytics counters (messages, forwarded, from employees, connections, Jira, action logs). |
| Messages | `/api/dashboard/messages` | Recent messages: route (source → destination), sender (employee/client), format (text/file/mixed), delivered flag + delivery status, text preview, external id. |
| Logs | `/api/dashboard/logs` | Recent action logs: time, level, category, action, source, message, actor, INN. |
| Connections | `/api/dashboard/connections` | Connections/links: INN, status, Telegram, Slack, Jira, last activity. |

Each table row is clickable to expand the **raw JSON** for that record. The
toolbar has a text filter, manual **Refresh**, **auto-refresh** (5s), and a
**raw JSON** toggle to dump the whole payload.

## Data endpoints (JSON)

The pages call these read-only endpoints (also handy for scripting / `curl`):

- `GET /api/dashboard/data/overview`
- `GET /api/dashboard/data/messages?limit=`
- `GET /api/dashboard/data/logs?limit=&category=&action=&inn=`
- `GET /api/dashboard/data/connections`

These are separate from the service-auth-protected `/api/...` endpoints
(`/api/messages/recent`, `/api/logs/recent`, `/api/connections`) used by the
Balancer/tamada integration. The dashboard endpoints are unauthenticated by
design — keep the dashboard local.

## Implementation

- `src/http/dashboard.controller.ts` — routes (pages + JSON data), gated by
  `DashboardGuard`.
- `src/http/dashboard.view.ts` — the self-contained HTML/CSS/JS.
- `src/common/guards/dashboard.guard.ts` — 404s when `ENABLE_DASHBOARD` is off.

Data comes from the same runtime persistence layer as the bridge
(`getRecentMessages`, `getRecentActionLogs`, `getConnectionOverview`,
`getAnalyticsSummary`), so it works in both MongoDB and in-memory mode.
