// Inline stylesheet for the CMS editor. Cream light theme, mint accent, serif-italic
// display headings — the "graphic standard" visual language, adapted for an editor
// (canvas, palette, forms). Same class names as before; only paint changed and a
// handful of new hero / tile / cta classes added.

export const css = `
:root {
  --bg:#f7f3ea; --surface:#efe9dc; --surface-2:#ffffff; --raise:#efe9dc;
  --border:#e5dfd0; --border-2:#d9d1bd;
  --ink:#111111; --ink-2:#6b6a63; --ink-3:#a4a29a;
  --spring:#7ed4a6; --spring-dim:#52b380; --spring-bg:#a3e2c0; --spring-ink:#0f3a25;
  --amber:#b8863b; --amber-bg:#f1e6cf;
  --danger:#b04141; --danger-bg:#f5e2e2;
  --radius:14px; --radius-sm:10px; --radius-pill:999px;
  --mono:ui-monospace,"SF Mono","JetBrains Mono","Menlo",monospace;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  /* Display face — system font for now (no serif). Swap in a brand font here later. */
  --serif:var(--sans);
}
* { box-sizing:border-box; }
html,body { margin:0; height:100%; }
body { background:var(--bg); color:var(--ink); font-family:var(--sans); font-size:14px; line-height:1.5; -webkit-font-smoothing:antialiased; }
#app { min-height:100%; }
a { color:var(--ink); text-decoration:underline; text-underline-offset:2px; text-decoration-color:var(--ink-3); cursor:pointer; }
a:hover { text-decoration-color:var(--ink); }

/* --- top bar ------------------------------------------------------------ */
.bar { display:flex; align-items:center; gap:16px; padding:16px 28px; background:var(--bg); border-bottom:1px solid transparent; position:sticky; top:0; z-index:10; }
.bar .grow { flex:1; }
.brand { font-weight:700; font-size:15px; letter-spacing:.01em; }
.brand .dim { color:var(--ink-3); font-weight:400; }
.crumb { color:var(--ink-2); font-size:13px; }
.crumb b { color:var(--ink); font-weight:600; }
.crumb a { text-decoration:none; color:var(--ink-2); }
.crumb a:hover { color:var(--ink); }

/* --- buttons: pill-shaped, black-filled primary ------------------------- */
button, .btn { font:inherit; color:var(--ink); background:var(--surface); border:1px solid var(--border-2); border-radius:var(--radius-pill); padding:9px 20px; cursor:pointer; font-weight:500; transition:background .12s, border-color .12s, color .12s; }
button:hover { background:#e6dfcd; }
button.primary { background:#111111; border-color:#111111; color:#ffffff; }
button.primary:hover { background:#000000; }
button.ghost { background:transparent; border-color:transparent; color:var(--ink-2); }
button.ghost:hover { color:var(--ink); background:var(--surface); }
button.danger { color:var(--danger); border-color:var(--danger); background:var(--danger-bg); }
button.danger:hover { background:#eeced0; }
button:disabled { opacity:.45; cursor:not-allowed; }
button.sm { padding:4px 11px; font-size:12px; font-weight:500; }

/* --- inputs ------------------------------------------------------------- */
input, textarea, select { font:inherit; color:var(--ink); background:var(--surface-2); border:1px solid var(--border-2); border-radius:var(--radius-sm); padding:10px 14px; width:100%; }
input:focus, textarea:focus, select:focus { outline:none; border-color:var(--ink); }
input::placeholder, textarea::placeholder { color:var(--ink-3); }
textarea { min-height:88px; font-family:var(--mono); font-size:13px; resize:vertical; }
label.field { display:block; margin:14px 0; }
label.field > .lbl { display:block; color:var(--ink); font-weight:600; font-size:13px; margin-bottom:6px; }
label.field > .lbl .req { color:var(--danger); font-weight:400; }
.checkbox { display:flex; align-items:center; gap:8px; }
.checkbox input { width:auto; }

/* --- editor 3-col layout ------------------------------------------------ */
.layout { display:grid; grid-template-columns:260px 1fr 400px; min-height:calc(100vh - 68px); gap:20px; padding:8px 28px 28px; }
.side { background:var(--surface); border-radius:var(--radius); padding:18px; overflow:auto; }
.canvas { padding:6px 0; overflow:auto; }
.inspect { background:var(--surface-2); border:1px solid var(--border); border-radius:var(--radius); padding:20px 22px; overflow:auto; }

.sect { color:var(--ink-3); font-family:var(--serif); font-style:italic; font-size:14px; letter-spacing:0; margin:18px 0 8px; }
.list { display:flex; flex-direction:column; gap:8px; }
.row { display:flex; align-items:center; gap:12px; padding:14px 18px; border:1px solid transparent; border-radius:var(--radius); background:var(--surface); cursor:pointer; transition:background .12s, border-color .12s; }
.row:hover { background:#e6dfcd; }
.row.active { border-color:var(--ink); background:var(--surface-2); }
.row .grow { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }

/* --- status pills ------------------------------------------------------- */
.pill { font-size:11px; padding:3px 10px; border-radius:var(--radius-pill); border:1px solid var(--border-2); color:var(--ink-2); background:var(--surface-2); font-weight:500; letter-spacing:.02em; }
.pill.published { color:var(--spring-ink); border-color:transparent; background:var(--spring); }
.pill.review, .pill.in_review { color:#4a3512; border-color:transparent; background:var(--amber-bg); }
.pill.rejected, .pill.archived { color:#5c1e1e; border-color:transparent; background:var(--danger-bg); }

/* --- editor regions / blocks ------------------------------------------- */
.region { margin-bottom:24px; }
.region > h3 { font-family:var(--serif); font-size:22px; color:var(--ink); margin:0 0 12px; display:flex; align-items:baseline; gap:12px; font-weight:400; }
.region > h3 .allow { font-family:var(--sans); font-size:11px; color:var(--ink-3); font-weight:400; }
.block { border:1px solid var(--border); border-radius:var(--radius); background:var(--surface-2); padding:14px 16px; margin-bottom:10px; transition:border-color .12s; }
.block.selected { border-color:var(--ink); }
.block .bhead { display:flex; align-items:center; gap:10px; }
.block .btype { font-family:var(--mono); font-size:12px; color:var(--ink-2); background:var(--surface); padding:2px 8px; border-radius:var(--radius-pill); }
.block .grow { flex:1; }
.block .shared { font-size:11px; color:var(--amber); }
.dropzone { border:1px dashed var(--border-2); border-radius:var(--radius); padding:14px; text-align:center; color:var(--ink-3); font-size:13px; }
.dropzone.over { border-color:var(--ink); color:var(--ink); }

.palette { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
.palette button { font-size:12px; padding:6px 14px; }
.repeater-item, .group { border:1px solid var(--border); border-radius:var(--radius-sm); padding:12px 14px; margin:8px 0; background:var(--surface); }
.repeater-item > .ih { display:flex; justify-content:flex-end; gap:4px; }

/* --- media library ------------------------------------------------------ */
.media-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
.media-cell { border:1px solid var(--border); border-radius:var(--radius-sm); overflow:hidden; cursor:pointer; background:var(--surface-2); transition:border-color .12s; }
.media-cell:hover { border-color:var(--border-2); }
.media-cell.sel { border-color:var(--ink); }
.media-cell img { width:100%; height:80px; object-fit:cover; display:block; }
.media-cell .fn { font-size:11px; padding:6px 8px; color:var(--ink-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.media-cell .ext { height:80px; display:flex; align-items:center; justify-content:center; font-family:var(--mono); font-size:12px; color:var(--ink-3); background:var(--surface); }

.media-lib { padding:0 28px 28px; max-width:1200px; margin:0 auto; }
.media-lib .media-grid { grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); }
.media-lib .media-cell img, .media-lib .media-cell .ext { height:130px; }
.media-toolbar { display:none; }
label.btn { display:inline-flex; align-items:center; }
.btn.disabled { opacity:.5; cursor:not-allowed; }
.media-detail img { max-width:100%; max-height:340px; object-fit:contain; display:block; margin:0 auto 14px; background:var(--surface); border-radius:var(--radius-sm); }
.media-detail .ext.lg { height:200px; display:flex; align-items:center; justify-content:center; font-family:var(--mono); color:var(--ink-3); background:var(--surface); border-radius:var(--radius-sm); margin-bottom:14px; }
.media-detail .kv a { word-break:break-all; }

/* --- modals ------------------------------------------------------------- */
.scrim { position:fixed; inset:0; background:rgba(20,15,5,.28); display:flex; align-items:center; justify-content:center; z-index:50; padding:24px; }
.modal { background:var(--surface-2); border:1px solid var(--border); border-radius:var(--radius); padding:32px 36px; width:min(680px,92vw); max-height:86vh; overflow:auto; box-shadow:0 24px 60px rgba(30,20,10,.12); }
.modal h2 { margin:0 0 20px; font-family:var(--serif); font-weight:400; font-size:28px; line-height:1.15; color:var(--ink); }
.modal h2 .dim { color:var(--ink-3); font-style:italic; }
.banner { padding:10px 14px; border-radius:var(--radius-sm); margin:8px 0; font-size:13px; }
.banner.err { background:var(--danger-bg); border:1px solid var(--danger); color:var(--danger); }
.banner.ok { background:var(--spring); border:1px solid var(--spring-dim); color:var(--spring-ink); }
.muted { color:var(--ink-3); }

/* --- tabs: pill nav (top bar) + pill sub-tabs (inspector) --------------- */
.tabs { display:flex; gap:4px; margin-bottom:12px; align-items:center; }
.tabs button { border-radius:var(--radius-pill); font-size:13px; padding:7px 16px; background:transparent; border-color:transparent; color:var(--ink); font-weight:500; }
.tabs button:hover { background:var(--surface); }
.tabs button.on { background:var(--surface); color:var(--ink); border-color:transparent; }
.tabs.nav { gap:2px; }
.tabs.nav button { font-size:14px; padding:8px 18px; }

.setup { max-width:520px; margin:14vh auto; padding:32px 40px; background:var(--surface-2); border:1px solid var(--border); border-radius:var(--radius); box-shadow:0 24px 60px rgba(30,20,10,.08); }
.setup h1 { font-family:var(--serif); font-weight:400; font-size:32px; margin:0 0 16px; color:var(--ink); }
.setup h1 .dim { color:var(--ink-3); font-style:italic; }
.setup .primary { width:100%; margin-top:8px; }
.kv { display:grid; grid-template-columns:auto 1fr; gap:8px 14px; font-size:13px; color:var(--ink-2); }
.kv > span:nth-child(odd) { color:var(--ink-3); font-family:var(--serif); font-style:italic; }

/* --- hero band (list views): big serif split heading + mint CTA card ---- */
.hero { display:grid; grid-template-columns:1fr auto; gap:24px; align-items:center; padding:32px 28px 24px; max-width:1200px; margin:0 auto; }
.hero-h { font-family:var(--serif); font-weight:400; font-size:56px; line-height:1.05; letter-spacing:-.01em; margin:0; }
.hero-h .lead { color:var(--ink-3); font-style:italic; display:block; }
.hero-h .em { color:var(--ink); font-style:normal; display:block; }
.cta { display:flex; align-items:center; gap:18px; background:var(--spring); border-radius:var(--radius-pill); padding:12px 12px 12px 28px; min-width:360px; }
.cta .cta-text { font-family:var(--serif); font-style:italic; font-size:18px; color:var(--spring-ink); }
.cta .cta-text .em { font-style:normal; font-weight:600; }
.cta button.primary { flex-shrink:0; }
.list-wrap { max-width:1200px; margin:0 auto; padding:8px 28px 32px; }
.list-wrap .sect { margin-top:0; }

/* --- rich text (WYSIWYG) ------------------------------------------------ */
.rt { border:1px solid var(--border-2); border-radius:var(--radius-sm); overflow:hidden; background:var(--surface-2); }
.rt-toolbar { display:flex; flex-wrap:wrap; gap:3px; padding:6px 8px; border-bottom:1px solid var(--border); background:var(--surface); }
.rt-toolbar button { padding:3px 10px; font-size:12px; border-radius:var(--radius-sm); background:transparent; border-color:transparent; color:var(--ink-2); }
.rt-toolbar button:hover { background:var(--surface-2); color:var(--ink); }
.rt-editor { min-height:180px; padding:14px 16px; font-family:var(--sans); font-size:14px; line-height:1.65; color:var(--ink); outline:none; }
.rt-editor:empty:before { content:attr(data-placeholder); color:var(--ink-3); pointer-events:none; }
.rt-editor:focus { box-shadow:inset 0 0 0 2px var(--ink); border-radius:0 0 var(--radius-sm) var(--radius-sm); }
.rt-editor h2 { font-family:var(--serif); font-weight:400; font-size:24px; line-height:1.2; margin:.7em 0 .3em; }
.rt-editor h3 { font-family:var(--serif); font-weight:400; font-size:19px; line-height:1.25; margin:.7em 0 .3em; }
.rt-editor p { margin:.55em 0; }
.rt-editor ul, .rt-editor ol { margin:.55em 0; padding-left:1.5em; }
.rt-editor li { margin:.2em 0; }
.rt-editor a { color:var(--ink); text-decoration:underline; text-underline-offset:2px; }
.rt-editor:first-child { margin-top:0; }

@media (max-width:820px) {
  .hero { grid-template-columns:1fr; padding:20px 20px 16px; }
  .hero-h { font-size:40px; }
  .cta { min-width:0; }
  .layout { grid-template-columns:1fr; padding:8px 20px 20px; }
  .list-wrap, .media-lib { padding-left:20px; padding-right:20px; }
}
`;
