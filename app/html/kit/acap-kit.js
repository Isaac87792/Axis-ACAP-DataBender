/*
 * acap-kit.js 1.4.2 - the shared parts of every one of these ACAP pages. Copy html/kit/ unchanged.
 * Needs acap-kit.css (and kit/acap-theme.js first in <head>, so the page starts in the right theme), and the camera side (kit.h, kit_*.c) for the resources, processes, apps
 * and log endpoints. No libraries.
 *
 * A page is:   <div id="kit-top"></div>                 header, resource bar, tabs, facts
 *              <main class="acap-main">
 *                <section data-kit-page="rules">…</section>   one per tab
 *              </main>
 * and calls    Kit.start({ name: 'Your App', tabs: [{ id: 'rules', label: 'Rules' }] })
 *
 * Parts (each built once here, never copied into an app):
 *   Kit.start(opts)              1 header with version, 2 resource bar + top-10 drawer,
 *                                3 tabs + camera facts + Live
 *   Kit.items(el, opts)          4 item table: On | name | source light | app columns | status | Test Log Edit
 *   Kit.footer(el, opts)         5 Save and Cancel, "Unsaved changes", leave-page warning
 *   Kit.log(el, opts)            6 live log behind a Log button: filter per column, Export CSV, Clear (asks first)
 *   Kit.ask(opts), Kit.editor(opts)   7 ask-first dialog, item editor shell (focus kept inside)
 *   Kit.modal(overlay, opts)     the same behaviour for a dialog written in the app's own HTML
 *   Kit.toast(text, kind), Kit.seg(el, onChange), Kit.exportJSON(), Kit.importJSON()
 *   Kit.get(url), Kit.post(url, body), Kit.fmt, Kit.esc, Kit.$, Kit.$$
 *   Kit.apps(), Kit.app(id), Kit.onApps(cb)   the camera's installed apps, every 5 s
 *   Kit.help(el, title, text), Kit.helpScan(root)   Help (i) buttons (1.2.0)
 *   Kit.configio(el, opts)       "Copy settings to other cameras": export, import, undo (1.3.0; kit_configio.c)
 *   Kit.color('--kit-c-apps')    a colour token's value under the current theme (1.3.0; the tokens are in acap-kit.css)
 *   Kit.theme.current(), .source(), .onChange(fn), .refresh()   light or dark, following the camera (1.4.0)
 *   Kit.dock()                   square a box's top corners while it touches the top bar; runs by itself on
 *                                scroll, resize and tab change (1.4.1)
 */
