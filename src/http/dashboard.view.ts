// Self-contained HTML for the local inspection dashboard. No build step, no
// external assets — one small vanilla-JS client that fetches JSON from the
// dashboard data endpoints and renders simple tables + a raw-JSON toggle.

export const DASHBOARD_BASE = '/api/dashboard';

const NAV = [
  { key: 'overview', label: 'Overview', href: DASHBOARD_BASE },
  { key: 'messages', label: 'Messages', href: DASHBOARD_BASE + '/messages' },
  { key: 'logs', label: 'Logs', href: DASHBOARD_BASE + '/logs' },
  { key: 'connections', label: 'Connections', href: DASHBOARD_BASE + '/connections' },
];

const CSS = `
:root{
  --bg:#0f1419; --panel:#171d26; --panel2:#1e2632; --border:#2a3441;
  --text:#e6edf3; --muted:#8b98a5; --accent:#4c9aff;
  --ok:#3fb950; --warn:#d29922; --err:#f85149; --info:#4c9aff;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{display:flex;align-items:center;gap:20px;padding:14px 22px;
  background:var(--panel);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}
.brand{font-weight:700;font-size:16px;letter-spacing:.3px}
.brand small{color:var(--muted);font-weight:400;margin-left:8px}
nav{display:flex;gap:6px;flex:1}
nav a{color:var(--muted);text-decoration:none;padding:7px 14px;border-radius:8px;font-weight:500}
nav a:hover{background:var(--panel2);color:var(--text)}
nav a.active{background:var(--accent);color:#fff}
main{padding:22px;max-width:1400px;margin:0 auto}
.toolbar{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.toolbar input[type=search]{background:var(--panel2);border:1px solid var(--border);color:var(--text);
  padding:8px 12px;border-radius:8px;min-width:240px;font-size:14px}
.toolbar label{color:var(--muted);display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.btn{background:var(--panel2);border:1px solid var(--border);color:var(--text);
  padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px}
.btn:hover{border-color:var(--accent)}
.meta{color:var(--muted);font-size:12px;margin-left:auto}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:16px}
.card h3{margin:0;padding:12px 16px;font-size:13px;text-transform:uppercase;letter-spacing:.5px;
  color:var(--muted);border-bottom:1px solid var(--border);background:var(--panel2)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.kv{display:flex;justify-content:space-between;gap:16px;padding:8px 16px;border-bottom:1px solid var(--border)}
.kv:last-child{border-bottom:none}
.kv .k{color:var(--muted)}
.kv .v{font-weight:600;text-align:right;word-break:break-word}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
.stat{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px}
.stat .n{font-size:26px;font-weight:700}
.stat .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-top:4px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
th{text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;
  color:var(--muted);background:var(--panel2);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:none}
tr.row{cursor:pointer}
tr.row:hover td{background:var(--panel2)}
tr.raw td{background:#0b0f14}
pre{margin:0;padding:14px;overflow:auto;font:12px/1.5 "SF Mono",Menlo,Consolas,monospace;color:#c9d5e1;max-height:420px}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;white-space:nowrap}
.b-ok{background:rgba(63,185,80,.15);color:var(--ok)}
.b-warn{background:rgba(210,153,34,.15);color:var(--warn)}
.b-err{background:rgba(248,81,73,.15);color:var(--err)}
.b-info{background:rgba(76,154,255,.15);color:var(--info)}
.b-muted{background:rgba(139,152,165,.15);color:var(--muted)}
.dim{color:var(--muted)}
.mono{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:12px}
.empty{padding:40px;text-align:center;color:var(--muted)}
.banner{background:rgba(248,81,73,.12);border:1px solid var(--err);color:#ffb3ae;
  padding:12px 16px;border-radius:10px;margin-bottom:16px}
`;

