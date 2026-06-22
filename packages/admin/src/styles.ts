// Inline stylesheet for the admin SPA. Borders-only depth, a single spring-teal
// accent (the "pramen" / source motif), semantic amber+red only. Tokens are named
// for the product's world: ink/slate for structure, spring for the live accent,
// strata for the schema panel. Mono everywhere data lives.

export const css = `
:root {
  --bg:        #0e1116;
  --surface:   #141921;
  --surface-2: #181e28;
  --raise:     #1d2531;
  --border:    #232c3a;
  --border-2:  #2e3a4d;
  --ink:       #e6edf3;
  --ink-2:     #aab7c7;
  --ink-3:     #6b7a8d;
  --spring:    #3fd6c0;
  --spring-dim:#1c8d80;
  --spring-bg: #0f2723;
  --amber:     #e0a458;
  --danger:    #e0606a;
  --danger-bg: #2a161a;
  --radius:    7px;
  --radius-sm: 5px;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Menlo", monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
#app { min-height: 100%; }

button {
  font-family: var(--sans);
  font-size: 13px;
  cursor: pointer;
  border: 1px solid var(--border-2);
  background: var(--raise);
  color: var(--ink);
  padding: 6px 11px;
  border-radius: var(--radius-sm);
  transition: background 150ms ease, border-color 150ms ease, color 150ms ease;
}
button:hover:not(:disabled) { background: var(--surface-2); border-color: #3a485e; }
button:active:not(:disabled) { background: var(--surface); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button:focus-visible { outline: 2px solid var(--spring-dim); outline-offset: 1px; }

button.primary {
  background: var(--spring-bg);
  border-color: var(--spring-dim);
  color: var(--spring);
}
button.primary:hover:not(:disabled) { background: #123029; border-color: var(--spring); }
button.danger { color: var(--danger); border-color: #4a2a2f; background: var(--danger-bg); }
button.danger:hover:not(:disabled) { border-color: var(--danger); background: #361a1f; }
button.ghost { background: transparent; border-color: transparent; color: var(--ink-2); padding: 4px 7px; }
button.ghost:hover:not(:disabled) { background: var(--surface-2); color: var(--ink); }
button.sm { padding: 3px 8px; font-size: 12px; }

input, textarea {
  font-family: var(--mono);
  font-size: 13px;
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm);
  padding: 7px 9px;
}
input::placeholder, textarea::placeholder { color: var(--ink-3); }
input:focus, textarea:focus { outline: none; border-color: var(--spring-dim); }
label { font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-3); display: block; margin-bottom: 4px; }

/* config bar */
.bar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: flex-end; gap: 14px;
  padding: 12px 18px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: baseline; gap: 9px; margin-right: 6px; padding-bottom: 5px; }
.brand .mark { color: var(--spring); font-family: var(--mono); font-weight: 600; letter-spacing: -0.02em; font-size: 16px; }
.brand .sub { color: var(--ink-3); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; }
.bar .field { display: flex; flex-direction: column; }
.bar .field.url input { width: 220px; }
.bar .field.token { flex: 1; min-width: 200px; }
.bar .field.token input { width: 100%; }
.bar .hint { font-size: 11px; color: var(--ink-3); padding-bottom: 7px; max-width: 180px; line-height: 1.35; }

.layout { display: grid; grid-template-columns: 270px 1fr; min-height: calc(100vh - 60px); }
.side { border-right: 1px solid var(--border); background: var(--surface-2); padding: 16px 14px; }
.main { padding: 20px 24px; min-width: 0; }

.sec-title { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); margin: 0 0 9px; }
.tenant-row { display: flex; gap: 6px; margin-bottom: 18px; }
.tenant-row select, .tenant-row input { flex: 1; min-width: 0; }

select {
  font-family: var(--mono); font-size: 13px;
  background: var(--bg); color: var(--ink);
  border: 1px solid var(--border-2); border-radius: var(--radius-sm);
  padding: 7px 9px;
}
select:focus { outline: none; border-color: var(--spring-dim); }

.hashchip {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 11px;
  color: var(--ink-2); background: var(--raise);
  border: 1px solid var(--border); border-radius: 20px;
  padding: 3px 10px; margin-bottom: 14px;
}
.hashchip .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--spring); }
.hashchip.none .dot { background: var(--ink-3); }

.tables { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.tables li button {
  width: 100%; text-align: left; border: 1px solid transparent; background: transparent;
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 7px 9px; border-radius: var(--radius-sm); color: var(--ink-2);
}
.tables li button:hover { background: var(--raise); color: var(--ink); }
.tables li button.active { background: var(--spring-bg); border-color: var(--spring-dim); color: var(--spring); }
.tables .tname { font-family: var(--mono); font-size: 13px; }
.tables .cols { font-size: 11px; color: var(--ink-3); }

.main-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.main-head h2 { margin: 0; font-family: var(--mono); font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
.countchip {
  font-family: var(--mono); font-size: 12px; color: var(--ink-2);
  border: 1px solid var(--border); border-radius: 20px; padding: 2px 10px;
}
.spacer { flex: 1; }

.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.pager { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 12px; color: var(--ink-2); }

.tablewrap { border: 1px solid var(--border); border-radius: var(--radius); overflow: auto; background: var(--surface); }
table.grid { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12.5px; }
table.grid th {
  position: sticky; top: 0; background: var(--surface-2);
  text-align: left; font-weight: 600; color: var(--ink-2);
  padding: 8px 12px; border-bottom: 1px solid var(--border); white-space: nowrap;
}
table.grid td { padding: 7px 12px; border-bottom: 1px solid var(--border); color: var(--ink); vertical-align: top; max-width: 360px; }
table.grid tr:last-child td { border-bottom: none; }
table.grid tbody tr:hover { background: var(--surface-2); }
.cell { display: inline-block; max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell.json { color: var(--amber); }
.cell.null { color: var(--ink-3); font-style: italic; }
.cell.bool { color: var(--spring); }
.rowactions { display: flex; gap: 4px; white-space: nowrap; }

.banner {
  display: flex; align-items: flex-start; gap: 10px;
  border: 1px solid #4a2a2f; background: var(--danger-bg);
  color: var(--danger); border-radius: var(--radius);
  padding: 10px 13px; margin-bottom: 14px; font-size: 13px;
}
.banner code { font-family: var(--mono); background: rgba(0,0,0,0.25); padding: 1px 5px; border-radius: 3px; color: var(--amber); }
.banner button { margin-left: auto; }

.empty, .loading { color: var(--ink-3); padding: 40px 0; text-align: center; font-size: 13px; }
.loading { color: var(--ink-2); }

/* modal */
.scrim { position: fixed; inset: 0; background: rgba(5,8,12,0.66); display: flex; align-items: flex-start; justify-content: center; padding: 56px 20px; z-index: 50; overflow: auto; }
.modal { width: 100%; max-width: 640px; background: var(--surface); border: 1px solid var(--border-2); border-radius: var(--radius); }
.modal-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.modal-head h3 { margin: 0; font-family: var(--mono); font-size: 15px; font-weight: 600; }
.modal-head .spacer { flex: 1; }
.modal-body { padding: 16px 18px; }
.modal-body textarea { width: 100%; min-height: 280px; resize: vertical; line-height: 1.55; tab-size: 2; }
.modal-foot { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-top: 1px solid var(--border); }
.modal-foot .spacer { flex: 1; }
.jsonerr { color: var(--danger); font-family: var(--mono); font-size: 12px; }
.muted { color: var(--ink-3); font-size: 12px; }

.placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 60vh; color: var(--ink-3); gap: 8px; }
.placeholder .big { font-family: var(--mono); color: var(--ink-2); font-size: 15px; }
`;