(function () {
'use strict';

const VERSION = '1.4.2';   /* the same as KIT_VERSION in kit.h */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => (v == null || v === '' || isNaN(v)) ? NaN : +v;
const p2 = n => (n < 10 ? '0' : '') + n;

/*---------------------------------------------------- formatting */
const fmt = {
	kb(kb) {
		kb = num(kb);
		if (isNaN(kb)) return '–';
		if (kb >= 1048576) return (kb / 1048576).toFixed(kb >= 10 * 1048576 ? 0 : 1) + ' GB';
		if (kb >= 1024) return (kb / 1024).toFixed(kb >= 100 * 1024 ? 0 : 1) + ' MB';
		return Math.round(kb) + ' kB';
	},
	pct(v, d) { v = num(v); return isNaN(v) ? '–' : v.toFixed(d == null ? (v < 10 && v > 0 ? 1 : 0) : d) + ' %'; },
	bps(v) {
		v = num(v);
		if (isNaN(v)) return '–';
		if (v >= 1e8) return Math.round(v / 1e6) + ' Mbit/s';
		if (v >= 1e6) return (v / 1e6).toFixed(1) + ' Mbit/s';
		return Math.round(v / 1e3) + ' kbit/s';
	},
	age(s) {
		s = Math.max(0, Math.round(num(s) || 0));
		if (s < 60) return s + ' s';
		if (s < 3600) return Math.floor(s / 60) + ' min';
		if (s < 86400) return Math.floor(s / 3600) + ' h ' + Math.floor(s % 3600 / 60) + ' min';
		return Math.floor(s / 86400) + ' d ' + Math.floor(s % 86400 / 3600) + ' h';
	},
	time(t, sec) { const d = new Date(t * 1000); return p2(d.getHours()) + ':' + p2(d.getMinutes()) + (sec === false ? '' : ':' + p2(d.getSeconds())); },
	date(d) { d = d || new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
};

/*---------------------------------------------------- talking to the camera (same folder as the page) */
async function get(url) {
	const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
	if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
	return r.json();
}
async function post(url, body) {
	const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	const text = await r.text();
	let j = null;
	try { j = JSON.parse(text); } catch (e) { /* plain text answer */ }
	if (!r.ok) throw new Error((j && j.message) || text || r.statusText);
	return j != null ? j : text;
}

/* A poller that pauses while the browser tab is hidden and runs again when it shows */
function every(ms, fn) {
	let timer = null, stopped = false;
	async function run() {
		clearTimeout(timer);
		if (stopped) return;
		if (!document.hidden) { try { await fn(); } catch (e) { /* the caller shows its own state */ } }
		timer = setTimeout(run, ms);
	}
	document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
	run();
	return { now: run, stop() { stopped = true; clearTimeout(timer); } };
}

/*==================================================== shared state */
const K = { opts: {}, app: {}, device: {}, res: {}, resOk: 0, appsList: [], appsCb: [], tab: null, open: null };

/*==================================================== Toast */
let toastTimer = null;
function toast(text, kind) {
	let t = $('#kit-toast');
	if (!t) { t = document.createElement('div'); t.id = 'kit-toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.appendChild(t); }
	t.className = 'toast ' + (kind || 'ok');
	t.textContent = text;
	t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'bad' ? 8000 : 4000);
}

/*==================================================== Segmented switch */
function seg(el, onChange) {
	$$('button', el).forEach(b => {
		b.type = 'button';
		b.setAttribute('aria-pressed', b.classList.contains('on'));
		b.onclick = () => {
			$$('button', el).forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
			if (onChange) onChange(b.dataset.v);
		};
	});
	return { value: () => { const b = $('button.on', el); return b && b.dataset.v; } };
}

/*==================================================== Dialogs (focus kept inside, Escape closes, focus returns)
 * Open dialogs form a stack: only the top one answers Escape and Tab, so a dialog opened from
 * another (Context from a rule, Delete? from an editor) closes alone. */
const dlgStack = [];
const focusablesIn = dlg => $$('button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])', dlg).filter(e => !e.disabled && e.offsetParent !== null);
/* Esc closes one thing, the topmost, in this fixed order: an open Help popover first, then the top dialog,
 * then the resource drawer. This one handler decides; nothing else listens for Esc, so the order never
 * depends on which part registered first. Each part gives a function that closes it and returns true. */
const escOrder = { help: () => false, drawer: () => false };
document.addEventListener('keydown', e => {
	const top = dlgStack[dlgStack.length - 1];
	if (e.key === 'Escape') {
		if (escOrder.help() || (top && (top.escape(), true)) || escOrder.drawer()) { e.preventDefault(); e.stopImmediatePropagation(); }
		return;
	}
	if (!top || e.key !== 'Tab') return;
	const f = focusablesIn(top.dlg);
	if (!f.length) { e.preventDefault(); return; }
	const first = f[0], last = f[f.length - 1];
	if (!top.dlg.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
	else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
	else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}, true);
function focusFirst(dlg) {
	const f = focusablesIn(dlg);
	const pick = $('[autofocus]', dlg) || f.find(x => x.matches('input,select,textarea')) || f[f.length - 1];
	if (pick) pick.focus();
}

function openDialog(html, wide) {
	const back = document.activeElement;
	const o = document.createElement('div');
	o.className = 'overlay';
	o.innerHTML = '<div class="dialog' + (wide ? '' : ' sm') + '" role="dialog" aria-modal="true">' + html + '</div>';
	document.body.appendChild(o);
	const dlg = $('.dialog', o);
	const h = $('h3', dlg);
	if (h) { h.id = 'kit-dlg-' + Date.now(); dlg.setAttribute('aria-labelledby', h.id); }
	let onClose = null;
	const entry = { dlg, escape: () => close(null) };
	dlgStack.push(entry);
	function close(result) {
		const i = dlgStack.indexOf(entry);
		if (i < 0) return;
		dlgStack.splice(i, 1);
		o.remove();
		if (back && back.focus) back.focus();
		if (onClose) onClose(result);
	}
	o.addEventListener('mousedown', e => { if (e.target === o) close(null); });
	return { root: dlg, close, onClose(fn) { onClose = fn; }, focus() { focusFirst(dlg); } };
}

/* A dialog written in the app's own HTML: <div class="overlay" hidden><div class="dialog">…</div></div>
 * Kit.modal(overlay, { onEscape }) -> { open(focusEl), close(), isOpen() }
 * Gives it the same behaviour as the kit's dialogs. onEscape runs on Escape or a click outside
 * (default: close); use it when closing needs the app's own clean-up. */
function modal(o, opts) {
	opts = opts || {};
	const dlg = $('.dialog', o) || o;
	dlg.setAttribute('role', 'dialog');
	dlg.setAttribute('aria-modal', 'true');
	const h = $('h3', dlg);
	if (h && !dlg.getAttribute('aria-labelledby')) { if (!h.id) h.id = 'kit-dlg-' + Math.random().toString(36).slice(2); dlg.setAttribute('aria-labelledby', h.id); }
	let back = null;
	const entry = { dlg, escape: () => (opts.onEscape ? opts.onEscape() : api.close()) };
	const api = {
		open(focusEl) {
			if (dlgStack.includes(entry)) return;
			back = document.activeElement;
			o.hidden = false;
			dlgStack.push(entry);
			setTimeout(() => { if (focusEl && focusEl.focus) focusEl.focus(); else focusFirst(dlg); }, 0);
		},
		close() {
			const i = dlgStack.indexOf(entry);
			o.hidden = true;
			if (i < 0) return;
			dlgStack.splice(i, 1);
			if (back && back.focus && document.contains(back)) back.focus();
		},
		isOpen: () => dlgStack.includes(entry)
	};
	o.addEventListener('mousedown', e => { if (e.target === o) entry.escape(); });
	return api;
}

/* Ask first: Kit.ask({ title, text, ok: 'Clear log', danger: true, logged: true }) -> Promise<boolean> */
function ask(o) {
	return new Promise(resolve => {
		const d = openDialog('<h3>' + esc(o.title) + '</h3><p class="hint">' + esc(o.text || '') + '</p>' +
			(o.logged ? '<p class="hint small">This is written to the log with your camera user name and the time.</p>' : '') +
			'<div class="dlg-actions"><span class="spacer"></span><button type="button" class="btn" data-r="0">Cancel</button>' +
			'<button type="button" class="btn primary" data-r="1">' + esc(o.ok || 'OK') + '</button></div>');
		d.onClose(r => resolve(!!r));
		$$('[data-r]', d.root).forEach(b => { b.onclick = () => d.close(b.dataset.r === '1'); });
		$('[data-r="1"]', d.root).focus();
	});
}

/* Item editor shell:
 * Kit.editor({ title, enabled, body: '<div class="form">…</div>', how: 'text' or fn(root),
 *              fill(root), done(root, enabled) -> false to keep it open, test(root), remove() })
 * Title and Enabled switch on top; Delete left; Test, Cancel and Done right. */
function editor(o) {
	const d = openDialog(
		'<div class="dlg-head"><h3>' + esc(o.title || 'Item') + '</h3>' +
		(o.enabled == null ? '' : '<label class="switch"><input type="checkbox" class="k-en" aria-label="Enabled"' + (o.enabled ? ' checked' : '') + '><span class="track"></span></label>') + '</div>' +
		'<p class="hint small" style="margin-top:4px">' + esc(o.note || 'Changes apply when you press Save on the page.') + '</p>' +
		(o.body || '') + '<div class="how"></div>' +
		'<div class="dlg-actions">' + (o.remove ? '<button type="button" class="btn subtle danger k-del">Delete</button>' : '') +
		'<span class="spacer"></span>' + (o.test ? '<button type="button" class="btn k-test">Test</button>' : '') +
		'<button type="button" class="btn k-cancel">Cancel</button><button type="button" class="btn primary k-done">Done</button></div>', true);
	const root = d.root;
	const how = () => { const h = $('.how', root); h.innerHTML = typeof o.how === 'function' ? (o.how(root) || '') : esc(o.how || ''); };
	if (o.fill) o.fill(root);
	how();
	root.addEventListener('input', how);
	root.addEventListener('change', how);
	const en = () => { const s = $('.k-en', root); return s ? s.checked : null; };
	$('.k-cancel', root).onclick = () => d.close(null);
	$('.k-done', root).onclick = () => { if (!o.done || o.done(root, en()) !== false) d.close(true); };
	if (o.test) $('.k-test', root).onclick = () => o.test(root);
	if (o.remove) $('.k-del', root).onclick = async () => {
		if (await ask({ title: 'Delete ' + (o.title || 'this item') + '?', text: 'It is removed when you press Save on the page.', ok: 'Delete' })) { d.close(null); o.remove(); }
	};
	d.focus();
	return d;
}

/*==================================================== Export / import of items (JSON files) */
function download(name, text, type) {
	const a = document.createElement('a');
	a.href = URL.createObjectURL(new Blob([text], { type: type || 'application/json' }));
	a.download = name;
	document.body.appendChild(a); a.click(); a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function fileBase(what) { return (K.opts.name || 'acap').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + what + '-' + (K.device.serial || 'camera') + '-' + fmt.date(); }
function exportJSON(what, data) { download(fileBase(what) + '.json', JSON.stringify(data, null, 2)); }
function importJSON() {
	return new Promise((resolve, reject) => {
		const i = document.createElement('input');
		i.type = 'file'; i.accept = '.json,application/json';
		i.onchange = () => {
			const f = i.files[0];
			if (!f) return resolve(null);
			f.text().then(t => { try { resolve(JSON.parse(t)); } catch (e) { reject(new Error('That file is not a JSON export.')); } }, reject);
		};
		i.click();
	});
}

/*==================================================== 1-3 Header, resource bar, tabs and facts */
const METERS = [
	{ k: 'cpu', label: 'CPU' }, { k: 'mem', label: 'Memory' }, { k: 'flash', label: 'Storage' },
	{ k: 'sd', label: 'SD card' }, { k: 'net', label: 'Ethernet' }, { k: 'temp', label: 'Temperature' }
];

function start(opts) {
	K.opts = opts = Object.assign({ name: document.title, tabs: null }, opts);
	const top = $('#kit-top');
	top.className = 'kit-top';
	const tabs = opts.tabs && opts.tabs.length > 1 ? opts.tabs : null;
	top.innerHTML =
		'<header class="acap-header"><div class="acap-name"><h1 class="acap-title">' + esc(opts.name) + '</h1><button type="button" class="acap-ver" id="kit-ver" hidden></button></div>' +
		'<div class="cam-facts"><span><b id="kit-model">…</b></span><span>AXIS OS <b id="kit-os">…</b></span><span id="kit-chip-w"><b id="kit-chip"></b></span>' +
		'<span>Up <b id="kit-up">…</b></span><span class="live" id="kit-live">Live</span></div>' +
		'<span class="acap-credit">Created by <strong>Isaac87792</strong></span></header>' +
		'<div class="rbar" role="group" aria-label="Resources">' +
		METERS.map(m => '<button type="button" class="rb" data-k="' + m.k + '" aria-expanded="false" aria-controls="kit-drawer"><span>' + m.label + '</span>' +
			'<span class="meter" aria-hidden="true"><span class="m-cam"></span><span class="m-app"></span></span><b>…</b><em></em></button>').join('') +
		'<span class="rkey"><span class="key"><i class="k-cam"></i>Camera</span><span class="key"><i class="k-app"></i>Apps</span></span></div>' +
		'<div class="drawer" id="kit-drawer" hidden></div>' +
		(tabs ? '<div class="tabbar"><nav class="acap-tabs" aria-label="Pages">' + tabs.map(t => '<a href="#' + esc(t.id) + '" data-tab="' + esc(t.id) + '">' + esc(t.label) + '</a>').join('') + '</nav></div>' : '');
	document.title = opts.name;

	$$('.rb', top).forEach(b => { b.onclick = () => toggleDrawer(b.dataset.k); });
	addEventListener('scroll', dock, { passive: true });
	addEventListener('resize', dock);
	document.addEventListener('click', () => setTimeout(dock, 0));   /* a box that opened or closed moves the ones below it */
	setTimeout(dock, 0);
	/* Click only: the details open on a click and close on a click elsewhere or Esc */
	document.addEventListener('click', e => { if (K.open && !e.target.closest('#kit-drawer, .rb')) toggleDrawer(K.open); });
	escOrder.drawer = () => { if (!K.open) return false; const b = $('.rb[data-k="' + K.open + '"]'); toggleDrawer(K.open); if (b) b.focus(); return true; };
	if (tabs) {
		$$('.acap-tabs a', top).forEach(a => { a.onclick = e => { e.preventDefault(); showTab(a.dataset.tab); }; });
		const want = location.hash.slice(1);
		showTab(tabs.some(t => t.id === want) ? want : tabs[0].id);
	}

	get('app').then(a => {
		K.app = a || {};
		K.device = (a && a.device) || {};
		const setup = (((a && a.manifest) || {}).acapPackageConf || {}).setup || {};
		const v = $('#kit-ver');
		v.textContent = setup.version || '';
		v.hidden = !setup.version;
		v.dataset.helpTitle = opts.name + ' ' + (setup.version || '');
		v.dataset.help = 'Version ' + (setup.version || '?') + ', made with UI kit ' + VERSION + '.';
		$('#kit-model').textContent = K.device.model && K.device.model !== 'Unknown' ? 'AXIS ' + K.device.model.replace(/^AXIS\s+/i, '') : 'Axis camera';
		$('#kit-os').textContent = K.device.firmware || '–';
		const chip = K.device.platform && K.device.platform !== 'Unknown' ? K.device.platform.replace(/^axis\s+/i, '').toUpperCase() : '';
		$('#kit-chip').textContent = chip;
		$('#kit-chip-w').hidden = !chip;
	}).catch(() => { $('#kit-model').textContent = 'Axis camera'; });

	every(2000, pollResources);
	every(5000, pollApps);
	setInterval(drawLive, 1000);
}

function showTab(id) {
	K.tab = id;
	$$('.acap-tabs a').forEach(a => { const on = a.dataset.tab === id; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
	$$('[data-kit-page]').forEach(p => { p.hidden = p.dataset.kitPage !== id; });
	if (history.replaceState) history.replaceState(null, '', '#' + id);
	if (K.opts.onTab) K.opts.onTab(id);
	setTimeout(dock, 0);
}

/* 1.4.1: a box whose top meets the bottom of the sticky top bar (scrolled up under it) gets square top corners
 * there (.docked); round again once it moves away */
function dock() {
	const bar = $('#kit-top'), edge = bar ? bar.getBoundingClientRect().bottom : 0;
	/* The bar's height, so a jump to a box (the Log button) stops 17 px below the bar, not under it */
	document.documentElement.style.setProperty('--kit-top-h', (bar ? bar.offsetHeight : 0) + 'px');
	$$('.acap-panel').forEach(p => {
		const r = p.getBoundingClientRect();
		p.classList.toggle('docked', r.height > 0 && r.top <= edge + 1 && r.bottom > edge);
	});
}

async function pollResources() {
	try { K.res = await get('resources'); K.resOk = Date.now(); drawBar(); }
	catch (e) { drawLive(); throw e; }
	if (K.open) drawDrawer();
}

function drawLive() {
	const l = $('#kit-live');
	if (!l) return;
	const lost = !K.resOk || Date.now() - K.resOk > 8000;
	l.className = 'live' + (document.hidden ? ' paused' : lost && K.resOk ? ' lost' : '');
	l.textContent = document.hidden ? 'Paused' : lost && K.resOk ? 'No answer for ' + fmt.age((Date.now() - K.resOk) / 1000) : 'Live';
}

function setMeter(k, camPct, appPct, text, appText, title, hot) {
	const b = $('.rb[data-k="' + k + '"]');
	if (!b) return;
	$('.m-cam', b).style.width = (isNaN(camPct) ? 0 : Math.max(0, Math.min(100, camPct))) + '%';
	$('.m-app', b).style.width = (isNaN(appPct) ? 0 : Math.max(0, Math.min(100, appPct))) + '%';
	$('.m-app', b).hidden = !(appPct > 0);
	$('.meter', b).classList.toggle('hot', !!hot);
	$('b', b).textContent = text;
	$('em', b).textContent = appText || '';
	b.dataset.sum = title;
}

function drawBar() {
	/* As in Resource Monitor: the camera in grey, all installed apps (this one among them) in yellow */
	const r = K.res, me = K.opts.name;
	setMeter('cpu', num(r.cpu), num(r.appsCpu), fmt.pct(r.cpu), isNaN(num(r.appsCpu)) ? '' : fmt.pct(r.appsCpu, 1),
		'Camera ' + fmt.pct(r.cpu) + ' of all ' + (r.cores || '?') + ' cores. Apps ' + fmt.pct(r.appsCpu, 1) + '; ' + me + ' ' + fmt.pct(r.appCpu, 1) + '.', num(r.cpu) > 90);
	const memUsed = num(r.memTotalKb) - num(r.memAvailKb);
	setMeter('mem', 100 * memUsed / num(r.memTotalKb), 100 * num(r.appsMemKb) / num(r.memTotalKb), fmt.pct(100 * memUsed / num(r.memTotalKb)), isNaN(num(r.appsMemKb)) ? '' : fmt.kb(r.appsMemKb),
		'Camera ' + fmt.kb(memUsed) + ' of ' + fmt.kb(r.memTotalKb) + '. Apps ' + fmt.kb(r.appsMemKb) + '; ' + me + ' ' + fmt.kb(r.appMemKb) + '.', memUsed / num(r.memTotalKb) > .9);
	const fUsed = num(r.flashTotalKb) - num(r.flashFreeKb);
	setMeter('flash', 100 * fUsed / num(r.flashTotalKb), NaN, fmt.pct(100 * fUsed / num(r.flashTotalKb)), '',
		fmt.kb(r.flashFreeKb) + ' free of ' + fmt.kb(r.flashTotalKb) + '. ' + me + ' ' + fmt.kb(r.appDiskKb) + '.', fUsed / num(r.flashTotalKb) > .9);
	if (num(r.sdTotalKb) > 0) {
		const sUsed = num(r.sdTotalKb) - num(r.sdFreeKb);
		setMeter('sd', 100 * sUsed / num(r.sdTotalKb), NaN, fmt.pct(100 * sUsed / num(r.sdTotalKb)), '', fmt.kb(r.sdFreeKb) + ' free of ' + fmt.kb(r.sdTotalKb) + '.', sUsed / num(r.sdTotalKb) > .95);
	} else setMeter('sd', NaN, NaN, 'No card', '', 'No SD card found, or it is not ready.');
	const net = num(r.netInBps) + num(r.netOutBps), link = num(r.netLinkMbps) * 1e6;
	setMeter('net', 100 * net / link, NaN, fmt.bps(net), '', 'In ' + fmt.bps(r.netInBps) + ', out ' + fmt.bps(r.netOutBps) + (link ? ' on a ' + r.netLinkMbps + ' Mbit/s link' : '') + '.');
	const t = num(r.tempC);
	setMeter('temp', (t + 20) / 1.2, NaN, isNaN(t) ? '–' : t.toFixed(1) + ' °C', '', isNaN(t) ? 'The camera does not report its temperature to apps.' : 'Warmest sensor inside the camera.', t > 75);
	if (r.uptime) $('#kit-up').textContent = fmt.age(r.uptime);
	drawLive();
}

/* Drawer: CPU and Memory show the top 10 processes; the others show their details */
let procTimer = null, procData = null;
function toggleDrawer(k) {
	K.open = K.open === k ? null : k;
	$$('.rb').forEach(b => b.setAttribute('aria-expanded', b.dataset.k === K.open));
	$('#kit-drawer').hidden = !K.open;
	clearTimeout(procTimer);
	procData = null;
	if (K.open === 'cpu' || K.open === 'mem') pollProcs();
	if (K.open) drawDrawer();
}
async function pollProcs() {
	clearTimeout(procTimer);
	if (K.open !== 'cpu' && K.open !== 'mem') return;
	try { procData = await get('processes?by=' + K.open); } catch (e) { procData = { error: e.message }; }
	drawDrawer();
	procTimer = setTimeout(pollProcs, procData && procData.ready === false ? 1500 : 5000);
}
/* Links to another app's page always open in a new tab, so the app you're in stays open */
const EXT_ICON = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M7 1.5h3.5V5M10.5 1.5 5.5 6.5M9 7.5v3H1.5V3h3"/></svg>';
function rmLink() {
	const rm = app('resource_monitor');
	return rm && rm.status === 'Running' && !rm.self ? '<a class="small ext" href="../resource_monitor/index.html" target="_blank" rel="noopener">Graphs in Resource Monitor' + EXT_ICON + '<span class="sr"> (opens in a new tab)</span></a>' : '';
}
function drawDrawer() {
	const d = $('#kit-drawer'), r = K.res, k = K.open;
	if (!k) return;
	const sumB = $('.rb[data-k="' + k + '"]'), sum = sumB && sumB.dataset.sum ? '<p class="dsum">' + esc(sumB.dataset.sum) + '</p>' : '';
	if (k === 'cpu' || k === 'mem') {
		const byMem = k === 'mem';
		let rows = '';
		if (!procData) rows = '<tr><td class="hint">Reading processes…</td></tr>';
		else if (procData.error) rows = '<tr><td class="hint">Could not read the processes: ' + esc(procData.error) + '</td></tr>';
		else if (!byMem && procData.ready === false) rows = '<tr><td class="hint">Measuring…</td></tr>';
		else {
			const list = (procData.top || []).concat(procData.other && procData.other.count ? [procData.other] : []);
			const max = Math.max.apply(null, list.map(p => byMem ? p.memKb : p.cpu).concat([0.001]));
			rows = list.map((p, i) => {
				const v = byMem ? p.memKb : p.cpu, isOther = i === list.length - 1 && procData.other && procData.other.count && p === procData.other;
				const owner = isOther ? '' : p.app ? (app(p.app) ? app(p.app).name : p.app) : 'Camera';
				return '<tr class="' + (isOther ? 'oth' : p.app ? 'app' : '') + '"><td><span class="pn">' + esc(isOther ? 'Other (' + p.count + ' processes)' : p.name) + '</span>' +
					(owner ? ' <span class="hint small">' + esc(owner) + '</span>' : '') + (p.count > 1 && !isOther ? ' <span class="hint small">×' + p.count + '</span>' : '') + '</td>' +
					'<td class="b"><div class="bar"><span style="width:' + Math.round(100 * v / max) + '%"></span></div></td>' +
					'<td class="v">' + (byMem ? fmt.kb(v) : fmt.pct(v, 1)) + '</td></tr>';
			}).join('');
		}
		d.innerHTML = '<h4>Using the most ' + (byMem ? 'memory' : 'CPU') + ' ' + rmLink() + '</h4>' + sum + '<table><tbody>' + rows + '</tbody></table>' +
			'<div class="dkey"><span class="key"><i class="k-cam"></i>Camera</span><span class="key"><i class="k-app"></i>Apps</span></div>' +
			'<div class="hint small" style="margin-top:6px">' + (byMem ? 'Private memory of each process.' : 'Share of the whole camera over the last 5 seconds.') +
			' Processes with the same name are added together; everything after the top 10 is under Other.</div>';
		return;
	}
	const rowsOf = list => '<div class="facts-list">' + list.filter(x => x[1] != null && x[1] !== '').map(x => '<b>' + esc(x[0]) + '</b><span>' + esc(x[1]) + '</span>').join('') + '</div>';
	const titles = { flash: 'Storage', sd: 'SD card', net: 'Ethernet', temp: 'Temperature' };
	let body = '';
	if (k === 'flash') body = rowsOf([['Free', fmt.kb(r.flashFreeKb)], ['Size', fmt.kb(r.flashTotalKb)], [K.opts.name + ' uses', fmt.kb(r.appDiskKb)]]);
	if (k === 'sd') body = num(r.sdTotalKb) > 0 ? rowsOf([['Free', fmt.kb(r.sdFreeKb)], ['Size', fmt.kb(r.sdTotalKb)]]) : '<p class="hint" style="margin:0">No SD card found, or it is not ready.</p>';
	if (k === 'net') body = rowsOf([['In', fmt.bps(r.netInBps)], ['Out', fmt.bps(r.netOutBps)], ['Link', r.netLinkMbps ? r.netLinkMbps + ' Mbit/s' : 'Unknown'], ['Interface', r.netIf]]);
	if (k === 'temp') body = isNaN(num(r.tempC)) ? '<p class="hint" style="margin:0">The camera does not report its temperature to apps.</p>' : rowsOf([['Warmest sensor', num(r.tempC).toFixed(1) + ' °C']]);
	d.innerHTML = '<h4>' + titles[k] + ' ' + rmLink() + '</h4>' + sum + body;
}

/*---------------------------------------------------- installed apps (source lights) */
async function pollApps() {
	const a = await get('apps');
	K.appsList = a.apps || [];
	K.appsCb.forEach(cb => { try { cb(K.appsList); } catch (e) { console.error(e); } });
}
function apps() { return K.appsList; }
function app(id) { return K.appsList.find(a => a.id === id) || null; }
function onApps(cb) { K.appsCb.push(cb); if (K.appsList.length) cb(K.appsList); }

/*==================================================== 4 Item table
 * Kit.items(el, {
 *   noun: 'rule',                                   for "No rules yet"
 *   nameLabel: 'Rule',
 *   columns: [{ label, width: '16%', cell: item => html }],   the app's own columns, up to 3
 *   sub: item => 'small text under the name',
 *   source: item => ({ name, state: 'good'|'bad'|'cam'|'none', sub, tip }) or null,
 *   status: item => ({ word: 'Listening'|'Triggered'|'Waiting'|'Disabled'|'Problem'|'Not saved', extra: '14:02', tip }),
 *           extra is a short time or reason shown next to the word (optional)
 *   info: item => 'technical details on hover' or '',
 *   onToggle(item, on), onTest(item), onLog(item), onEdit(item),
 *   rowClick: true,                 a click on the row (not on a control) opens onEdit
 *   logActive: item => bool,        marks the Log button while the log shows only this item
 *   extra: [{ label, show: item => bool, onClick: item => {} }]   more buttons before Test
 * }) -> { render(items) }
 * Items need an `id` and a `name`; `enabled` drives the switch. */
const STATUS = { Listening: 's-listen', Triggered: 's-trig', Waiting: 's-wait', Dwell: 's-wait', Disabled: 's-dis', Problem: 's-prob', 'Not saved': 's-unsaved', 'Starting…': 's-dis' };
function items(el, o) {
	o = Object.assign({ noun: 'item', nameLabel: 'Item', columns: [] }, o);
	const cols = o.columns.slice(0, 3);
	el.innerHTML = '<table class="acap-table kit-items kit-stack"><colgroup><col class="c-on"><col>' + (o.source ? '<col class="c-src">' : '') +
		cols.map(c => '<col style="width:' + (c.width || '14%') + '">').join('') + '<col class="c-st"><col class="c-act"></colgroup>' +
		'<thead><tr><th>On</th><th>' + esc(o.nameLabel) + '</th>' + (o.source ? '<th>Source</th>' : '') +
		cols.map(c => '<th>' + esc(c.label) + '</th>').join('') + '<th>Status</th><th><span class="sr">Actions</span></th></tr></thead><tbody></tbody></table>';
	const body = $('tbody', el);
	let list = [];
	/* The row's (i): its status reason, where it comes from, and the app's details, one paragraph each */
	function details(it, st, src, info) {
		return [st && st.tip ? (st.word ? st.word + ': ' : '') + st.tip : '', src && src.tip ? 'Source: ' + src.tip : '', info || ''].filter(Boolean).join('\n');
	}
	function render(newList) {
		if (newList) list = newList;
		const span = 4 + cols.length + (o.source ? 1 : 0);
		if (!list.length) { body.innerHTML = '<tr><td colspan="' + span + '" class="k-empty">No ' + esc(o.noun) + 's yet. Add one to start.</td></tr>'; return; }
		body.innerHTML = list.map((it, i) => {
			const st = o.status ? o.status(it) || {} : {};
			const src = o.source ? o.source(it) : null;
			const info = o.info ? o.info(it) : '';
			const extra = (o.extra || []).filter(x => !x.show || x.show(it)).map((x, j) => '<button type="button" class="btn sm" data-x="' + j + '">' + esc(x.label) + '</button>').join('');
			return '<tr data-i="' + i + '">' +
				'<td data-l=""><label class="switch"><input type="checkbox" class="k-on" aria-label="' + esc(it.name) + ' enabled"' + (it.enabled ? ' checked' : '') + '><span class="track"></span></label></td>' +
				'<td data-l="" class="k-name"><b>' + esc(it.name || '(no name)') + '</b>' + (o.sub ? '<small>' + esc(o.sub(it) || '') + '</small>' : '') + '</td>' +
				(o.source ? '<td data-l="Source">' + (src ? '<span class="src"><span class="status ' + (src.state || 'none') + '">' + esc(src.name) + '</span><small class="' + (src.state === 'bad' ? 'bad' : '') + '">' + esc(src.sub || '') + '</small></span>' : '<span class="hint">–</span>') + '</td>' : '') +
				cols.map(c => '<td data-l="' + esc(c.label) + '">' + (c.cell ? c.cell(it) : '') + '</td>').join('') +
				'<td data-l="Status"><span class="k-status"><span class="status ' + (STATUS[st.word] || 's-dis') + '">' + esc(st.word || '–') + '</span>' +
				(st.extra ? '<span class="status-extra">' + esc(st.extra) + '</span>' : '') + '</span></td>' +
				'<td data-l=""><div class="k-acts">' + extra +
				(o.onTest ? '<button type="button" class="btn sm k-test">Test</button>' : '') +
				(o.onLog ? '<button type="button" class="btn sm k-log' + (o.logActive && o.logActive(it) ? ' active' : '') + '" aria-label="Show only ' + esc(it.name) + ' in the log">Log</button>' : '') +
				(o.onEdit ? '<button type="button" class="btn sm k-edit">Edit</button>' : '') +
				(details(it, st, src, info) ? '<button type="button" class="kit-info" data-help-title="' + esc(it.name || 'Details') + '" data-help="' + esc(details(it, st, src, info)) + '" aria-label="Details: ' + esc(it.name || '') + '" aria-expanded="false">i</button>' : '') +
				'</div></td></tr>';
		}).join('');
		$$('tr[data-i]', body).forEach(tr => {
			const it = list[+tr.dataset.i];
			const on = $('.k-on', tr);
			on.onchange = () => { if (o.onToggle) o.onToggle(it, on.checked); };
			if (o.onTest) $('.k-test', tr).onclick = () => o.onTest(it);
			if (o.onLog) $('.k-log', tr).onclick = () => o.onLog(it);
			if (o.onEdit) $('.k-edit', tr).onclick = () => o.onEdit(it);
			if (o.rowClick && o.onEdit) {
				tr.classList.add('k-click');
				tr.onclick = e => { if (!e.target.closest('button,input,label,select,a')) o.onEdit(it); };
			}
			$$('[data-x]', tr).forEach(b => { b.onclick = () => o.extra.filter(x => !x.show || x.show(it))[+b.dataset.x].onClick(it); });
		});
	}
	render([]);
	return { render };
}

/*==================================================== 5 Save and Cancel
 * Kit.footer(el, { onSave: async () => {}, onCancel: () => {}, savedText: 'Saved.' }) -> { dirty(bool), busy(text|null), isDirty() }
 * onSave throws to report a problem ("Could not save: <message>"); savedText false shows no toast
 * (when onSave shows its own). */
function footer(el, o) {
	el.className = 'kit-foot';
	el.innerHTML = '<span class="k-dirty" hidden>Unsaved changes</span><span class="k-busy" hidden></span>' +
		'<button type="button" class="btn k-cancel" disabled>Cancel</button><button type="button" class="btn primary k-save" disabled>Save</button>';
	let isDirty = false, isBusy = false;
	function draw() {
		$('.k-dirty', el).hidden = !isDirty || isBusy;
		$('.k-cancel', el).disabled = !isDirty || isBusy;
		$('.k-save', el).disabled = !isDirty || isBusy;
	}
	$('.k-cancel', el).onclick = () => { if (o.onCancel) o.onCancel(); };
	$('.k-save', el).onclick = async () => {
		api.busy('Saving…');
		try { await o.onSave(); if (o.savedText !== false) toast(o.savedText || 'Saved.'); }
		catch (e) { toast('Could not save: ' + e.message, 'bad'); }
		api.busy(null);
	};
	window.addEventListener('beforeunload', e => { if (isDirty) { e.preventDefault(); e.returnValue = ''; } });
	const api = {
		dirty(b) { isDirty = !!b; draw(); },
		busy(text) { isBusy = !!text; const s = $('.k-busy', el); s.hidden = !text; s.textContent = text || ''; draw(); },
		isDirty: () => isDirty
	};
	draw();
	return api;
}

/*==================================================== 6 Log
 * Kit.log(el, {
 *   hint: 'What came in, and exactly what was sent.',
 *   itemLabel: 'Rule',
 *   columns: [{ key: 'what', label: 'Received' },
 *             { key: 'sent', label: 'Sent', cell: line => html, text: line => 'plain text for filter and CSV',
 *               options: [{ v: 'On', label: 'On', match: line => line.state === 'On' }, …] },   a list filter beside the text box
 *             { key: 'who', label: 'Who' }],
 *   empty: 'Nothing yet. Use Test, or wait for a source event.',
 *   onLines: lines => {},   called after each read, newest first (for example to remember each item's last line)
 *   every: 3000,
 *   button: '#log-btn'      1.3.0: the button that shows and hides the log (element or selector). Without one the
 *                           kit puts a "Log" button just above the log. The log stays hidden until it is pressed.
 * }) -> { filterTo(itemName), refresh(), lines(), show(), hide(), toggle(), shown() }
 * The log is behind a Log button (ACAP UI standard): hidden at first; the button says "Log" or "Hide log".
 * filterTo (an item's own Log button) shows it too.
 * Lines come from the kit's log endpoint: { t, item, who } plus what / detail (kit_log) or the app's
 * own fields (kit_log_fields), newest first, last 100. */
function log(el, o) {
	o = Object.assign({ itemLabel: 'Item', columns: [{ key: 'what', label: 'What happened' }, { key: 'detail', label: 'Detail' }, { key: 'who', label: 'Who' }], every: 3000,
		hint: 'Newest at the top; the last 100 lines are kept.' }, o);
	el.classList.add('acap-panel', 'kit-log');
	el.hidden = true;
	if (!el.id) el.id = 'kit-log-' + Math.random().toString(36).slice(2);
	let btn = typeof o.button === 'string' ? $(o.button) : o.button;
	if (!btn) {
		const bar = document.createElement('div');
		bar.className = 'kit-log-bar';
		bar.innerHTML = '<button type="button" class="btn">Log</button>';
		el.parentNode.insertBefore(bar, el);
		btn = $('button', bar);
	}
	btn.classList.add('k-logbtn');
	btn.setAttribute('aria-controls', el.id);
	function showLog(on) {
		el.hidden = !on;
		btn.textContent = on ? 'Hide log' : 'Log';
		btn.setAttribute('aria-expanded', on ? 'true' : 'false');
		btn.classList.toggle('active', on);
		if (on) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
	btn.onclick = () => showLog(el.hidden);
	showLog(false);
	el.innerHTML = '<div class="log-head"><h2>Log</h2><span class="live k-live">Live</span><span class="hint small">' + esc(o.hint) + '</span>' +
		'<span class="head-r"><button type="button" class="btn subtle k-clearf" disabled>Clear filters</button>' +
		'<button type="button" class="btn k-export">Export</button>' +
		'<button type="button" class="btn subtle danger k-clear">Clear log</button></span></div>' +
		'<div class="log-body"><table class="acap-table kit-stack"><colgroup><col class="c-time"><col class="c-item">' + o.columns.map(() => '<col>').join('') + '</colgroup>' +
		'<thead><tr><th>Time</th><th>' + esc(o.itemLabel) + '</th>' + o.columns.map(c => '<th>' + esc(c.label) + '</th>').join('') + '</tr>' +
		'<tr class="filter-row"><th><input type="text" data-f="t" placeholder="e.g. 14:0" aria-label="Filter by time"></th>' +
		'<th><select data-f="item" aria-label="Filter by ' + esc(o.itemLabel.toLowerCase()) + '"><option value="">All</option></select></th>' +
		o.columns.map(c => '<th><div class="k-filt">' +
			(c.options ? '<select data-f="' + esc(c.key) + ':o" aria-label="Filter ' + esc(c.label.toLowerCase()) + ' by kind"><option value="">All</option>' +
				c.options.map(x => '<option value="' + esc(x.v) + '">' + esc(x.label || x.v) + '</option>').join('') + '</select>' : '') +
			'<input type="text" data-f="' + esc(c.key) + '" placeholder="Contains…" aria-label="Filter by ' + esc(c.label.toLowerCase()) + '"></div></th>').join('') +
		'</tr></thead><tbody></tbody></table></div><button type="button" class="btn jump" hidden>↑ Newest lines</button>';
	const body = $('tbody', el), box = $('.log-body', el), jump = $('.jump', el), live = $('.k-live', el);
	let lines = [], seen = new Set(), first = true, okAt = 0;
	const key = l => JSON.stringify(l);
	const textOf = (c, l) => c.text ? String(c.text(l) || '') : String(l[c.key] == null ? '' : l[c.key]);
	const fv = f => { const x = $('[data-f="' + f + '"]', el); return x ? x.value.trim() : ''; };
	function fillItems() {
		const s = $('[data-f="item"]', el), cur = s.value, names = [];
		lines.forEach(l => { if (l.item && !names.includes(l.item)) names.push(l.item); });
		if (cur && !names.includes(cur)) names.push(cur);
		s.innerHTML = '<option value="">All</option>' + names.map(n => '<option' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
	}
	function draw() {
		fillItems();
		const ft = fv('t'), fi = fv('item');
		const rows = lines.filter(l => (!ft || fmt.time(l.t).includes(ft)) && (!fi || l.item === fi) &&
			o.columns.every(c => {
				const v = fv(c.key).toLowerCase(), opt = c.options ? fv(c.key + ':o') : '';
				const pick = opt && c.options.find(x => x.v === opt);
				return (!v || textOf(c, l).toLowerCase().includes(v)) && (!pick || pick.match(l));
			}));
		const filtered = $$('[data-f]', el).some(x => x.value);
		$$('[data-f]', el).forEach(x => x.classList.toggle('filtered', !!x.value));
		$('.k-clearf', el).disabled = !filtered;
		body.innerHTML = rows.length ? rows.map(l => '<tr' + (!first && !seen.has(key(l)) ? ' class="fresh"' : '') + '><td data-l="Time" class="mono">' + (fmt.date(new Date(l.t * 1000)) === fmt.date() ? '' : fmt.date(new Date(l.t * 1000)).slice(5) + ' ') + fmt.time(l.t) + '</td>' +
			'<td data-l="' + esc(o.itemLabel) + '">' + esc(l.item) + '</td>' +
			o.columns.map(c => '<td data-l="' + esc(c.label) + '">' + (c.cell ? c.cell(l) : (l[c.key] ? esc(l[c.key]) : '<span class="hint">–</span>')) + '</td>').join('') + '</tr>').join('')
			: '<tr><td colspan="' + (2 + o.columns.length) + '" class="hint">' + esc(lines.length ? 'No lines match the filters.' : (o.empty || 'Nothing logged yet.')) + '</td></tr>';
		lines.forEach(l => seen.add(key(l)));
		first = false;
	}
	async function refresh() {
		try {
			lines = (await get('log')).lines || [];
			okAt = Date.now();
			if (o.onLines) { try { o.onLines(lines); } catch (e) { console.error(e); } }
			draw();
		}
		finally { drawLive(); }
	}
	function drawLive() {
		const lost = okAt && Date.now() - okAt > o.every * 3;
		live.className = 'live k-live' + (document.hidden ? ' paused' : lost ? ' lost' : '');
		live.textContent = document.hidden ? 'Paused' : lost ? 'No answer' : 'Live';
	}
	$$('[data-f]', el).forEach(x => { x.oninput = draw; x.onchange = draw; });
	$('.k-clearf', el).onclick = () => { $$('[data-f]', el).forEach(x => { x.value = ''; }); draw(); };
	$('.k-export', el).onclick = () => {
		const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
		const head = ['Time', o.itemLabel].concat(o.columns.map(c => c.label)).map(q).join(',');
		download(fileBase('log') + '.csv', '﻿' + [head].concat(lines.slice().reverse().map(l => [new Date(l.t * 1000).toISOString(), l.item].concat(o.columns.map(c => textOf(c, l))).map(q).join(','))).join('\r\n'), 'text/csv');
	};
	$('.k-clear', el).onclick = async () => {
		if (!await ask({ title: 'Clear the log?', text: 'Every line is removed from the camera. This can\'t be undone.', ok: 'Clear log', logged: true })) return;
		try { lines = (await post('log', { action: 'clear' })).lines || []; draw(); toast('Log cleared.'); }
		catch (e) { toast('Could not clear the log: ' + e.message, 'bad'); }
	};
	box.addEventListener('scroll', () => { jump.hidden = box.scrollTop < 80; });
	jump.onclick = () => { box.scrollTop = 0; };
	const poller = every(o.every, refresh);
	return {
		refresh: () => poller.now(),
		lines: () => lines,
		show: () => showLog(true),
		hide: () => showLog(false),
		toggle: () => showLog(el.hidden),
		shown: () => !el.hidden,
		filterTo(name) {
			$$('[data-f]', el).forEach(x => { x.value = ''; });
			fillItems();
			$('[data-f="item"]', el).value = name;
			draw();
			box.scrollTop = 0;
			showLog(true);
		}
	};
}

/*---------------------------------------------------- 1.2.0 Help (i): a short explanation one click away
 * In the page:  <h2>Alerts</h2><span class="kit-help" data-title="Alerts">An alert is ...</span>
 * The kit turns each .kit-help into a small round (i); its text opens in a popover on click (or Enter / Space).
 * Esc, the x or a click elsewhere closes it; one is open at a time; it stays inside the window. No hover popups.
 * For rows a page draws itself: Kit.help(element, 'Title', 'Text') adds an (i) at the end of element, or
 * Kit.helpScan(root) after putting .kit-help spans in. A line break in the text starts a new paragraph. */
const Help = (() => {
	let pop = null, cur = null;
	function close() {
		if (!pop || pop.hidden) return;
		pop.hidden = true;
		if (cur) { cur.classList.remove('open'); cur.setAttribute('aria-expanded', 'false'); }
		cur = null;
	}
	function place(btn) {
		const r = btn.getBoundingClientRect(), w = Math.min(340, innerWidth - 16);
		pop.style.width = w + 'px';
		const left = Math.max(8, Math.min(r.left - 18, innerWidth - w - 8));
		let top = r.bottom + 9, up = false;
		pop.style.left = left + 'px'; pop.style.top = top + 'px';
		if (top + pop.offsetHeight > innerHeight - 8 && r.top - pop.offsetHeight - 9 > 8) { top = r.top - pop.offsetHeight - 9; up = true; }
		pop.style.top = top + 'px';
		pop.classList.toggle('up', up);
		pop.style.setProperty('--ax', Math.max(10, Math.min(w - 22, r.left + r.width / 2 - left - 6)) + 'px');
	}
	function open(btn) {
		if (cur === btn) { close(); return; }
		close();
		if (!pop) {
			pop = document.createElement('div');
			pop.className = 'kit-pop'; pop.setAttribute('role', 'dialog'); pop.hidden = true;
			document.body.appendChild(pop);
			pop.addEventListener('click', e => { if (e.target.closest('.kit-pop-x')) { const b = cur; close(); if (b) b.focus(); } });
		}
		const title = btn.dataset.helpTitle || 'Help';
		pop.setAttribute('aria-label', title);
		pop.innerHTML = '<div class="kit-pop-t"><b>' + esc(title) + '</b><button type="button" class="kit-pop-x" aria-label="Close">×</button></div>' +
			String(btn.dataset.help || '').split('\n').map(p => '<p>' + esc(p) + '</p>').join('');
		pop.hidden = false;
		place(btn);
		cur = btn;
		btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
	}
	function make(title, text) {
		const b = document.createElement('button');
		b.type = 'button'; b.className = 'kit-info'; b.textContent = 'i';
		b.dataset.helpTitle = title; b.dataset.help = text;
		b.setAttribute('aria-label', 'Help: ' + title); b.setAttribute('aria-expanded', 'false');
		return b;
	}
	/* After el (a heading, a setting's name): add an (i) with this text */
	function add(el, title, text) { if (el && text) el.appendChild(make(title, text)); }
	function scan(root) {
		$$('span.kit-help', root || document).forEach(s => {
			const prev = s.previousElementSibling;
			const title = s.dataset.title || (prev ? prev.textContent.trim() : 'Help');
			s.replaceWith(make(title, s.textContent.replace(/[ \t]+/g, ' ').trim()));
		});
	}
	document.addEventListener('click', e => {
		const b = e.target.closest('.kit-info, [data-help]');
		if (b) { e.preventDefault(); e.stopPropagation(); open(b); return; }
		if (pop && !pop.hidden && !e.target.closest('.kit-pop')) close();
	}, true);
	escOrder.help = () => { if (!pop || pop.hidden) return false; const b = cur; close(); if (b) b.focus(); return true; };   /* Esc: see the dialog handler */
	addEventListener('resize', close);
	addEventListener('scroll', e => { if (pop && !pop.hidden && !(e.target instanceof Node && pop.contains(e.target))) close(); }, true);
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan(document)); else scan(document);
	return { add, scan, close };
})();

/*---------------------------------------------------- 1.3.0 Copy settings to other cameras (configio)
 * In the Settings tab:  <section id="copy"></section>   and   Kit.configio($('#copy'), { onDone: load })
 * -> { refresh() }. Draws one panel: Export (tick sections, each with its count; Download; what is left out),
 * Import (choose a file -> a dialog with the file's app, version, model and date; tick sections; Replace or
 * Merge; Preview = a dry run on the camera; Apply) and Undo last import (only when there is one).
 * The camera side is kit_configio.c: the app adds its sections with kit_configio_section() (kit.h).
 * onDone runs after an import or undo changed the camera, so the page reads its settings again;
 * call refresh() after the page saves, so the counts follow. */
const CFG_MAX = 256 * 1024;
async function cfgPost(url, body) {
	const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body });
	let a = null;
	try { a = await r.json(); } catch (e) { /* not JSON */ }
	if (!a) throw new Error(r.status + ' ' + r.statusText);
	return a;   /* {ok:false, error} is an answer, not a throw */
}
function configio(el, o) {
	o = Object.assign({ url: 'configio' }, o);
	const name = () => K.opts.name || 'this app';
	el.classList.add('acap-panel', 'kit-cfg');
	el.innerHTML = '<div class="acap-panel-head"><div class="head-l"><h2>Copy settings to other cameras</h2></div></div>' +
		'<div class="cfg-row"><h4>Export</h4><div class="cfg-body"><div class="cfg-ticks k-ticks"></div><p class="hint small k-left"></p></div>' +
		'<div class="cfg-act"><button type="button" class="btn k-dl">Download</button></div></div>' +
		'<div class="cfg-row"><h4>Import</h4><div class="cfg-body"><p class="hint small k-from"></p></div>' +
		'<div class="cfg-act"><button type="button" class="btn k-pick">Choose file…</button></div></div>' +
		'<div class="cfg-row k-undo" hidden><h4>Undo</h4><div class="cfg-body"><p class="k-undo-t"></p></div>' +
		'<div class="cfg-act"><button type="button" class="btn k-undo-b">Undo last import</button></div></div>';
	Help.add($('.head-l', el), 'Copy settings to other cameras',
		'Export saves the ticked sections to a file. Import loads that file on another camera: Replace makes each ticked section exactly the file\'s; Merge adds the file\'s items and changes those with the same name, and removes nothing.\n' +
		'Preview shows what would change; nothing is saved until Apply.\n' +
		'Passwords and other secrets are never in the file: the other camera keeps its own. The camera\'s name, address, logs and history are never in the file either.\n' +
		'Undo last import puts back the sections as they were before the last import.');
	let S = null;   /* the camera's answer to action=sections */
	const secName = id => { const s = S && S.sections.find(x => x.id === id); return s ? s.name : id; };

	async function refresh() {
		try { S = await get(o.url + '?action=sections'); }
		catch (e) { $('.k-ticks', el).innerHTML = '<span class="hint">Could not read the sections: ' + esc(e.message) + '</span>'; return; }
		const list = S.sections || [];
		const was = $$('.k-ticks input', el).reduce((m, i) => (m[i.value] = i.checked, m), {});
		$('.k-ticks', el).innerHTML = list.length ? list.map(s => '<label class="cfg-tick"><input type="checkbox" value="' + esc(s.id) + '"' + (was[s.id] === false ? '' : ' checked') + '>' +
			esc(s.name) + (s.list ? ' <span class="n">' + esc(s.count) + '</span>' : '') + '</label>').join('') : '<span class="hint">' + esc(name()) + ' has no settings to copy.</span>';
		$('.k-left', el).textContent = list.some(s => s.secrets && s.secrets.length) ? 'Passwords are never in the file; the other camera keeps its own.' :
			'The camera\'s name, address and logs are never in the file.';
		$('.k-from', el).textContent = 'A file exported from ' + name() + ', on this or another camera.';
		$('.k-pick', el).disabled = !list.length;
		ticked();
		const u = S.undo || {};
		$('.k-undo', el).hidden = !u.available;
		if (u.available) {
			const t = u.time ? new Date(u.time) : null;
			$('.k-undo-t', el).textContent = 'Last import: ' + (t && !isNaN(t) ? t.toLocaleString() : 'time unknown') + ', ' + (u.mode === 'merge' ? 'Merge' : 'Replace') +
				', ' + (u.sections || []).map(secName).join(', ') + '.';
		}
	}
	function ticked() { $('.k-dl', el).disabled = !$$('.k-ticks input:checked', el).length; }
	el.addEventListener('change', e => { if (e.target.closest('.k-ticks')) ticked(); });

	$('.k-dl', el).onclick = async () => {
		const ids = $$('.k-ticks input:checked', el).map(i => i.value);
		try {
			const f = await get(o.url + '?action=export&sections=' + encodeURIComponent(ids.join(',')));
			const model = String(f.fromModel || 'camera').replace(/[^A-Za-z0-9-]+/g, '-');
			download(name().toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-settings-' + model + '-' + fmt.date() + '.json', JSON.stringify(f, null, 2));
			toast(f.omitted && f.omitted.length ? 'Downloaded. Left out: ' + f.omitted.join(', ') + '.' : 'Downloaded.', 'ok');
		} catch (e) { toast('Could not export: ' + e.message, 'bad'); }
	};

	$('.k-pick', el).onclick = () => {
		const i = document.createElement('input');
		i.type = 'file'; i.accept = '.json,application/json';
		i.onchange = async () => {
			const f = i.files[0];
			if (!f || !S) return;
			if (f.size > CFG_MAX) { toast('The file is too big: the limit is 256 KB.', 'bad'); return; }
			const text = await f.text();
			let j = null;
			try { j = JSON.parse(text); } catch (e) { /* shown below */ }
			if (!j || typeof j !== 'object' || Array.isArray(j)) { toast('That is not a settings file: it is not JSON.', 'bad'); return; }
			if (j.app !== S.app) { toast(j.app ? 'This file is for another app (' + String(j.app).slice(0, 40) + '), not ' + name() + '.' : 'That is not a settings file: it does not say which app it is for.', 'bad'); return; }
			if (+j.format > S.format) { toast('This file is from a newer version of ' + name() + ': update the app first.', 'bad'); return; }
			importDialog(j, text);
		};
		i.click();
	};

	/* The import dialog: the file's facts, sections, Replace / Merge, Preview, Apply */
	function importDialog(j, text) {
		const old = !(j.format >= 2);
		const secs = old ? {} : (j.sections && typeof j.sections === 'object' ? j.sections : {});
		if (old) S.sections.forEach(s => { if (s.list && Array.isArray(j[s.id])) secs[s.id] = j[s.id]; });
		const known = S.sections.filter(s => secs[s.id] !== undefined);
		const unknown = Object.keys(secs).filter(k => !S.sections.some(s => s.id === k));
		const when = j.exported ? new Date(j.exported) : null;
		const fact = (k, v) => '<b>' + esc(k) + '</b><span>' + esc(v || '–') + '</span>';
		const d = openDialog('<h3>Import settings</h3>' +
			'<div class="cfg-facts">' + fact('App', j.app + (old ? ' (older export)' : '')) + fact('Version', j.appVersion) + fact('Camera model', j.fromModel) +
			fact('Exported', when && !isNaN(when) ? when.toLocaleString() : '') + '</div>' +
			'<div class="cfg-sec">Sections</div>' +
			(known.length ? '<div class="cfg-ticks k-secs">' + known.map(s => '<label class="cfg-tick"><input type="checkbox" value="' + esc(s.id) + '" checked>' + esc(s.name) +
				(Array.isArray(secs[s.id]) ? ' <span class="n">' + secs[s.id].length + '</span>' : '') + '</label>').join('') + '</div>' : '<p class="cfg-err">The file has none of the sections ' + esc(name()) + ' uses.</p>') +
			(unknown.length ? '<p class="hint small">Not used here: ' + esc(unknown.join(', ')) + '</p>' : '') +
			(Array.isArray(j.omitted) && j.omitted.length ? '<p class="hint small">Not in the file: ' + esc(j.omitted.join(', ')) + '. This camera keeps its own.</p>' : '') +
			'<div class="cfg-sec"><span>Replace or Merge</span></div><div class="seg k-mode"><button data-v="replace" class="on">Replace</button><button data-v="merge">Merge</button></div>' +
			'<div class="cfg-prev" aria-live="polite"></div>' +
			'<div class="dlg-actions"><span class="spacer"></span><button type="button" class="btn k-cancel">Cancel</button>' +
			'<button type="button" class="btn k-prev">Preview</button><button type="button" class="btn primary k-apply" disabled>Apply</button></div>', true);
		const root = d.root, prev = $('.cfg-prev', root);
		Help.add($('.cfg-sec span', root), 'Replace or Merge', 'Replace: each ticked section becomes exactly the file\'s.\nMerge: the file\'s items are added, and items with the same name are changed; nothing is removed. Settings change only where the file has them.\nTwo items with the same name: Replace keeps both; Merge can\'t tell them apart and refuses the file.');
		const mode = seg($('.k-mode', root), () => stale());
		const chosen = () => $$('.k-secs input:checked', root).map(i => i.value);
		/* seq: an answer to an older request (the mode or the ticks changed since) is dropped */
		let busy = false, seq = 0;
		function stale() { seq++; prev.innerHTML = ''; $('.k-apply', root).disabled = true; $('.k-prev', root).disabled = busy || !chosen().length; }
		function lock(on) { $$('.k-mode button, .k-secs input', root).forEach(x => { x.disabled = on; }); }
		root.addEventListener('change', e => { if (e.target.closest('.k-secs')) stale(); });
		stale();
		function show(r) {
			const list = (r.sections || []).map(s => '<li><b>' + esc(s.name) + ':</b> ' + esc(s.added) + ' added, ' + esc(s.changed) + ' changed, ' + esc(s.removed) + ' removed, ' + esc(s.unchanged) + ' unchanged' +
				((s.notes || []).length ? '<ul>' + s.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>' : '') + '</li>').join('');
			prev.innerHTML = (r.ok ? '' : '<p class="cfg-err">' + esc(r.error || 'Refused.') + '</p>') + (list ? '<ul>' + list + '</ul>' : '') +
				((r.notes || []).length ? '<ul class="hint small">' + r.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>' : '');
		}
		/* One request at a time; the mode and ticks are locked meanwhile. null: the answer came too late to count. */
		async function send(dry) {
			const my = ++seq;
			busy = true;
			lock(true);
			$('.k-prev', root).disabled = $('.k-apply', root).disabled = true;
			if (dry) prev.innerHTML = '<p class="hint">Checking on the camera…</p>';
			let r;
			try {
				r = await cfgPost(o.url + '?action=import&mode=' + mode.value() + '&sections=' + encodeURIComponent(chosen().join(',')) + (dry ? '&dry=1' : ''), text);
			} catch (e) { r = { ok: false, error: 'The camera did not answer: ' + e.message + (dry ? '' : '. Check the settings before trying again.') }; }
			finally { busy = false; lock(false); $('.k-prev', root).disabled = !chosen().length; }
			return my === seq ? r : null;
		}
		$('.k-cancel', root).onclick = () => d.close(null);
		$('.k-prev', root).onclick = async () => {
			const r = await send(true);
			if (!r) return;
			show(r);
			$('.k-apply', root).disabled = !r.ok;
			if (r.ok) $('.k-apply', root).focus();
		};
		$('.k-apply', root).onclick = async () => {
			const r = await send(false);
			if (!r) return;
			if (!r.ok) {
				/* Show the camera's own words, and read the panel again: a failed import may have left
				 * an undo copy (the put-back failed too), and the Undo row must show it */
				show(r);
				await refresh();
				if (o.onDone) o.onDone(r);
				return;
			}
			d.close(true);
			toast('Imported: ' + (r.sections || []).map(s => s.name).join(', ') + '. Undo last import puts them back.', 'ok');
			await refresh();
			if (o.onDone) o.onDone(r);
		};
		d.focus();
	}

	$('.k-undo-b', el).onclick = async () => {
		const u = (S && S.undo) || {};
		if (!await ask({ title: 'Undo the last import?', text: (u.sections || []).map(secName).join(', ') + ': back to how they were before the import. Changes made to them since then are lost.', ok: 'Undo import', logged: true })) return;
		try {
			const a = await cfgPost(o.url + '?action=undo', '{}');
			if (!a.ok) throw new Error(a.error || 'Refused.');
			toast('Import undone: ' + (a.sections || []).map(s => s.name).join(', ') + ' put back.', 'ok');
			await refresh();
			if (o.onDone) o.onDone(a);
		} catch (e) { toast('Could not undo: ' + e.message, 'bad'); refresh(); }
	};

	refresh();
	return { refresh };
}

/* 1.3.0 colours: a kit colour token's value under the current theme, for drawing on a canvas:
 * Kit.color('--kit-c-apps'). Read it again in Kit.theme.onChange, since the value differs per theme. */
function color(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/*---------------------------------------------------- 1.4.0 Light and dark: the page follows the camera's theme
 * No switch of its own. The theme is, in this order: the camera's saved "theme" in browser storage ("dark" or
 * "light", plain or JSON-quoted; the camera's web page and this page are the same site), else "?theme=light" or
 * "?theme=dark" in the address, else the computer's light or dark setting. It is set as data-theme on <html>;
 * kit/acap-theme.js (first in <head>, the same rule) sets it before the first paint, so nothing flashes.
 * It follows changes live: the camera's page saving another theme (the storage event, from another tab of the
 * camera) and the computer's setting. acap-kit.css holds every colour as a token for each theme.
 *   Kit.theme.current()     'light' or 'dark'
 *   Kit.theme.source()      'camera', 'address' or 'computer': where the theme came from
 *   Kit.theme.onChange(fn)  fn(theme, source, changed) after the theme or where it comes from changes, once the
 *                           new colours apply. changed is true when the theme itself changed: redraw canvases only
 *                           then, reading colours with Kit.color(). Returns a function that removes fn.
 *   Kit.theme.refresh()     read it again now
 * kit/compressing-graph.js follows on its own. */
const Theme = (() => {
	const cbs = [];
	let cur = null, from = null;
	const ok = v => v === 'light' || v === 'dark';
	const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
	function read() {
		try {
			let v = localStorage.getItem('theme');
			try { v = JSON.parse(v); } catch (e) { /* a plain word */ }
			if (ok(v)) return { theme: v, from: 'camera' };
		} catch (e) { /* no storage */ }
		try { const q = new URLSearchParams(location.search).get('theme'); if (ok(q)) return { theme: q, from: 'address' }; } catch (e) { /* no address */ }
		return { theme: mq && mq.matches ? 'light' : 'dark', from: 'computer' };
	}
	function apply() {
		const r = read(), was = cur, wasFrom = from;
		from = r.from;
		cur = r.theme;
		/* data-theme (and so the graphs, which watch it) changes only when the theme does */
		if (document.documentElement.getAttribute('data-theme') !== cur) document.documentElement.setAttribute('data-theme', cur);
		if (!was || (was === cur && wasFrom === from)) return;
		const changed = was !== cur;
		cbs.slice().forEach(fn => { try { fn(cur, from, changed); } catch (e) { console.error(e); } });
	}
	addEventListener('storage', e => { if (e.key === 'theme' || e.key === null) apply(); });
	addEventListener('pageshow', apply);
	if (mq) { if (mq.addEventListener) mq.addEventListener('change', apply); else if (mq.addListener) mq.addListener(apply); }
	apply();
	return {
		current: () => cur,
		source: () => from,
		onChange(fn) { cbs.push(fn); return () => { const i = cbs.indexOf(fn); if (i >= 0) cbs.splice(i, 1); }; },
		refresh: apply
	};
})();

window.Kit = { version: VERSION, start, showTab, items, footer, log, ask, editor, modal, toast, seg, exportJSON, importJSON, get, post, every, apps, app, onApps, fmt, esc, $, $$, device: () => K.device, resources: () => K.res,
	help: Help.add, helpScan: Help.scan, helpClose: Help.close, configio, color, theme: Theme, dock };
})();