// Client script: intentionally free of backticks and ${...} so it can be
// embedded verbatim inside the server-side template literal below.
const CLIENT_JS = `
(function(){
  var BASE = '/api/dashboard';
  var PAGE = window.__PAGE__ || 'overview';
  var ENDPOINTS = {
    overview: BASE + '/data/overview',
    messages: BASE + '/data/messages?limit=100',
    logs: BASE + '/data/logs?limit=200',
    connections: BASE + '/data/connections'
  };
  var lastData = null;
  var timer = null;

  function el(id){ return document.getElementById(id); }
  function esc(v){
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function get(obj, path){
    var parts = path.split('.'); var cur = obj;
    for (var i=0;i<parts.length;i++){ if (cur==null) return undefined; cur = cur[parts[i]]; }
    return cur;
  }
  function fmtTime(v){
    if (!v) return '';
    var d = new Date(v); if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleString();
  }
  function trunc(s, n){ s = s==null?'':String(s); return s.length>n ? esc(s.slice(0,n))+'\\u2026' : esc(s); }
  function badge(text, cls){ return '<span class="badge '+cls+'">'+esc(text)+'</span>'; }

  function fmtBytes(b){
    b = Number(b)||0; if (b<1024) return b+' B';
    var u=['KB','MB','GB']; var i=-1; do{ b/=1024; i++; }while(b>=1024&&i<u.length-1);
    return b.toFixed(1)+' '+u[i];
  }

  var COLUMNS = {
    messages: [
      { label:'Time', get:function(r){ return '<span class="dim mono">'+fmtTime(r.createdAt||r.messageTimestamp)+'</span>'; } },
      { label:'Route', get:function(r){ return esc(r.source)+' <span class="dim">&rarr;</span> '+esc(r.destination); } },
      { label:'Sender', get:function(r){
          var s = r.sender||{}; var t = s.type||'client';
          var cls = t==='employee'?'b-ok':(t==='bot'?'b-warn':'b-muted');
          return badge(t, cls)+' <span class="dim">'+esc(r.userName||'')+'</span>';
      } },
      { label:'Format', get:function(r){
          var f = r.format||'text';
          var cls = f==='file'?'b-warn':(f==='mixed'?'b-ok':(f==='empty'?'b-muted':'b-info'));
          return badge(f, cls);
      } },
      { label:'Text', get:function(r){ return trunc(r.text, 70); } },
      { label:'Delivered', get:function(r){
          var d = r.delivered === true || (r.delivery && (r.delivery.delivered===true));
          var st = r.delivery ? (r.delivery.status||'') : '';
          var reason = (r.delivery && r.delivery.reason) || (r.metadata && r.metadata.skipReason) || '';
          return badge(d?'yes':'no', d?'b-ok':'b-muted')+' <span class="dim mono">'+esc(st)+(reason?' · '+reason:'')+'</span>';
      } },
      { label:'External ID', get:function(r){ return '<span class="mono dim">'+esc(r.externalId)+'</span>'; } }
    ],
    logs: [
      { label:'Time', get:function(r){ return '<span class="dim mono">'+fmtTime(r.createdAt)+'</span>'; } },
      { label:'Level', get:function(r){
          var l = r.level||'info'; var cls = l==='error'?'b-err':(l==='warn'?'b-warn':'b-info');
          return badge(l, cls);
      } },
      { label:'Category', get:function(r){ return badge(r.category||'system','b-muted'); } },
      { label:'Action', get:function(r){ return '<span class="mono">'+esc(r.action)+'</span>'; } },
      { label:'Source', get:function(r){ return esc(r.source||''); } },
      { label:'Message', get:function(r){ return trunc(r.message, 80); } },
      { label:'Actor', get:function(r){ var a=r.actor||{}; return esc(a.userName||a.userId||''); } },
      { label:'INN', get:function(r){ return '<span class="mono dim">'+esc(r.connectionInn||'')+'</span>'; } }
    ],
    connections: [
      { label:'INN', get:function(r){ return '<span class="mono">'+esc(r.inn)+'</span>'; } },
      { label:'Status', get:function(r){
          var s = r.status||''; var cls = s==='linked'?'b-ok':(s==='suspended'?'b-muted':'b-warn');
          return badge(s, cls);
      } },
      { label:'Telegram', get:function(r){ return esc(r.telegramChatTitle||r.telegramChatId||'')+' <span class="dim mono">'+esc(r.telegramChatId||'')+'</span>'; } },
      { label:'Slack', get:function(r){ return esc(r.slackChannelName||'')+' <span class="dim mono">'+esc(r.slackChannelId||'')+'</span>'; } },
      { label:'Jira', get:function(r){ return '<span class="mono">'+esc(r.jiraIssueKey||'')+'</span>'; } },
      { label:'Last activity', get:function(r){ return '<span class="dim mono">'+fmtTime(r.lastActivityAt||r.updatedAt)+'</span>'; } }
    ]
  };

  function matchesFilter(row, q){
    if (!q) return true;
    try { return JSON.stringify(row).toLowerCase().indexOf(q.toLowerCase()) !== -1; }
    catch(e){ return true; }
  }

  function renderStats(obj){
    var order = ['totalMessages','forwardedMessages','employeeMessages','firstInteractions',
                 'totalConnections','linkedConnections','pendingConnections','totalContacts',
                 'jiraIssuesTriggered','totalActionLogs'];
    var labels = {
      totalMessages:'Messages', forwardedMessages:'Forwarded', employeeMessages:'From employees',
      firstInteractions:'First contacts', totalConnections:'Connections', linkedConnections:'Linked',
      pendingConnections:'Pending', totalContacts:'Contacts', jiraIssuesTriggered:'Jira triggered',
      totalActionLogs:'Action logs'
    };
    var html = '<div class="stats">';
    for (var i=0;i<order.length;i++){
      var k = order[i]; if (obj[k]===undefined) continue;
      html += '<div class="stat"><div class="n">'+esc(obj[k])+'</div><div class="l">'+esc(labels[k]||k)+'</div></div>';
    }
    html += '</div>';
    return html;
  }

  function renderKV(title, obj){
    var html = '<div class="card"><h3>'+esc(title)+'</h3>';
    var keys = Object.keys(obj||{});
    if (!keys.length){ html += '<div class="empty">no data</div></div>'; return html; }
    for (var i=0;i<keys.length;i++){
      var k = keys[i]; var v = obj[k];
      if (v !== null && typeof v === 'object') v = JSON.stringify(v);
      if (typeof obj[k] === 'boolean') v = badge(obj[k]?'yes':'no', obj[k]?'b-ok':'b-muted');
      else v = esc(v);
      html += '<div class="kv"><span class="k">'+esc(k)+'</span><span class="v">'+v+'</span></div>';
    }
    html += '</div>';
    return html;
  }

  function renderOverview(data){
    var host = el('content');
    var html = '';
    if (data.analytics) html += '<div style="margin-bottom:16px">'+renderStats(data.analytics)+'</div>';
    html += '<div class="grid">';
    html += renderKV('System', {
      service:data.service, version:data.version, runtime:data.runtime, env:data.env
    });
    if (data.process) html += renderKV('Process', {
      pid:data.process.pid, node:data.process.node, platform:data.process.platform,
      uptime:data.process.uptime, rss:fmtBytes(data.process.memory && data.process.memory.rss),
      heapUsed:fmtBytes(data.process.memory && data.process.memory.heapUsed)
    });
    if (data.database) html += renderKV('Database', data.database);
    if (data.integrations) html += renderKV('Integrations', data.integrations);
    html += '</div>';
    host.innerHTML = html;
  }

  function renderTable(rows){
    var host = el('content');
    var cols = COLUMNS[PAGE] || [];
    var q = (el('search') && el('search').value || '').trim();
    var filtered = (rows||[]).filter(function(r){ return matchesFilter(r, q); });
    if (!filtered.length){ host.innerHTML = '<div class="card"><div class="empty">No records'+(q?' match your filter':' yet')+'.</div></div>'; return; }
    var html = '<table><thead><tr>';
    for (var c=0;c<cols.length;c++) html += '<th>'+esc(cols[c].label)+'</th>';
    html += '</tr></thead><tbody>';
    for (var i=0;i<filtered.length;i++){
      var row = filtered[i];
      html += '<tr class="row" data-idx="'+i+'">';
      for (var c2=0;c2<cols.length;c2++){
        var val;
        try { val = cols[c2].get(row); } catch(e){ val = ''; }
        html += '<td>'+(val==null?'':val)+'</td>';
      }
      html += '</tr>';
      html += '<tr class="raw" id="raw-'+i+'" style="display:none"><td colspan="'+cols.length+'"><pre>'+esc(JSON.stringify(row,null,2))+'</pre></td></tr>';
    }
    html += '</tbody></table>';
    host.innerHTML = html;
    var trs = host.querySelectorAll('tr.row');
    for (var t=0;t<trs.length;t++){
      trs[t].addEventListener('click', function(){
        var idx = this.getAttribute('data-idx');
        var raw = el('raw-'+idx);
        if (raw) raw.style.display = raw.style.display==='none' ? '' : 'none';
      });
    }
  }

  function render(data){
    lastData = data;
    if (el('raw-toggle') && el('raw-toggle').checked){
      el('content').innerHTML = '<div class="card"><pre>'+esc(JSON.stringify(data,null,2))+'</pre></div>';
    } else if (PAGE === 'overview'){
      renderOverview(data);
    } else {
      renderTable(Array.isArray(data)?data:[]);
    }
    var count = Array.isArray(data) ? data.length : '';
    el('meta').textContent = (count!==''?count+' records \\u00b7 ':'')+'updated '+new Date().toLocaleTimeString();
  }

  function load(){
    if (el('banner')) el('banner').style.display='none';
    fetch(ENDPOINTS[PAGE], { headers:{ 'Accept':'application/json' } })
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(render)
      .catch(function(err){
        var b = el('banner'); if (b){ b.style.display=''; b.textContent = 'Failed to load data: '+err.message; }
      });
  }

  function setupAuto(){
    var chk = el('auto');
    function apply(){
      if (timer){ clearInterval(timer); timer=null; }
      if (chk && chk.checked) timer = setInterval(load, 5000);
    }
    if (chk) chk.addEventListener('change', apply);
    apply();
  }

  document.addEventListener('DOMContentLoaded', function(){
    if (el('search')) el('search').addEventListener('input', function(){ if (lastData) render(lastData); });
    if (el('raw-toggle')) el('raw-toggle').addEventListener('change', function(){ if (lastData) render(lastData); });
    if (el('refresh')) el('refresh').addEventListener('click', load);
    setupAuto();
    load();
  });
})();
`;

