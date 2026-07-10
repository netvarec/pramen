// Inline stylesheet for the CMS editor. Borders-only depth, spring-teal accent — the
// same design language as @pramen/admin, adapted for an editor (canvas, palette, forms).

export const css = `
:root {
  --bg:#0e1116; --surface:#141921; --surface-2:#181e28; --raise:#1d2531;
  --border:#232c3a; --border-2:#2e3a4d; --ink:#e6edf3; --ink-2:#aab7c7; --ink-3:#6b7a8d;
  --spring:#3fd6c0; --spring-dim:#1c8d80; --spring-bg:#0f2723; --amber:#e0a458;
  --danger:#e0606a; --danger-bg:#2a161a; --radius:7px; --radius-sm:5px;
  --mono:ui-monospace,"SF Mono","JetBrains Mono","Menlo",monospace;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
}
* { box-sizing:border-box; }
html,body { margin:0; height:100%; }
body { background:var(--bg); color:var(--ink); font-family:var(--sans); font-size:14px; line-height:1.5; -webkit-font-smoothing:antialiased; }
#app { min-height:100%; }
a { color:var(--spring); }

.bar { display:flex; align-items:center; gap:10px; padding:10px 16px; background:var(--surface); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:10; }
.bar .grow { flex:1; }
.brand { font-weight:700; letter-spacing:.02em; }
.brand .dim { color:var(--ink-3); font-weight:400; }
.crumb { color:var(--ink-2); }
.crumb b { color:var(--ink); }

button, .btn { font:inherit; color:var(--ink); background:var(--raise); border:1px solid var(--border-2); border-radius:var(--radius-sm); padding:5px 11px; cursor:pointer; }
button:hover { border-color:var(--spring-dim); }
button.primary { background:var(--spring-bg); border-color:var(--spring-dim); color:var(--spring); }
button.ghost { background:transparent; border-color:transparent; color:var(--ink-2); }
button.ghost:hover { color:var(--ink); border-color:var(--border); }
button.danger { color:var(--danger); border-color:var(--danger); background:var(--danger-bg); }
button:disabled { opacity:.5; cursor:not-allowed; }
button.sm { padding:3px 7px; font-size:12px; }

input, textarea, select { font:inherit; color:var(--ink); background:var(--surface-2); border:1px solid var(--border-2); border-radius:var(--radius-sm); padding:6px 9px; width:100%; }
input:focus, textarea:focus, select:focus { outline:none; border-color:var(--spring-dim); }
textarea { min-height:72px; font-family:var(--mono); font-size:13px; resize:vertical; }
label.field { display:block; margin:10px 0; }
label.field > .lbl { display:block; color:var(--ink-2); font-size:12px; margin-bottom:4px; }
label.field > .lbl .req { color:var(--amber); }
.checkbox { display:flex; align-items:center; gap:8px; }
.checkbox input { width:auto; }

.layout { display:grid; grid-template-columns:230px 1fr 380px; min-height:calc(100vh - 47px); }
.side { border-right:1px solid var(--border); background:var(--surface); padding:12px; overflow:auto; }
.canvas { padding:18px 20px; overflow:auto; }
.inspect { border-left:1px solid var(--border); background:var(--surface); padding:14px 16px; overflow:auto; }

.sect { color:var(--ink-3); font-size:11px; text-transform:uppercase; letter-spacing:.08em; margin:14px 0 6px; }
.list { display:flex; flex-direction:column; gap:4px; }
.row { display:flex; align-items:center; gap:8px; padding:7px 9px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--surface-2); cursor:pointer; }
.row:hover { border-color:var(--border-2); }
.row.active { border-color:var(--spring-dim); background:var(--spring-bg); }
.row .grow { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pill { font-size:11px; padding:1px 7px; border-radius:20px; border:1px solid var(--border-2); color:var(--ink-2); }
.pill.published { color:var(--spring); border-color:var(--spring-dim); }
.pill.review { color:var(--amber); border-color:var(--amber); }
.pill.rejected, .pill.archived { color:var(--danger); border-color:var(--danger); }

.region { margin-bottom:18px; }
.region > h3 { font-size:13px; color:var(--ink-2); margin:0 0 8px; display:flex; align-items:center; gap:8px; }
.region > h3 .allow { font-size:11px; color:var(--ink-3); font-weight:400; }
.block { border:1px solid var(--border); border-radius:var(--radius); background:var(--surface-2); padding:10px 12px; margin-bottom:8px; }
.block.selected { border-color:var(--spring-dim); }
.block .bhead { display:flex; align-items:center; gap:8px; }
.block .btype { font-family:var(--mono); font-size:12px; color:var(--spring); }
.block .grow { flex:1; }
.block .shared { font-size:11px; color:var(--amber); }
.dropzone { border:1px dashed var(--border-2); border-radius:var(--radius); padding:10px; text-align:center; color:var(--ink-3); font-size:12px; }
.dropzone.over { border-color:var(--spring); color:var(--spring); }

.palette { display:flex; flex-wrap:wrap; gap:6px; }
.palette button { font-size:12px; }
.repeater-item, .group { border:1px solid var(--border); border-radius:var(--radius-sm); padding:8px 10px; margin:6px 0; background:var(--surface-2); }
.repeater-item > .ih { display:flex; justify-content:flex-end; }

.media-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
.media-cell { border:1px solid var(--border); border-radius:var(--radius-sm); overflow:hidden; cursor:pointer; background:var(--surface-2); }
.media-cell:hover { border-color:var(--border-2); }
.media-cell.sel { border-color:var(--spring); }
.media-cell img { width:100%; height:70px; object-fit:cover; display:block; }
.media-cell .fn { font-size:10px; padding:3px 5px; color:var(--ink-3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.media-cell .ext { height:70px; display:flex; align-items:center; justify-content:center; font-family:var(--mono); font-size:12px; color:var(--ink-3); background:var(--raise); }

.media-lib { padding:20px; max-width:1000px; margin:0 auto; }
.media-lib .media-grid { grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); }
.media-lib .media-cell img, .media-lib .media-cell .ext { height:110px; }
.media-toolbar { display:flex; align-items:center; margin-bottom:14px; }
label.btn { display:inline-flex; align-items:center; }
.btn.disabled { opacity:.5; cursor:not-allowed; }
.media-detail img { max-width:100%; max-height:340px; object-fit:contain; display:block; margin:0 auto 12px; background:var(--surface-2); border-radius:var(--radius-sm); }
.media-detail .ext.lg { height:180px; display:flex; align-items:center; justify-content:center; font-family:var(--mono); color:var(--ink-3); background:var(--surface-2); border-radius:var(--radius-sm); margin-bottom:12px; }
.media-detail .kv a { word-break:break-all; }

.scrim { position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; z-index:50; }
.modal { background:var(--surface); border:1px solid var(--border-2); border-radius:var(--radius); padding:18px; width:min(680px,92vw); max-height:86vh; overflow:auto; }
.modal h2 { margin:0 0 12px; font-size:16px; }
.banner { padding:8px 12px; border-radius:var(--radius-sm); margin:8px 0; font-size:13px; }
.banner.err { background:var(--danger-bg); border:1px solid var(--danger); color:var(--danger); }
.banner.ok { background:var(--spring-bg); border:1px solid var(--spring-dim); color:var(--spring); }
.muted { color:var(--ink-3); }
.tabs { display:flex; gap:4px; margin-bottom:10px; }
.tabs button { border-radius:20px; font-size:12px; }
.tabs button.on { color:var(--spring); border-color:var(--spring-dim); }
.setup { max-width:440px; margin:12vh auto; padding:0 20px; }
.setup h1 { font-size:20px; }
.kv { display:grid; grid-template-columns:auto 1fr; gap:6px 10px; font-size:12px; color:var(--ink-2); }
`;