export function renderDashboardPage(active: string): string {
  const nav = NAV.map(
    (item) =>
      `<a href="${item.href}" class="${item.key === active ? 'active' : ''}">${item.label}</a>`,
  ).join('');

  const showSearch = active !== 'overview';
  const toolbar =
    `<div class="toolbar">` +
    (showSearch
      ? `<input id="search" type="search" placeholder="Filter records\u2026" autocomplete="off">`
      : '') +
    `<button id="refresh" class="btn">Refresh</button>` +
    `<label><input id="auto" type="checkbox" checked> auto (5s)</label>` +
    `<label><input id="raw-toggle" type="checkbox"> raw JSON</label>` +
    `<span id="meta" class="meta"></span>` +
    `</div>`;

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>PaycomConnect \u00b7 ${active}</title><style>${CSS}</style></head><body>` +
    `<header><div class="brand">PaycomConnect <small>local dashboard</small></div>` +
    `<nav>${nav}</nav></header>` +
    `<main>` +
    `<div id="banner" class="banner" style="display:none"></div>` +
    toolbar +
    `<div id="content"></div>` +
    `</main>` +
    `<script>window.__PAGE__=${JSON.stringify(active)};</script>` +
    `<script>${CLIENT_JS}</script>` +
    `</body></html>`
  );
}
