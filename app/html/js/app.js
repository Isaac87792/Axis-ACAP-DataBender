/*
 * app.js - the Data Bender settings page.
 * Settings: { rules: [{ id, enabled, name, object, send, source, portTesting? }] }
 *   portTesting (1.6.0): { on, camera, game: pong|battleship|check, minutes, speed, encrypt, proto, port },
 *   the rule popup's "Also do" (main.c pt_fire). Rules without it load and save unchanged.
 * Two tabs: Rules, and Settings with the UI kit's "Copy settings to other cameras" panel (Kit.configio).
 * The header, resource bar, camera facts, rules table, Save / Cancel, log, toasts and dialog
 * behaviour are the ACAP UI kit's (kit/acap-kit.js, window.Kit); this file has only Data Bender's own parts.
 */
(function () {
	'use strict';

	var MAX_RULES = 32;
	var TEST_MS = 3000;
	var settings = { rules: [] };
	var savedIds = {};          // rule ids the camera knows (saved)
	var events = [];
	var eventsLoaded = false;
	var status = {};
	var dirty = false;
	var stale = false;          // the camera's rules could not be read (at start, after an import, or on Cancel): no Save until they are
	var staleTold = false;      // the toast about it was shown once
	var retryTimer = null;      // the next try to read them
	var table = null, foot = null, log = null, copy = null;    // the kit's rules table, Save / Cancel, log and copy panel
	var ruleModal = null, ctxModal = null;                    // the page's own dialogs, with the kit's behaviour

	function $(id) { return document.getElementById(id); }

	function el(tag, attrs, text) {
		var e = document.createElement(tag);
		if (attrs) Object.keys(attrs).forEach(function (k) {
			if (k === 'className') e.className = attrs[k];
			else e.setAttribute(k, attrs[k]);
		});
		if (text !== undefined) e.textContent = text;
		return e;
	}

	function toast(message, kind) {
		Kit.toast(message, kind === 'bad' || kind === 'error' ? 'bad' : kind === 'ok' ? 'ok' : 'info');
	}

	function setDirty(value) {
		dirty = value;
		if (foot) foot.dirty(value);
		renderStatus(true);
	}

	function newId() {
		return 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
	}

	/* The name sent for a rule name */
	function fullName(name) {
		return name;
	}

	function clock(iso) {
		// "2025-01-31T08:58:54+0000" -> "08:58:54"
		return iso && iso.length >= 19 ? iso.slice(11, 19) : '';
	}

	function topicValue(source, n) {
		var t = source && source['topic' + n];
		return t ? Object.values(t)[0] : '';
	}

	function suggestedName(rule) {
		var o = (rule.object || '').toLowerCase();
		if (o === 'human') return 'Person Detected';
		if (o === 'car' || o === 'truck' || o === 'bus') return 'Vehicle Detected';
		if (o === 'bike') return 'Bike Detected';
		var label = rule.source ? rule.source.name || '' : '';
		if (/person|human/i.test(label)) return 'Person Detected';
		if (/vehicle|car|truck/i.test(label)) return 'Vehicle Detected';
		return '';
	}

	/*--------------------------------------------------
	 * What a source offers: its On/Off field and what it can be filtered on
	 *--------------------------------------------------*/
	var aoaClasses = {};   // "Device1Scenario1" -> ["human"], "Device1ScenarioANY" -> all classes on device 1

	function loadAoaClasses() {
		return post('/local/objectanalytics/control.cgi', JSON.stringify({ apiVersion: '1.6', method: 'getConfiguration' }))
			.then(function (text) {
				var cfg = JSON.parse(text).data || {};
				var byDevice = {};
				(cfg.scenarios || []).forEach(function (s) {
					var classes = (s.objectClassifications || []).map(function (c) { return c.type; }).filter(Boolean);
					(s.devices || []).forEach(function (d) {
						aoaClasses['Device' + d.id + 'Scenario' + s.id] = classes;
						byDevice[d.id] = (byDevice[d.id] || []).concat(classes);
					});
				});
				Object.keys(byDevice).forEach(function (d) {
					aoaClasses['Device' + d + 'ScenarioANY'] = byDevice[d].filter(function (c, i, a) { return a.indexOf(c) === i; });
				});
			})
			.catch(function () { /* not an AOA camera, or no access: filters fall back to a short list */ });
	}

	function eventFor(source) {
		var p = sourcePath(source);
		return source ? events.find(function (e) { return e.path === p; }) : null;
	}

	/* The source as saved in a rule: its topics, plus its On/Off field and instance fields for the relay */
	function sourceFromEvent(e) {
		var src = { name: e.name };
		Object.keys(e).forEach(function (k) { if (/^topic\d$/.test(k)) src[k] = e[k]; });
		var m = e.meta || {};
		src.stateful = !!m.stateful;
		src.stateKey = m.stateKey || '';
		src.sourceKeys = (m.sources || []).map(function (s) { return s.key; });
		return src;
	}

	/* What the Filter column offers for a source: null (nothing to filter), or
	 * { key, match, label, options: [value...] } */
	function filterFor(source) {
		var e = eventFor(source);
		if (!e || !e.meta) return null;
		if (e.meta.data.indexOf('classTypes') >= 0) {
			var t2 = topicValue(source, 2);
			var classes = aoaClasses[t2] || ['human', 'car', 'truck', 'bus', 'bike'];
			return { key: 'classTypes', match: 'contains', label: 'Object', options: classes };
		}
		var s = e.meta.sources.find(function (x) { return x.values.length > 1; });
		if (s) return { key: s.key, match: 'equals', label: s.nice, options: s.values };
		return null;
	}

	/* A rule's current filter, also from the older "object" field */
	function ruleFilter(rule) {
		if (rule.filter && rule.filter.key) return rule.filter;
		if (rule.object) return { key: 'classTypes', value: rule.object, match: 'contains' };
		return null;
	}

	function renderFilter(td, rule) {
		td.textContent = '';
		var f = filterFor(rule.source);
		var current = ruleFilter(rule);
		if (!f) {
			td.appendChild(el('span', { className: 'hint' }, '—'));
			Kit.help(td, 'Filter', 'This source has nothing to filter on.');
			return;
		}
		if (f.match === 'contains' && f.options.length === 1) {
			td.appendChild(el('span', { className: 'hint' }, f.options[0]));
			Kit.help(td, 'Filter', 'This scenario only detects ' + f.options[0] + '.');
			return;
		}
		var sel = el('select', { 'aria-label': f.label });
		sel.appendChild(el('option', { value: '' }, 'Any'));
		f.options.forEach(function (o) { sel.appendChild(el('option', { value: o }, f.match === 'equals' ? f.label + ' ' + o : o)); });
		sel.value = current && current.key === f.key ? current.value : '';
		sel.addEventListener('change', function () {
			rule.object = '';
			rule.filter = sel.value ? { key: f.key, value: sel.value, match: f.match } : null;
			setDirty(true);
		});
		td.appendChild(sel);
	}

	/*--------------------------------------------------
	 * Condition: when the rule fires, in the source's own words
	 *--------------------------------------------------*/
	function hasState(e) {
		return !!(e && e.meta && (e.meta.stateful || e.meta.stateKey));
	}

	/* The word for a source's On/Off field: the camera's own name for it if it gives one
	 * (Heater: "Running"), else a plain word (Object Analytics: "Detected", inputs: "Active") */
	function conditionWord(source, e) {
		var m = (e && e.meta) || {};
		if (m.stateNice) return m.stateNice;
		if (topicValue(source, 1) === 'ObjectAnalytics') return 'Detected';
		var k = m.stateKey || (source && source.stateKey) || 'State';
		return k.charAt(0).toUpperCase() + k.slice(1);
	}

	function renderCondition(td, rule) {
		td.textContent = '';
		if (!rule.source) { td.appendChild(el('span', { className: 'hint' }, '—')); return; }
		var e = eventFor(rule.source);
		if (e && !hasState(e)) {
			rule.send = 'on';
			td.appendChild(el('span', { className: 'hint' }, 'Triggered'));
			Kit.help(td, 'Condition', 'This source has no On/Off state: the rule fires once per event.');
			return;
		}
		var w = conditionWord(rule.source, e);
		var sel = el('select', { 'aria-label': 'Condition' });
		[['on', w + ': On'], ['off', w + ': Off'], ['both', w + ': On and Off']].forEach(function (o) {
			sel.appendChild(el('option', { value: o[0] }, o[1]));
		});
		sel.value = (rule.send === 'on' || rule.send === 'off') ? rule.send : 'both';
		sel.addEventListener('change', function () { rule.send = sel.value; setDirty(true); });
		td.appendChild(sel);
		Kit.help(td, 'Condition', w + ': On fires once each time it turns on.\n' + w + ': Off fires once each time it turns off.\n' + w + ': On and Off follows the source: On, then Off.');
	}

	/*--------------------------------------------------
	 * Source picker: search box with a list of events
	 *--------------------------------------------------*/
	function sourcePicker(rule, onPick) {
		var wrap = el('div', { className: 'picker' });
		var input = el('input', { type: 'text', placeholder: 'Search events…', autocomplete: 'off', 'aria-label': 'Source event name' });
		var list = el('div', { className: 'picker-list', role: 'listbox' });
		var chosen = el('div', { className: 'chosen' });
		list.hidden = true;

		function showChosen() {
			if (!rule.source) { input.value = ''; chosen.textContent = ''; return; }
			var match = events.find(function (e) { return e.path === sourcePath(rule.source); });
			input.value = match ? match.name : (rule.source.name || sourcePath(rule.source));
			chosen.textContent = match ? match.label : sourcePath(rule.source);   /* the full path, shown under the box (no hover tips) */
		}

		function fill() {
			list.textContent = '';
			if (!eventsLoaded) { list.appendChild(el('div', { className: 'none' }, 'Loading events…')); return; }
			var q = input.value.trim().toLowerCase();
			var shown = events.filter(function (e) { return !q || e.label.toLowerCase().indexOf(q) >= 0; }).slice(0, 200);
			if (!shown.length) { list.appendChild(el('div', { className: 'none' }, 'No matching events')); return; }
			shown.forEach(function (e) {
				var item = el('div', { role: 'option' });
				item.appendChild(el('div', null, e.name));
				item.appendChild(el('div', { className: 'group' }, e.label));
				item.addEventListener('mousedown', function (ev) {
					ev.preventDefault();
					onPick(sourceFromEvent(e));
					list.hidden = true;
					input.blur();
					showChosen();
				});
				list.appendChild(item);
			});
		}

		/* The list drops to just above the bottom of the window and scrolls inside */
		function place() {
			var r = input.getBoundingClientRect();
			list.style.left = r.left + 'px';
			list.style.top = (r.bottom + 2) + 'px';
			list.style.width = Math.max(r.width, 320) + 'px';
			list.style.maxHeight = Math.max(window.innerHeight - r.bottom - 12, 120) + 'px';
		}
		function onMove() { if (!list.hidden) place(); }

		input.addEventListener('focus', function () {
			input.select(); fill(); list.hidden = false; place();
			window.addEventListener('scroll', onMove, true);
			window.addEventListener('resize', onMove);
		});
		input.addEventListener('input', fill);
		input.addEventListener('blur', function () {
			list.hidden = true; showChosen();
			window.removeEventListener('scroll', onMove, true);
			window.removeEventListener('resize', onMove);
		});
		input.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') input.blur(); });

		wrap.appendChild(input);
		wrap.appendChild(chosen);
		wrap.appendChild(list);
		wrap.refresh = showChosen;
		showChosen();
		return wrap;
	}

	/*--------------------------------------------------
	 * Test: trigger the real source where the camera allows it
	 *--------------------------------------------------*/
	function post(url, body, type) {
		return fetch(url, { method: 'POST', headers: { 'Content-Type': type || 'application/json' }, body: body })
			.then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
	}

	/* Test: Data Bender sends this rule's own event out, as the rule would. The source app is not triggered. */
	function testRule(rule) {
		if (!savedIds[rule.id]) { toast('Save the rule first, then test it.', 'bad'); return; }
		if (rule.enabled === false) { toast('Enable the rule to test it.', 'bad'); return; }
		var what = rule.send === 'on' ? 'one trigger' : rule.send === 'off' ? 'one Off trigger' : 'On, then Off after 3 seconds';
		post('test', JSON.stringify({ id: rule.id }))
			.then(function () { toast('Sent "' + fullName((rule.name || '').trim()) + '": ' + what + '.', 'ok'); })
			.catch(function (e) { toast('Test failed: ' + e.message, 'bad'); });
		setTimeout(function () { log.refresh(); }, 600);
		setTimeout(refreshStatus, 600);
	}

	/*--------------------------------------------------
	 * Rules table: one short line per rule; everything else is in the rule popup
	 *--------------------------------------------------*/
	var pickers = [];   // source pickers on screen, refreshed when the event list arrives

	function waitText(sec) {
		if (!sec) return 'None';
		if (sec % 86400 === 0) return (sec / 86400) + ' d';
		if (sec % 3600 === 0) return (sec / 3600) + ' h';
		if (sec % 60 === 0) return (sec / 60) + ' min';
		return sec + ' s';
	}

	function dwellOf(rule) { var d = Number(rule.dwell) || 0; return d >= 1 ? Math.round(d) : 0; }

	function reOf(rule) {
		var r = rule.reactivation || {};
		return { wait: Number(r.wait) || 0, from: r.from === 'off' ? 'off' : 'sent', held: r.held === 'send' ? 'send' : 'drop' };
	}

	/* "Object Analytics: Person · human · Detected: On · Context: …" */
	function ruleSummary(rule) {
		if (!rule.source) return 'No source event yet';
		var e = eventFor(rule.source);
		var parts = [e ? e.name : (rule.source.name || sourcePath(rule.source))];
		var f = ruleFilter(rule);
		if (f) parts.push(f.match === 'equals' ? ((filterFor(rule.source) || {}).label || f.key) + ' ' + f.value : f.value);
		if (e && !hasState(e)) parts.push('Triggered');
		else { var w = conditionWord(rule.source, e); parts.push(w + ': ' + (rule.send === 'on' ? 'On' : rule.send === 'off' ? 'Off' : 'On and Off') + (dwellOf(rule) ? ' for ' + waitText(dwellOf(rule)) : '')); }
		var c = ctxOf(rule);
		if (c.text) parts.push('Context: ' + c.text);
		return parts.join(' · ');
	}

	/* The rules table is the kit's item table (Kit.items, set up at start). Status and source
	 * lights change every few seconds, so render() redraws only when something shown changed. */
	var lastDrawn = '';
	function render(force) {
		$('add-rule').disabled = settings.rules.length >= MAX_RULES;
		if (!table) return;
		var shown = JSON.stringify(settings.rules.map(function (r) {
			return [r.enabled !== false, r.name, ruleSummary(r), reOf(r).wait, statusOf(r), sourceOf(r)];
		}));
		if (force || shown !== lastDrawn) {
			lastDrawn = shown;
			table.render(settings.rules.map(function (r) { return { id: r.id, enabled: r.enabled !== false, name: (r.name || '').trim() ? fullName(r.name.trim()) : '(no name)', rule: r }; }));
		}
		renderWorkflow();
	}

	function deleteRule(index) {
		var rule = settings.rules[index];
		if (!rule) return;
		settings.rules.splice(index, 1);
		setDirty(true);
		render();
	}

	/*--------------------------------------------------
	 * Rule popup: every setting of one rule, and what the rule will do
	 *--------------------------------------------------*/
	var ruleIndex = -1, draft = null, draftIsNew = false;

	function openRule(index, isNew) {
		ruleIndex = index;
		draftIsNew = !!isNew;
		draft = JSON.parse(JSON.stringify(settings.rules[index]));
		$('rd-title').textContent = 'Rule: ' + ((draft.name || '').trim() || '(new rule)');
		$('rd-enabled').checked = draft.enabled !== false;

		var src = $('rd-source');
		src.textContent = '';
		var picker = sourcePicker(draft, function (s) {
			draft.source = s;
			draft.object = '';
			draft.filter = null;
			draft.send = 'on';
			if (!(draft.name || '').trim()) { draft.name = suggestedName(draft); $('rd-name').value = draft.name; }
			renderRuleParts();
		});
		src.appendChild(picker);
		pickers.push(picker);

		$('rd-name').value = draft.name || '';
		var re = reOf(draft);
		var unit = re.wait && re.wait % 3600 === 0 ? 3600 : re.wait && re.wait % 60 === 0 ? 60 : 1;
		$('rd-wait').value = re.wait / unit;
		$('rd-unit').value = String(unit);
		$('rd-from').value = re.from;
		$('rd-held').value = re.held;
		var dw = dwellOf(draft);
		var dunit = dw && dw % 86400 === 0 ? 86400 : dw && dw % 3600 === 0 ? 3600 : dw && dw % 60 === 0 ? 60 : 1;
		$('rd-dwell').value = dw / dunit;
		$('rd-dwell-unit').value = String(dunit);
		ptFill();   /* before renderRuleParts, which reads the dialog back into the draft */
		ptLoad();
		renderRuleParts();
		ruleModal.open(isNew ? picker.querySelector('input') : $('rd-name'));
	}

	/* Filter, Condition, Context line and the description: they depend on the source */
	function renderRuleParts() {
		renderFilter($('rd-filter'), draft);
		renderCondition($('rd-cond'), draft);
		var c = ctxOf(draft);
		$('rd-ctx-text').textContent = c.text || 'None';
		$('rd-ctx-text').classList.toggle('hint', !c.text);
		$('rd-sent-as').textContent = 'Sent as: Data Bender › ' + ((draft.name || '').trim() || '…');
		updateHow();
	}

	function readReactivation() {
		var n = parseFloat($('rd-wait').value);
		var wait = isFinite(n) && n > 0 ? Math.round(n * Number($('rd-unit').value)) : 0;
		return { wait: Math.min(wait, 86400), from: $('rd-from').value, held: $('rd-held').value };
	}

	function readDialog() {
		draft.enabled = $('rd-enabled').checked;
		draft.name = $('rd-name').value;
		draft.reactivation = readReactivation();
		var stateless = draft.source && eventFor(draft.source) && !hasState(eventFor(draft.source));
		var dn = parseFloat($('rd-dwell').value);
		draft.dwell = !stateless && isFinite(dn) && dn > 0 ? Math.min(Math.round(dn * Number($('rd-dwell-unit').value)), 2592000) : 0;
		$('rd-dwell').disabled = $('rd-dwell-unit').disabled = !!stateless;
		var disable = !draft.reactivation.wait;
		['rd-from', 'rd-held'].forEach(function (id) { $(id).disabled = disable; });
		readPt();
	}

	/*--------------------------------------------------
	 * Also do: Port Testing (1.6.0). Each time the rule fires, Data Bender asks the Port Testing app on this
	 * camera to start a match or a port check (main.c pt_fire); the log shows the result. The devices come
	 * from Data Bender's porttesting endpoint (Port Testing's metrics). Without Port Testing the row says so
	 * and nothing else, and a rule that has the setting keeps it as it is.
	 *--------------------------------------------------*/
	var PT_APP = 'port_testing';
	var PT_GAMES = ['pong', 'battleship', 'check'];
	var ptList = null;        // { installed, status, devices: [{ name, state }], error? }
	var ptInstSeen = null;    // the last install state drawn, to redraw when it changes

	/* 'yes', 'no', or 'loading' while the camera's app list is not read yet */
	function ptInstalled() { return apps === null ? 'loading' : Kit.app(PT_APP) ? 'yes' : 'no'; }

	function ptOf(rule) {
		var p = (rule && rule.portTesting) || {};
		var m = Math.round(Number(p.minutes)), port = Math.round(Number(p.port));
		return { on: p.on === true, camera: typeof p.camera === 'string' ? p.camera.trim() : '',
		         game: PT_GAMES.indexOf(p.game) >= 0 ? p.game : 'pong',
		         minutes: m >= 1 && m <= 15 ? m : 2,
		         speed: p.speed === 'fast' || p.speed === 'slow' ? p.speed : 'normal',
		         encrypt: p.encrypt === true, proto: p.proto === 'udp' ? 'udp' : 'tcp',
		         port: port >= 1 && port <= 65535 ? port : 0 };
	}

	function ptWhat(p) {
		return p.game === 'check' ? 'port check (' + p.proto.toUpperCase() + ' ' + (p.port || '?') + ')' : p.game === 'battleship' ? 'Battleship' : 'Pong';
	}

	/* The "How this rule works" paragraph, or null */
	function ptHow(r) {
		var p = ptOf(r);
		if (!p.on) return null;
		if (ptInstalled() === 'no') return ['Port Testing is not installed, so the ', { b: ptWhat(p) }, ' saved with this rule does nothing until it is.'];
		if (!p.camera) return ['Pick the device Port Testing should ' + (p.game === 'check' ? 'check' : 'play with') + '.'];
		if (p.game === 'check') return ['Each time it fires, Data Bender also asks Port Testing to run a ', { b: ptWhat(p) }, ' with ', { b: p.camera }, '. The log shows the result.'];
		return ['Each time it fires, Data Bender also asks Port Testing to play ', { b: ptWhat(p) }, ' with ', { b: p.camera }, ' for ',
		        { b: p.minutes + ' minute' + (p.minutes === 1 ? '' : 's') }, '. If a match is already playing, it doesn\'t start a second one, and the log says so.'];
	}

	function ptGame() { var b = document.querySelector('#rd-pt-game button.on'); return b ? b.dataset.v : 'pong'; }
	function ptGameSet(g) {
		document.querySelectorAll('#rd-pt-game button').forEach(function (b) {
			b.classList.toggle('on', b.dataset.v === g);
			b.setAttribute('aria-pressed', String(b.dataset.v === g));
		});
	}

	/* Not installed: only "Port Testing not installed". Switched on: the rows the chosen game uses. */
	function ptShow() {
		var none = ptInstalled() === 'no';
		ptInstSeen = ptInstalled();
		$('rd-pt-wrap').hidden = none;
		$('rd-pt-na').hidden = !none;
		var on = !none && $('rd-pt').checked, g = ptGame();
		document.querySelectorAll('#rule-overlay [data-pt]').forEach(function (e) {
			var k = e.getAttribute('data-pt');
			e.hidden = !on || (k === 'match' ? g === 'check' : k !== 'on' && k !== g);
		});
	}

	/* The Device list: Port Testing's devices, and the rule's own device if Port Testing doesn't list it */
	function ptDevices(current) {
		var sel = $('rd-pt-dev'), note = $('rd-pt-devnote');
		var names = ptList && Array.isArray(ptList.devices) ? ptList.devices.map(function (d) { return d.name; }) : [];
		sel.textContent = '';
		names.forEach(function (n) { sel.appendChild(el('option', { value: n }, n)); });
		var listed = ptList && ptList.installed && ptList.status === 'Running' && !ptList.error;
		if (current && names.indexOf(current) < 0) sel.appendChild(el('option', { value: current }, current + (listed ? ' (not on Port Testing\'s list)' : '')));
		if (!sel.options.length) sel.appendChild(el('option', { value: '' }, ptList ? 'No devices on Port Testing' : 'Reading Port Testing\'s devices…'));
		sel.value = current || names[0] || '';
		note.textContent = !ptList ? '' : ptList.error ? ptList.error :
			ptList.installed && ptList.status !== 'Running' ? 'Port Testing is not running, so its devices can\'t be read.' :
			listed && !names.length ? 'Add one on Port Testing\'s Devices tab.' : '';
	}

	/* The dialog's Port Testing rows from the rule */
	function ptFill() {
		var p = ptOf(draft);
		$('rd-pt').checked = p.on;
		ptGameSet(p.game);
		$('rd-pt-min').value = p.minutes;
		var sp = $('rd-pt-speed');
		if (p.speed === 'slow' && !sp.querySelector('option[value="slow"]')) sp.insertBefore(el('option', { value: 'slow' }, 'Slow'), sp.firstChild);
		sp.value = p.speed;
		$('rd-pt-enc').checked = p.encrypt;
		$('rd-pt-proto').value = p.proto;
		$('rd-pt-port').value = p.port || '';
		ptDevices(p.camera);
		ptShow();
	}

	/* Reads Port Testing's devices again (each time a rule is opened, and when Port Testing comes or goes) */
	function ptLoad() {
		if (ptInstalled() === 'no') { ptList = { installed: false, status: '', devices: [] }; return; }
		fetch('porttesting', { cache: 'no-store' })
			.then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
			.catch(function (e) { return { installed: true, status: 'Running', devices: [], error: 'Could not read Port Testing\'s devices (' + e.message + ').' }; })
			.then(function (l) {
				ptList = l || { devices: [] };
				if (draft) { ptDevices($('rd-pt-dev').value || ptOf(draft).camera); updateHow(); }
			});
	}

	/* The dialog back into the draft. Not installed: the saved setting is kept as it is. A rule that never
	 * used Port Testing gets nothing, so it saves exactly as before. */
	function readPt() {
		if (!draft || ptInstalled() === 'no') return;
		var on = $('rd-pt').checked;
		if (!on && !draft.portTesting) return;
		var m = parseInt($('rd-pt-min').value, 10), port = parseInt($('rd-pt-port').value, 10);
		draft.portTesting = {
			on: on, camera: $('rd-pt-dev').value, game: ptGame(),
			minutes: isFinite(m) ? Math.min(15, Math.max(1, m)) : 2,
			speed: $('rd-pt-speed').value, encrypt: $('rd-pt-enc').checked,
			proto: $('rd-pt-proto').value, port: port >= 1 && port <= 65535 ? port : 0
		};
	}

	/* For the Status tip: what happened to the last start, or that Port Testing is missing */
	function ptTip(rule, s) {
		var p = ptOf(rule);
		if (!p.on) return '';
		if (ptInstalled() === 'no') return ' Port Testing is not installed, so the Port Testing start saved with this rule does nothing.';
		return s && s.portTesting ? ' Port Testing at ' + clock(s.portTestingAt) + ': ' + s.portTesting + '.' : '';
	}

	/* Save: a Port Testing start that is switched on needs a device, and a port check a port */
	function ptProblems(rules) {
		var out = [];
		if (ptInstalled() === 'no') return out;   /* kept as it is; nothing to fix here */
		rules.forEach(function (r, i) {
			var p = ptOf(r);
			if (!r.portTesting || !p.on) return;
			if (!p.camera) out.push('rule ' + (i + 1) + ' starts Port Testing but has no device');
			else if (p.game === 'check' && !p.port) out.push('rule ' + (i + 1) + '\'s port check has no port (1 to 65535)');
		});
		return out;
	}

	function updateHow() {
		readDialog();
		var how = $('rd-how');
		how.textContent = '';
		describeRule(draft).forEach(function (p) {
			var para = el('p');
			p.forEach(function (part) { para.appendChild(typeof part === 'string' ? document.createTextNode(part) : el('b', null, part.b)); });
			how.appendChild(para);
		});
	}

	function dwellBit(r, word) { var d = dwellOf(r); return d ? [' and stays ' + word + ' for ', { b: waitText(d) }] : []; }

	/* The rule in plain words: a list of paragraphs, each a list of text and {b: bold text} */
	function describeRule(r) {
		var out = [];
		if (!r.source) return [['Pick a source event to see what this rule will do.']];
		var e = eventFor(r.source);
		var srcName = e ? e.name : (r.source.name || sourcePath(r.source));
		var name = (r.name || '').trim();
		if (!name) return [['Enter the event name to send to see what this rule will do.']];
		var f = ruleFilter(r);
		var fdef = filterFor(r.source);
		var w = conditionWord(r.source, e);
		var stateless = e && !hasState(e);
		var onWhat = f ? (f.match === 'contains' ? [' detects ', { b: f.value }] : [' reports ', { b: ((fdef || {}).label || f.key) + ' ' + f.value }]) : null;

		if (r.enabled === false) out.push(['This rule is switched off, so nothing is sent. Switched on, it works like this:']);
		var p = [];
		if (stateless) {
			p = ['Each time ', { b: srcName }, ' happens'].concat(onWhat ? [' and'].concat(onWhat) : []).concat([', Data Bender sends ', { b: name }, ' once: On, then Off one second later.']);
		} else if (r.send === 'off') {
			p = ['When ', { b: srcName }, ' turns Off (' + w + ' turns Off)'].concat(dwellBit(r, 'Off')).concat([', Data Bender sends ', { b: name }, ' once: On, then Off one second later.']);
		} else if (r.send === 'on') {
			p = ['When ', { b: srcName }].concat(onWhat || [' turns On']).concat([' (' + w + ' turns On)']).concat(dwellBit(r, 'On')).concat([', Data Bender sends ', { b: name }, ' once: On, then Off one second later.']);
		} else {
			p = ['When ', { b: srcName }].concat(onWhat || [' turns On']).concat([' (' + w + ' turns On)']).concat(dwellBit(r, 'On')).concat([', Data Bender turns ', { b: name }, ' On, and Off again when the source turns Off.']);
		}
		p.push(' It goes out under ', { b: 'Data Bender › ' + name }, '.');
		out.push(p);
		if (!stateless && dwellOf(r)) out.push(['If it turns ' + (r.send === 'off' ? 'On' : 'Off') + ' again before ', { b: waitText(dwellOf(r)) }, ' have passed, nothing is sent.']);
		if (!stateless && r.send === 'on') out.push(['When the source turns Off, nothing is sent.']);
		if (!stateless && r.send === 'off') out.push(['When the source turns On, nothing is sent.']);
		var pt = ptHow(r);
		if (pt) out.push(pt);

		var c = ctxOf(r);
		if (c.text) {
			var cp = ['The event carries the context ', { b: c.text }, '.'];
			if (/count/.test(c.text)) {
				var reset = c.reset === 'never' ? 'never starts again' : c.reset === 'hourly' ? 'starts again at ' + c.start + ' every hour' : c.reset === 'save' ? 'starts again at ' + c.start + ' when the rule is saved' : 'starts again at ' + c.start + ' every day at midnight';
				cp.push(' The count goes up by ' + c.step + (c.count === 'every' ? ' for every source event' : ' each time it fires') + ' and ' + reset + '.');
			}
			out.push(cp);
		}

		var re = r.reactivation || reOf(r);
		if (re.wait) {
			var rp = ['After it fires, it waits ', { b: waitText(re.wait) }, re.from === 'off' ? ' after the source turns Off' : '', ' before it can fire again. '];
			rp.push(re.held === 'send' ? 'Triggers during the wait are held back; if any came in, one event is sent when the wait ends.' : 'Triggers during the wait are dropped and not sent.');
			out.push(rp);
		} else {
			out.push(['It fires every time; there is no wait between events.']);
		}
		return out;
	}

	function closeRule(save) {
		if (save && draft) {
			readDialog();
			settings.rules[ruleIndex] = draft;
			setDirty(true);
		} else if (draftIsNew) {
			settings.rules.splice(ruleIndex, 1);
		}
		ruleModal.close();
		draft = null; ruleIndex = -1; draftIsNew = false;
		render(true);
	}

	function setupRuleDialog() {
		['rd-name', 'rd-wait', 'rd-dwell'].forEach(function (id) { $(id).addEventListener('input', function () { renderRuleParts(); }); });
		['rd-enabled', 'rd-unit', 'rd-dwell-unit', 'rd-from', 'rd-held'].forEach(function (id) { $(id).addEventListener('change', updateHow); });
		$('rd-filter').addEventListener('change', updateHow);
		$('rd-cond').addEventListener('change', updateHow);
		/* Also do: Port Testing */
		$('rd-pt').addEventListener('change', function () { ptShow(); updateHow(); });
		Kit.seg($('rd-pt-game'), function () { ptShow(); updateHow(); });
		['rd-pt-dev', 'rd-pt-speed', 'rd-pt-enc', 'rd-pt-proto'].forEach(function (id) { $(id).addEventListener('change', updateHow); });
		['rd-pt-min', 'rd-pt-port'].forEach(function (id) { $(id).addEventListener('input', updateHow); });
		$('rd-pt-min').addEventListener('blur', function () { if (draft) $('rd-pt-min').value = ptOf(draft).minutes; });
		$('rd-ctx-edit').addEventListener('click', function () {
			readDialog();
			openContext(draft, function () { renderRuleParts(); });
		});
		$('rd-done').addEventListener('click', function () { closeRule(true); });
		$('rd-cancel').addEventListener('click', function () { closeRule(false); });
		$('rd-test').addEventListener('click', function () { var r = settings.rules[ruleIndex]; if (r) testRule(r); });
		$('rd-delete').addEventListener('click', function () {
			var i = ruleIndex;
			Kit.ask({ title: 'Delete this rule?', text: 'It is removed when you press Save on the page.', ok: 'Delete rule' }).then(function (yes) {
				if (!yes) return;
				ruleModal.close(); draft = null; ruleIndex = -1; draftIsNew = false;
				deleteRule(i);
			});
		});
		/* Escape or a click outside: the same as Cancel (a new rule is dropped) */
		ruleModal = Kit.modal($('rule-overlay'), { onEscape: function () { closeRule(false); } });
	}

	/* A rule's status in plain words, a short time or reason next to it, details on hover (for Kit.items) */
	function statusOf(rule) {
		var st = statusBase(rule);
		if (st.word !== 'Not saved' && st.word !== 'Disabled') st.tip += ptTip(rule, ((status.relay || {}).rules || {})[rule.id]);
		return st;
	}

	function statusBase(rule) {
		var s = ((status.relay || {}).rules || {})[rule.id];
		var missing = eventsLoaded && rule.source && !events.some(function (e) { return e.path === sourcePath(rule.source); });
		var dirtyRule = !s || !savedIds[rule.id];
		if (dirtyRule) return { word: 'Not saved', tip: 'Press Save to start this rule.' };
		if (rule.enabled === false || s.enabled === false) return { word: 'Disabled', tip: 'Not listening. Nothing is sent.' };
		var sa = sourceApp(rule);
		if (sa.kind === 'app' && !sa.running) return { word: 'Problem', tip: sa.nice + ' is not running, so no events come in. Start it on the camera\'s Apps page.' };
		if (s.error || missing) return { word: 'Problem', tip: s.error || 'The source event is not on this camera any more.' };
		if (s.dwelling) return { word: 'Dwell', extra: (s.dwellLeft || 0) + ' s', tip: 'Condition met; the rule fires if it lasts ' + (s.dwellLeft || 0) + ' s more.' };
		if (s.waiting) return { word: 'Waiting', extra: s.waitingOff ? '' : (s.waitLeft || 0) + ' s', tip: s.waitingOff ? 'Fired; waits for the source to turn Off, then for the reactivation time.' : 'Fired; can fire again in ' + (s.waitLeft || 0) + ' s.' };
		if (s.sourceActive) return { word: 'Triggered', extra: clock(s.activeSince), tip: 'The source event is active since ' + clock(s.activeSince) + '.' };
		if (s.subscribed && s.declared) return { word: 'Listening', tip: s.lastFired ? 'Working. Last triggered at ' + clock(s.lastFired) + '.' : 'Working. Waiting for the source event.' };
		return { word: 'Starting…', tip: 'Data Bender is setting this rule up.' };
	}

	/* Status and source lights change with the camera: redraw the table when they do */
	function renderStatus(force) {
		var relay = status.relay || {};
		if (foot) foot.busy(relay.applying ? 'Applying changes on the camera (about 2 seconds per renamed or removed rule)…' : null);
		render(force);
	}

	/*--------------------------------------------------
	 * Source light: is the app the rule listens to running?
	 * Apps come from the camera's app list; an app's events use its name as their topic1.
	 *--------------------------------------------------*/
	var apps = null;           // normalized app name -> { nice, status }

	function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
	function firstValue(o) { return o && typeof o === 'object' ? o[Object.keys(o)[0]] : o; }

	function sourceApp(rule) {
		var src = rule.source;
		if (!src || !src.topic0) return { kind: 'none' };
		if (firstValue(src.topic0) !== 'CameraApplicationPlatform') return { kind: 'camera' };
		var t1 = firstValue(src.topic1) || '';
		if (!apps) return { kind: 'loading', nice: t1 };
		var key = normName(t1);
		var a = apps[key];
		if (!a) Object.keys(apps).forEach(function (k) { if (!a && normName(apps[k].nice) === key) a = apps[k]; });
		if (!a) return { kind: 'unknown', nice: t1 };
		return { kind: 'app', nice: a.nice, running: a.status === 'Running', status: a.status || 'Not running' };
	}

	/* The Source light (for Kit.items): green running, red stopped, grey camera or unknown */
	function sourceOf(rule) {
		var sa = sourceApp(rule);
		if (sa.kind === 'none') return { name: 'No source', state: 'none', tip: 'Pick a source event in Edit.' };
		if (sa.kind === 'camera') return { name: 'Camera', state: 'cam', sub: 'Built in', tip: 'An event built into the camera: always available.' };
		if (sa.kind === 'loading') return { name: sa.nice, state: 'none', tip: 'Checking the camera\'s apps…' };
		if (sa.kind === 'unknown') return { name: sa.nice, state: 'none', sub: 'Unknown', tip: 'This app is not in the camera\'s app list, so its state is unknown.' };
		if (sa.running) return { name: sa.nice, state: 'good', sub: 'Running', tip: sa.nice + ' is running.' };
		return { name: sa.nice, state: 'bad', sub: sa.status === 'Stopped' ? 'Stopped' : sa.status, tip: sa.nice + ' is not running, so no events come in. Start it on the camera\'s Apps page.' };
	}

	/* A source app that is still starting has not published its events yet. While any rule's
	 * source event is missing, read the camera's event list again, so Status clears by itself. */
	var recheckBusy = false, lastRecheck = 0;
	function recheckEvents() {
		if (!eventsLoaded || recheckBusy || Date.now() - lastRecheck < 10000) return;
		var missing = settings.rules.some(function (r) {
			return r.source && !events.some(function (e) { return e.path === sourcePath(r.source); });
		});
		if (!missing) return;
		recheckBusy = true;
		lastRecheck = Date.now();
		listEvents()
			.then(function (list) { if (Array.isArray(list) && list.length) { events = list; renderStatus(); } })
			.catch(function () { /* try again on the next tick */ })
			.then(function () { recheckBusy = false; });
	}

	/* The camera's apps come from the kit (its apps endpoint, every 5 s) */
	function appsChanged(list) {
		var m = {};
		list.forEach(function (a) { m[normName(a.id)] = { nice: a.name || a.id, status: a.status || '' }; });
		apps = m;
		/* Port Testing installed or removed while a rule is open: redraw its row */
		if (draft && ptInstalled() !== ptInstSeen) { ptShow(); ptLoad(); updateHow(); }
		renderStatus();
		recheckEvents();
	}

	function refreshStatus() {
		fetch('status', { cache: 'no-store' })
			.then(function (r) { return r.ok ? r.json() : null; })
			.then(function (s) { if (s) { status = s; renderStatus(); if (view === 'wf') drawWorkflowSoft(); } })
			.catch(function () { /* try again on the next tick */ });
	}

	/*--------------------------------------------------
	 * Log: the kit's (Kit.log). What came in, and exactly what was sent; newest at the top,
	 * the last 100 lines kept on the camera. Each line carries the rule's id (rule), received,
	 * sent, state, topic, trigger, context and note (main.c log_activity).
	 *--------------------------------------------------*/
	function sentCell(a) {
		if (a.pt) return '<div class="pt-res">Port Testing: ' + Kit.esc(a.pt) + '</div>';   /* Also do (main.c pt_log) */
		var details = [];
		var out = '<div class="sent-line">';
		if (a.sent) {
			out += '<span class="pill ' + (a.state === 'On' ? 'on' : 'off') + '">' + Kit.esc(a.state) + '</span><span class="sent-name">' + Kit.esc(a.sent) + '</span>';
			details.push(a.topic + '  active=' + (a.state === 'On' ? 1 : 0) + (a.trigger ? '  (trigger, no Off)' : ''));
		} else {
			out += '<span class="hint">Nothing sent</span>';
		}
		if (a.note) details.push(a.note);
		/* Details behind the kit's Help (i): opens on click, never on hover */
		if (details.length) out += '<button type="button" class="kit-info" data-help-title="Details" data-help="' + Kit.esc(details.join('\n')) + '" aria-label="Details" aria-expanded="false">i</button>';
		out += '</div>';
		if (a.context) out += '<div class="ctx-sent">Context: ' + Kit.esc(a.context) + '</div>';
		return out;
	}

	function setupLog() {
		log = Kit.log($('log-panel'), {
			itemLabel: 'Rule',
			button: '#log-btn',   // the log stays hidden until this button (or a rule's Log button) shows it
			hint: 'What came in, and exactly what was sent. Newest at the top; the last 100 lines are kept.',
			empty: 'Nothing yet. Use Test, or wait for a source event.',
			columns: [
				{ key: 'received', label: 'Received' },
				{ key: 'sent', label: 'Sent', cell: sentCell,
				  text: function (a) { return a.pt ? 'Port Testing: ' + a.pt : [a.sent ? a.state + ' ' + a.sent : 'Nothing sent', a.context, a.note].filter(Boolean).join(' · '); },
				  options: [
					{ v: 'On', label: 'On', match: function (a) { return !!a.sent && a.state === 'On'; } },
					{ v: 'Off', label: 'Off', match: function (a) { return !!a.sent && a.state === 'Off'; } },
					{ v: 'none', label: 'Nothing sent', match: function (a) { return !a.sent && !a.pt; } },
					{ v: 'pt', label: 'Port Testing', match: function (a) { return !!a.pt; } }
				  ] }
			],
			/* The Workflow view's "Show last trigger": each rule's newest line that came from its source */
			onLines: function (lines) {
				var last = {};
				lines.slice().reverse().forEach(function (a) {   /* oldest first, so the newest wins */
					if (a.rule && a.received && !(a.sent && a.state === 'Off' && !a.trigger)) last[a.rule] = a;
				});
				lastByRule = last;
				if (view === 'wf' && wfRun) drawWorkflowSoft();
			}
		});
	}

	/* Log button: show only that rule's lines */
	function openLog(rule) { log.filterTo((rule.name || '').trim() ? fullName(rule.name.trim()) : rule.id); }

	/*--------------------------------------------------
	 * Workflow view: the chosen rule drawn as a flowchart
	 *   When > Only if > Condition > Dwell > Reactivation > Send
	 *--------------------------------------------------*/
	var view = 'table';
	var wfIndex = 0, wfNode = 'when', wfRun = false, wfAll = false;
	var lastByRule = {};
	/* Shape colours by kind (when, decide, flow, do, end) are kit tokens, set in css/app.css (.k-<kind>) */

	function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
	function svgEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

	function setView(v) {
		view = v === 'wf' ? 'wf' : 'table';
		try { localStorage.setItem('databender-view', view); } catch (e) { /* not kept */ }
		$('view-table').classList.toggle('on', view === 'table');
		$('view-wf').classList.toggle('on', view === 'wf');
		$('view-table').setAttribute('aria-pressed', String(view === 'table'));
		$('view-wf').setAttribute('aria-pressed', String(view === 'wf'));
		$('table-view').hidden = view !== 'table';
		$('wf-view').hidden = view !== 'wf' || !settings.rules.length;
		renderWorkflow();
	}

	/* Which shapes the last source event reached, from its log line */
	function runPath(a) {
		var main = ['when', 'filter', 'cond', 'dwell', 're', 'send', 'end'];
		var n = a.note || '';
		if (a.sent) return { reached: main, text: 'sent ' + a.sent + (a.state ? ' (' + a.state + ')' : '') };
		if (/^Ignored/.test(n)) return { reached: ['when', 'filter', 'x1'], text: n };
		if (/not sent: this rule sends/.test(n)) return { reached: ['when', 'filter', 'cond', 'x2'], text: n };
		if (/^Condition met/.test(n)) return { reached: ['when', 'filter', 'cond', 'dwell'], text: n };
		if (/^Condition ended/.test(n)) return { reached: ['when', 'filter', 'cond', 'dwell', 'x3'], text: n };
		if (/^Held back/.test(n)) return { reached: ['when', 'filter', 'cond', 'dwell', 're', 'x4'], text: n };
		return { reached: ['when'], text: n || 'nothing sent' };
	}

	function wfChart(rule) {
		var e = rule.source ? eventFor(rule.source) : null;
		var stateless = e && !hasState(e);
		var f = ruleFilter(rule);
		var w = rule.source ? conditionWord(rule.source, e) : 'State';
		var d = dwellOf(rule);
		var re = reOf(rule);
		var sa = sourceApp(rule);
		var c = ctxOf(rule);
		var name = (rule.name || '').trim() || '(no name)';
		var srcName = rule.source ? (e ? e.name : (rule.source.name || sourcePath(rule.source))) : 'Pick a source event';
		var srcState = sa.kind === 'app' ? sa.nice + ' · ' + (sa.running ? 'Running' : sa.status) : sa.kind === 'camera' ? 'Camera · built in' : sa.kind === 'none' ? '' : sa.nice;
		var condText = stateless ? ['Triggered', ''] : [w, rule.send === 'off' ? 'turns Off?' : rule.send === 'on' ? 'turns On?' : 'changes?'];
		var endText = stateless || rule.send !== 'both' ? 'Off 1 s later' : 'Off when source is Off';
		/* Main chain, top to bottom: id, shape, kind, x, w, h, line 1, line 2, skipped, label on the wire out, side exit.
		   y is laid out below, so unused (skipped) steps can be left out and the chain closes up. */
		var chain = [
			['when', 'box', 'when', 65, 200, 54, 'When: ' + trunc(srcName, 26), trunc(srcState, 32), 0, ''],
			['filter', 'dia', 'decide', 165, 0, 70, 'Only if', f ? trunc(f.value, 12) : 'any', !f, f ? 'yes' : '', f ? ['x1', 'Ignored', 'no'] : null],
			['cond', 'dia', 'decide', 165, 0, 70, trunc(condText[0], 12), condText[1], stateless, stateless ? '' : 'yes',
				!stateless && rule.send !== 'both' ? ['x2', 'Not sent', rule.send === 'off' ? 'On' : 'Off'] : null],
			['dwell', 'box', 'flow', 65, 200, 54, d ? 'Dwell: lasts ' + waitText(d) : 'Dwell: none', d ? 'ends sooner: nothing sent' : 'fires at once', !d, d ? 'lasted' : '', d ? ['x3', 'Not sent', 'sooner'] : null],
			['re', 'dia', 'decide', 165, 0, 70, re.wait ? 'Still in the' : 'Reactivation', re.wait ? waitText(re.wait) + ' wait?' : 'none', !re.wait, re.wait ? 'no' : '', re.wait ? ['x4', 'Held back', 'yes'] : null],
			['send', 'box', 'do', 55, 220, 62, 'Send: ' + trunc(name, 24), c.text ? 'Context: ' + trunc(c.text, 26) : 'No context', 0, ''],
			['end', 'pill', 'end', 95, 140, 36, endText, '', 0, '']
		].filter(function (n) { return wfAll || !n[8]; });
		/* N: id, shape, kind, x, y, w, h, line 1, line 2, skipped (y of a diamond is its centre) */
		var N = [], W = [], top = 16, GAP = 38;
		chain.forEach(function (n, i) {
			var dia = n[1] === 'dia', h = n[5], mid = top + h / 2;
			N.push([n[0], n[1], n[2], n[3], dia ? mid : top, n[4], h, n[6], n[7], n[8]]);
			var side = n[10];
			if (side) {
				N.push([side[0], 'pill', 'end', 300, mid - 18, 96, 36, side[1], '', 0]);
				W.push(dia ? ['M215 ' + mid + ' L300 ' + mid, side[2], 238, mid - 7] : ['M265 ' + mid + ' L300 ' + mid, side[2], 262, mid - 8]);
			}
			if (i < chain.length - 1) W.push(['M165 ' + (top + h) + ' L165 ' + (top + h + GAP), n[9], 172, top + h + 23]);
			top += h + GAP;
		});
		var height = top - GAP + 16;

		var path = wfRun && lastByRule[rule.id] ? runPath(lastByRule[rule.id]).reached : null;
		var nodes = N.map(function (n) {
			var id = n[0], sh = n[1], k = n[2], x = n[3], y = n[4], wd = n[5], h = n[6], t1 = n[7], t2 = n[8], skip = n[9];
			var shape, tx, ty, tk;
			if (sh === 'dia') {
				shape = '<polygon points="' + x + ',' + (y - 35) + ' ' + (x + 52) + ',' + y + ' ' + x + ',' + (y + 35) + ' ' + (x - 52) + ',' + y + '"/>';
				tx = x; ty = y + (t2 ? -4 : 4); tk = [x + 34, y - 30];
			} else {
				shape = '<rect x="' + x + '" y="' + y + '" width="' + wd + '" height="' + h + '" rx="' + (sh === 'pill' ? h / 2 : 8) + '"/>';
				tx = x + wd / 2; ty = y + h / 2 + (t2 ? -4 : 4); tk = [x + wd - 4, y + 4];
			}
			var hit = path && path.indexOf(id) >= 0;
			var cls = 'node k-' + k + (id === wfNode ? ' sel' : '') + (skip ? ' skip' : '') + (path && !hit ? ' miss' : '');
			return '<g class="' + cls + '" data-node="' + id + '" tabindex="0" role="button" aria-label="' + svgEsc(t1 + ' ' + t2) + '">' + shape +
				'<text x="' + tx + '" y="' + ty + '" text-anchor="middle">' + svgEsc(t1) + '</text>' +
				(t2 ? '<text class="sub" x="' + tx + '" y="' + (ty + 15) + '" text-anchor="middle">' + svgEsc(t2) + '</text>' : '') +
				(hit ? '<g class="tick"><circle cx="' + tk[0] + '" cy="' + tk[1] + '" r="8"/><text x="' + tk[0] + '" y="' + (tk[1] + 4) + '" text-anchor="middle">✓</text></g>' : '') + '</g>';
		}).join('');
		var wires = W.map(function (x) {
			return '<path class="wire" d="' + x[0] + '" marker-end="url(#wf-ar)"/>' + (x[1] ? '<text class="w" x="' + x[2] + '" y="' + x[3] + '">' + x[1] + '</text>' : '');
		}).join('');
		/* same scale as the full chart (660 high at most 72vh), so a shorter chart is shorter, not bigger */
		return '<svg viewBox="0 0 410 ' + height + '" style="max-height:calc(72vh * ' + (height / 660).toFixed(3) + ')" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Workflow of the rule ' + svgEsc(name) + '">' +
			'<defs><marker id="wf-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="wf-arrow" d="M0,0 L10,5 L0,10 z"/></marker></defs>' + wires + nodes + '</svg>';
	}

	function wfRuleList() {
		var box = $('wf-rules');
		box.textContent = '';
		settings.rules.forEach(function (rule, i) {
			var s = (status.relay && status.relay.rules && status.relay.rules[rule.id]) || null;
			var sa = sourceApp(rule);
			var off = rule.enabled === false;
			var bad = !off && ((sa.kind === 'app' && !sa.running) || (s && s.error) || !rule.source);
			var b = el('button', { type: 'button', className: 'wf-rule' + (i === wfIndex ? ' on' : ''), role: 'option', 'aria-selected': String(i === wfIndex) });
			b.appendChild(el('span', { className: 'wf-dot' + (off ? '' : bad ? ' err' : ' ok') }));
			var t = el('span');
			t.appendChild(el('b', null, (rule.name || '').trim() || '(no name)'));
			t.appendChild(el('span', { className: 'sub' }, off ? 'Switched off' : !rule.source ? 'No source' : (sa.kind === 'app' ? sa.nice + (sa.running ? '' : ' · ' + sa.status) : sa.kind === 'camera' ? 'Camera' : sa.nice || '')));
			b.appendChild(t);
			b.addEventListener('click', function () { wfIndex = i; wfNode = 'when'; renderWorkflow(); });
			box.appendChild(b);
		});
	}

	function propLabel(text, forId) { return el('label', { className: 'p-l', 'for': forId || '' }, text); }
	function kindTag(k, t) { return el('span', { className: 'kind k-' + k + (k === 'when' || k === 'decide' ? ' dark' : '') }, t); }
	function changed() { setDirty(true); drawWorkflowSoft(); }

	function timeInputs(sec, units, onChange, idBase) {
		var unit = sec ? units.slice().reverse().find(function (u) { return sec % u === 0; }) || 1 : 1;
		var wrap = el('div', { className: 'inline2' });
		var n = el('input', { type: 'text', inputmode: 'decimal', id: idBase, 'aria-label': 'Amount' });
		n.value = sec / unit;
		var u = el('select', { 'aria-label': 'Unit' });
		var names = { 1: 'seconds', 60: 'minutes', 3600: 'hours', 86400: 'days' };
		units.forEach(function (x) { u.appendChild(el('option', { value: String(x) }, names[x])); });
		u.value = String(unit);
		function read() { var v = parseFloat(n.value); onChange(isFinite(v) && v > 0 ? Math.round(v * Number(u.value)) : 0); }
		n.addEventListener('input', read);
		u.addEventListener('change', read);
		wrap.appendChild(n); wrap.appendChild(u);
		return wrap;
	}

	function wfProps(rule) {
		var p = $('wf-props');
		p.textContent = '';
		var h = el('h4');
		var e = rule.source ? eventFor(rule.source) : null;
		var stateless = e && !hasState(e);
		var hTitle = '';
		function head(k, tag, title) { h.appendChild(kindTag(k, tag)); h.appendChild(document.createTextNode(title)); p.appendChild(h); hTitle = title; }
		/* The explanation goes behind a Help (i) after the heading */
		function help(t) { Kit.help(h, hTitle, t); }

		if (wfNode === 'when') {
			head('when', 'When', 'Source event');
			p.appendChild(propLabel('Source event name'));
			var picker = sourcePicker(rule, function (s) {
				rule.source = s; rule.object = ''; rule.filter = null; rule.send = 'on';
				if (!(rule.name || '').trim()) rule.name = suggestedName(rule);
				setDirty(true); render();
			});
			p.appendChild(picker);
			pickers.push(picker);
			var sa = sourceApp(rule);
			if (sa.kind !== 'none') {
				p.appendChild(propLabel('Source'));
				var l = el('span', { className: 'p-light' });
				l.appendChild(el('span', { className: 'wf-dot' + (sa.kind === 'app' && !sa.running ? ' err' : sa.kind === 'unknown' || sa.kind === 'loading' ? '' : ' ok') }));
				l.appendChild(document.createTextNode(sa.kind === 'app' ? sa.nice + ' · ' + (sa.running ? 'Running' : sa.status) : sa.kind === 'camera' ? 'Camera · built in' : sa.nice));
				p.appendChild(l);
			}
			p.appendChild(propLabel('Rule'));
			var sw = el('label', { className: 'switch' });
			var box = el('input', { type: 'checkbox', 'aria-label': 'Rule enabled' });
			box.checked = rule.enabled !== false;
			box.addEventListener('change', function () { rule.enabled = box.checked; setDirty(true); render(); });
			sw.appendChild(box); sw.appendChild(el('span', { className: 'track' }));
			sw.appendChild(document.createTextNode(' Enabled'));
			p.appendChild(sw);
		} else if (wfNode === 'filter' || wfNode === 'x1') {
			head('decide', 'Only if', 'Filter');
			var fd = el('div');
			renderFilter(fd, rule);
			fd.addEventListener('change', changed);
			p.appendChild(propLabel('Filter'));
			p.appendChild(fd);
			help('Only source events that match go on. Others are logged as Ignored.');
		} else if (wfNode === 'cond' || wfNode === 'x2') {
			head('decide', 'Condition', 'On / Off');
			var cd = el('div');
			renderCondition(cd, rule);
			cd.addEventListener('change', changed);
			p.appendChild(propLabel('Condition'));
			p.appendChild(cd);
			help(stateless ? 'This source has no On/Off state: the rule fires once per event.' : 'On or Off: the rule sends a short trigger. On and Off: the event follows the source.');
		} else if (wfNode === 'dwell' || wfNode === 'x3') {
			head('flow', 'Dwell', 'It must last');
			p.appendChild(propLabel('Dwell time', 'wf-dwell'));
			var dw = timeInputs(dwellOf(rule), [1, 60, 3600, 86400], function (v) { rule.dwell = Math.min(v, 2592000) || null; changed(); }, 'wf-dwell');
			if (stateless) dw.querySelectorAll('input, select').forEach(function (x) { x.disabled = true; });
			p.appendChild(dw);
			help(stateless ? 'This source has no On/Off state (Triggered), so there is nothing to time.' : 'The condition must last this long before the rule fires. If it ends sooner, nothing is sent. 0 = fire at once.');
		} else if (wfNode === 're' || wfNode === 'x4') {
			head('decide', 'Reactivation', 'Wait before firing again');
			var re = reOf(rule);
			p.appendChild(propLabel('Wait', 'wf-wait'));
			p.appendChild(timeInputs(re.wait, [1, 60, 3600], function (v) { var r = reOf(rule); r.wait = Math.min(v, 86400); rule.reactivation = r; changed(); }, 'wf-wait'));
			p.appendChild(propLabel('Count the wait from', 'wf-from'));
			var from = el('select', { id: 'wf-from' });
			[['sent', 'When the event is sent'], ['off', 'When the source turns Off']].forEach(function (o) { from.appendChild(el('option', { value: o[0] }, o[1])); });
			from.value = re.from;
			from.addEventListener('change', function () { var r = reOf(rule); r.from = from.value; rule.reactivation = r; changed(); });
			p.appendChild(from);
			p.appendChild(propLabel('Triggers held back', 'wf-held'));
			var held = el('select', { id: 'wf-held' });
			[['drop', 'Drop them'], ['send', 'Send one when the wait ends, if any came in']].forEach(function (o) { held.appendChild(el('option', { value: o[0] }, o[1])); });
			held.value = re.held;
			held.addEventListener('change', function () { var r = reOf(rule); r.held = held.value; rule.reactivation = r; changed(); });
			p.appendChild(held);
			help('After this rule sends an event, new triggers are held back until this time has passed. 0 = no wait.');
		} else if (wfNode === 'send') {
			head('do', 'Send', 'Event');
			p.appendChild(propLabel('Event name to send', 'wf-name'));
			var nm = el('input', { type: 'text', id: 'wf-name', maxlength: '64', placeholder: 'e.g. Person Detected' });
			nm.value = rule.name || '';
			var sentAs = el('div', { className: 'help' }, 'Sent as: Data Bender › ' + ((rule.name || '').trim() || '…'));
			nm.addEventListener('input', function () { rule.name = nm.value; sentAs.textContent = 'Sent as: Data Bender › ' + (nm.value.trim() || '…'); changed(); wfRuleList(); });
			p.appendChild(nm);
			p.appendChild(sentAs);
			p.appendChild(propLabel('Context'));
			var c = ctxOf(rule);
			p.appendChild(el('code', { className: c.text ? '' : 'hint' }, c.text || 'None'));
			var cb = el('button', { type: 'button', className: 'btn', style: 'margin-top:6px' }, 'Edit context…');
			cb.addEventListener('click', function () { openContext(rule, function () { setDirty(true); render(); }); });
			p.appendChild(el('div', null, '')).appendChild(cb);
		} else {
			head('end', 'End', 'After sending');
			help(stateless || rule.send !== 'both' ? 'The event goes On, then Off one second later.' : 'The event stays On while the source is On, and goes Off when the source turns Off.');
		}

		var how = el('div', { className: 'how' });
		describeRule(rule).forEach(function (para) {
			var pe = el('p');
			para.forEach(function (part) { pe.appendChild(typeof part === 'string' ? document.createTextNode(part) : el('b', null, part.b)); });
			how.appendChild(pe);
		});
		p.appendChild(how);
	}

	/* Redraw the chart only (keeps focus in the settings while typing) */
	function drawWorkflowSoft() {
		if (view !== 'wf') return;
		var rule = settings.rules[wfIndex];
		if (!rule) return;
		var cv = $('wf-canvas');
		cv.innerHTML = wfChart(rule);
		cv.classList.toggle('run', wfRun && !!lastByRule[rule.id]);
		var a = lastByRule[rule.id];
		$('wf-run-note').hidden = !wfRun;
		$('wf-run-note').textContent = !wfRun ? '' : a ? 'Last trigger ' + clock(a.time) + ': ' + runPath(a).text + '. ✓ reached, faded = not reached.' : 'No trigger in the log for this rule yet.';
		cv.querySelectorAll('.node').forEach(function (g) {
			function pick() { wfNode = g.getAttribute('data-node'); renderWorkflow(); }
			g.addEventListener('click', pick);
			g.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
		});
		var how = document.querySelector('#wf-props .how');
		if (how) {
			how.textContent = '';
			describeRule(rule).forEach(function (para) {
				var pe = el('p');
				para.forEach(function (part) { pe.appendChild(typeof part === 'string' ? document.createTextNode(part) : el('b', null, part.b)); });
				how.appendChild(pe);
			});
		}
	}

	function renderWorkflow() {
		if (view !== 'wf') return;
		$('wf-view').hidden = !settings.rules.length;
		if (!settings.rules.length) return;
		if (wfIndex >= settings.rules.length) wfIndex = settings.rules.length - 1;
		if (wfIndex < 0) wfIndex = 0;
		wfRuleList();
		wfProps(settings.rules[wfIndex]);
		drawWorkflowSoft();
	}

	function setupWorkflow() {
		var saved = 'table';
		try { saved = localStorage.getItem('databender-view') || 'table'; } catch (e) { /* default */ }
		$('view-table').addEventListener('click', function () { setView('table'); });
		$('view-wf').addEventListener('click', function () { setView('wf'); });
		$('wf-run').addEventListener('click', function () {
			wfRun = !wfRun;
			this.textContent = wfRun ? 'Hide last trigger' : 'Show last trigger';
			this.classList.toggle('active', wfRun);
			this.setAttribute('aria-pressed', String(wfRun));
			drawWorkflowSoft();
		});
		/* Unused steps (no filter, no dwell, no reactivation, no On/Off) are hidden unless Show all steps is on; remembered per browser */
		try { wfAll = localStorage.getItem('databender-wf-all') === '1'; } catch (e) { /* default: hidden */ }
		function showAllLabel() {
			var b = $('wf-all');
			b.textContent = wfAll ? 'Hide unused steps' : 'Show all steps';
			b.classList.toggle('active', wfAll);
			b.setAttribute('aria-pressed', String(wfAll));
		}
		showAllLabel();
		$('wf-all').addEventListener('click', function () {
			wfAll = !wfAll;
			try { localStorage.setItem('databender-wf-all', wfAll ? '1' : '0'); } catch (e) { /* not kept */ }
			showAllLabel();
			drawWorkflowSoft();
		});
		$('wf-test').addEventListener('click', function () { var r = settings.rules[wfIndex]; if (r) testRule(r); });
		$('wf-delete').addEventListener('click', function () { if (settings.rules[wfIndex]) deleteRule(wfIndex); });
		setView(saved);
	}

	/*--------------------------------------------------
	 * Context: text sent with each event, set in a popup
	 *--------------------------------------------------*/
	var CTX_TOKENS = ['{count}', '{held}', '{time}', '{date}', '{camera}', '{rule}', '{source}', '{object}', '{state}', '{serial}', '{ip}',
		'{count * 2}', '{pad(count, 4)}', '{upper(object)}', '{if(count > 10, "busy", "normal")}'];
	var ctxRule = null, ctxDone = null, previewTimer = null;

	function ctxOf(rule) {
		var c = rule.context || {};
		return { text: c.text || '', start: c.start === undefined ? 1 : c.start, step: c.step === undefined ? 1 : c.step,
		         reset: c.reset || 'daily', count: c.count || 'fires' };
	}

	function ctxFromDialog() {
		var num = function (id, d) { var v = parseFloat($(id).value); return isFinite(v) ? v : d; };
		return { text: $('ctx-text').value.trim(), start: num('ctx-start', 1), step: num('ctx-step', 1), reset: $('ctx-reset').value, count: $('ctx-count').value };
	}

	function updatePreview() {
		clearTimeout(previewTimer);
		previewTimer = setTimeout(function () {
			var c = ctxFromDialog();
			if (!c.text) { $('ctx-preview').textContent = 'Nothing (no context is sent)'; return; }
			post('preview', JSON.stringify({ id: ctxRule.id, name: ctxRule.name || '', context: c }))
				.then(function (t) { var r = JSON.parse(t); $('ctx-preview').textContent = r.text; })
				.catch(function (e) { $('ctx-preview').textContent = 'Preview not available: ' + e.message; });
		}, 250);
	}

	function insertToken(t) {
		var ta = $('ctx-text'), s = ta.selectionStart, e = ta.selectionEnd;
		ta.value = ta.value.slice(0, s) + t + ta.value.slice(e);
		ta.focus();
		ta.selectionStart = ta.selectionEnd = s + t.length;
		updatePreview();
	}

	/* {field:name} for every field the source event carries (port, channel, classTypes...) */
	function sourceFieldTokens(rule) {
		var e = rule && rule.source ? eventFor(rule.source) : null;
		var m = (e && e.meta) || {};
		var names = [];
		(m.sources || []).forEach(function (s) { names.push(s.key); });
		if (m.stateKey) names.push(m.stateKey);
		(m.data || []).forEach(function (d) { names.push(d); });
		return names.filter(function (n, i) { return n && names.indexOf(n) === i; }).map(function (n) { return '{field:' + n + '}'; });
	}

	function openContext(rule, done) {
		ctxRule = rule; ctxDone = done;
		var st = $('ctx-src-tokens');
		st.textContent = '';
		var ft = sourceFieldTokens(rule);
		ft.forEach(function (t) {
			var b = el('button', { type: 'button', className: 'token' }, t);
			b.addEventListener('click', function () { insertToken(t); });
			st.appendChild(b);
		});
		$('ctx-src-label').hidden = st.hidden = !ft.length;
		var c = ctxOf(rule);
		$('ctx-title').textContent = 'Context: ' + ((rule.name || '').trim() || '(no name)');
		$('ctx-text').value = c.text;
		$('ctx-start').value = c.start;
		$('ctx-step').value = c.step;
		$('ctx-reset').value = c.reset;
		$('ctx-count').value = c.count;
		ctxModal.open($('ctx-text'));
		updatePreview();
	}

	function closeContext(save) {
		if (save && ctxRule) {
			var c = ctxFromDialog();
			ctxRule.context = c.text ? c : null;
			if (ctxDone) ctxDone();
		}
		ctxModal.close();
		ctxRule = ctxDone = null;
	}

	function setupContextDialog() {
		var tokens = $('ctx-tokens');
		CTX_TOKENS.forEach(function (t) {
			var b = el('button', { type: 'button', className: 'token' }, t);
			b.addEventListener('click', function () { insertToken(t); });
			tokens.appendChild(b);
		});
		['ctx-text', 'ctx-start', 'ctx-step'].forEach(function (id) { $(id).addEventListener('input', updatePreview); });
		['ctx-reset', 'ctx-count'].forEach(function (id) { $(id).addEventListener('change', updatePreview); });
		$('ctx-done').addEventListener('click', function () { closeContext(true); });
		$('ctx-cancel').addEventListener('click', function () { closeContext(false); });
		$('ctx-clear').addEventListener('click', function () { $('ctx-text').value = ''; updatePreview(); });
		/* Escape or a click outside: the same as Cancel; only this dialog closes, not the rule under it */
		ctxModal = Kit.modal($('ctx-overlay'), { onEscape: function () { closeContext(false); } });
	}

	/*--------------------------------------------------
	 * Load and save
	 *--------------------------------------------------*/
	function rememberSaved() {
		savedIds = {};
		settings.rules.forEach(function (r) { savedIds[r.id] = true; });
	}

	function save() {
		if (stale) return Promise.reject(new Error('This page could not read the rules on the camera yet, so Save is off: it would overwrite them. It keeps trying; you can also reload the page.'));
		var problems = [];
		/* Only rules that are switched on must be complete; an unfinished rule can be saved switched off */
		settings.rules.forEach(function (r, i) {
			if (r.enabled === false) return;
			if (!r.source) problems.push('rule ' + (i + 1) + ' has no source event');
			if (!(r.name || '').trim()) problems.push('rule ' + (i + 1) + ' has no name');
		});
		problems = problems.concat(ptProblems(settings.rules));
		/* Run by the kit's Save button: a problem is thrown, and the kit shows it */
		if (problems.length) return Promise.reject(new Error(problems.join(', ') + '. Finish it, or switch it off to save it unfinished.'));

		var body = {
			rules: settings.rules.map(function (r) {
				var f = ruleFilter(r);
				var o = { id: r.id, enabled: r.enabled !== false, name: (r.name || '').trim(), object: '',
				         filter: f ? { key: f.key, value: f.value, match: f.match } : null,
				         send: (r.send === 'on' || r.send === 'off') ? r.send : 'both', source: r.source || null,
				         context: r.context && r.context.text ? r.context : null,
				         dwell: dwellOf(r) || null,
				         reactivation: reOf(r).wait ? reOf(r) : null };
				/* Also do: only rules that have it (older rules save exactly as before) */
				if (r.portTesting) o.portTesting = r.portTesting;
				return o;
			})
		};
		return post('settings', JSON.stringify(body))
			.then(function () {
				rememberSaved();
				setDirty(false);
				toast('Saved. Systems listening to these events may need to refresh their event list to see new names.', 'ok');
				setTimeout(refreshStatus, 800);
				setTimeout(function () { log.refresh(); }, 800);
				if (copy) copy.refresh();
			});
	}

	/* Loads the saved settings from the camera; also used by Cancel to drop unsaved changes.
	 * The app version in the header is the kit's (Kit.start). */

	/* Resolves true when the rules were read, false when not. Any failed read (the first one too) turns
	   Save off, so a page that never read the camera's rules can't overwrite them; it tries again every 5 s,
	   and says so once. */
	function loadSettings() {
		return fetch('settings', { cache: 'no-store' })
			.then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
			.then(function (s) {
				settings.rules = (s && Array.isArray(s.rules)) ? s.rules : [];
				stale = false;
				staleTold = false;
				rememberSaved();
				render();
				setDirty(false);
				return true;
			})
			.catch(function (e) {
				stale = true;
				if (!staleTold) { staleTold = true; toast('Could not load the rules: ' + e.message + '. Save is off until they load; trying again.', 'bad'); }
				render();
				retryLoad();
				return false;
			});
	}

	function retryLoad() {
		if (retryTimer) return;
		retryTimer = setTimeout(function () {
			retryTimer = null;
			if (!stale) return;
			var wasDirty = dirty;
			loadSettings().then(function (ok) {
				if (!ok) return;
				setTimeout(refreshStatus, 800);
				toast(wasDirty ? 'The rules were read from the camera. Unsaved changes on the Rules tab were replaced by them.' : 'The rules were read from the camera. Save is on again.', 'info');
			});
		}, 5000);
	}

	/* After an import or undo: read the camera's rules again (Save stays off until that works) */
	function reloadAfterImport(wasDirty) {
		stale = true;
		loadSettings().then(function (ok) {
			if (!ok) return;   /* retryLoad says when they are read, and whether edits were replaced */
			setTimeout(refreshStatus, 800);
			if (wasDirty) toast('Unsaved changes on the Rules tab were replaced by the rules now on the camera.', 'info');
		});
	}

	/*--------------------------------------------------
	 * Default rules: Person Detected and Vehicle Detected, matched to this camera's
	 * Object Analytics scenarios. A rule with no matching scenario is added switched off,
	 * without a source, for the user to finish.
	 *--------------------------------------------------*/
	var DEFAULT_RULES = [
		{ name: 'Person Detected', classes: ['human'] },
		{ name: 'Vehicle Detected', classes: ['vehicle', 'car', 'truck', 'bus', 'vehicle_other'] }
	];

	function addDefaultRules() {
		if (!eventsLoaded) { toast('Still reading the camera events. Try again in a moment.', 'bad'); return; }
		var added = [], unmatched = [];
		DEFAULT_RULES.forEach(function (d) {
			if (settings.rules.length >= MAX_RULES) return;
			/* Object Analytics scenarios on this camera that detect this kind of object; one-class scenarios first */
			var candidates = events.filter(function (e) {
				var t1 = Object.values(e.topic1 || {})[0], t2 = Object.values(e.topic2 || {})[0];
				if (t1 !== 'ObjectAnalytics' || !/^Device\d+Scenario\d+$/.test(t2 || '')) return false;
				return (aoaClasses[t2] || []).some(function (c) { return d.classes.indexOf(c) >= 0; });
			}).sort(function (a, b) {
				return (aoaClasses[Object.values(a.topic2)[0]] || []).length - (aoaClasses[Object.values(b.topic2)[0]] || []).length;
			});
			var e = candidates[0];
			var rule = { id: newId(), enabled: !!e, name: d.name, object: '', filter: null, send: 'on', source: e ? sourceFromEvent(e) : null };
			if (e) {
				var classes = aoaClasses[Object.values(e.topic2)[0]] || [];
				var cls = classes.filter(function (c) { return d.classes.indexOf(c) >= 0; })[0];
				/* Filter only when the scenario also detects other objects */
				if (classes.length > 1 && cls) rule.filter = { key: 'classTypes', value: cls, match: 'contains' };
				added.push(d.name + ' (' + e.name + ')');
			} else {
				unmatched.push(d.name);
			}
			settings.rules.push(rule);
		});
		setDirty(true);
		render();
		var msg = added.length ? 'Added ' + added.join(', ') + '.' : '';
		if (unmatched.length) msg += (msg ? ' ' : '') + unmatched.join(' and ') + ': no matching Object Analytics scenario on this camera, so added switched off. Pick its source event.';
		toast(msg + ' Press Save to keep them.', unmatched.length ? 'info' : 'ok');
	}

	document.addEventListener('DOMContentLoaded', function () {
		/* The UI kit: header with version, resource bar, camera facts and Live; installed apps every 5 s */
		Kit.start({ name: 'Data Bender', tabs: [{ id: 'rules', label: 'Rules' }, { id: 'settings', label: 'Settings' }] });
		table = Kit.items($('rules-table'), {
			noun: 'rule', nameLabel: 'Rule',
			columns: [{ label: 'Reactivation', width: '12%', cell: function (it) {
				var w = reOf(it.rule).wait;
				return '<span class="wait-chip' + (w ? '' : ' off') + '">' + Kit.esc(waitText(w)) + '</span>';
			} }],
			sub: function (it) { return ruleSummary(it.rule); },
			source: function (it) { return sourceOf(it.rule); },
			status: function (it) { return statusOf(it.rule); },
			onToggle: function (it, on) { it.rule.enabled = on; setDirty(true); },
			onTest: function (it) { testRule(it.rule); },
			onLog: function (it) { openLog(it.rule); },
			onEdit: function (it) { openRule(settings.rules.indexOf(it.rule)); },
			rowClick: true
		});
		foot = Kit.footer($('foot'), {
			onSave: save,
			onCancel: function () { loadSettings().then(function (ok) { if (ok) toast('Changes discarded.', 'info'); }); },
			savedText: false
		});
		setupLog();

		$('add-rule').addEventListener('click', function () {
			if (settings.rules.length >= MAX_RULES) return;
			settings.rules.push({ id: newId(), enabled: true, name: '', object: '', source: null });
			render(true);
			openRule(settings.rules.length - 1, true);
		});
		loadSettings();
		$('add-defaults').addEventListener('click', addDefaultRules);
		setupWorkflow();
		/* Copy settings to other cameras: after an import or undo the camera has new rules, so read them again
		   (unsaved changes on the Rules tab are replaced by them) */
		copy = Kit.configio(document.getElementById('copy'), { onDone: function () { reloadAfterImport(dirty); } });
		/* Before the panel's Apply or Undo: with unsaved rule changes, ask first. The kit's buttons are
		   .k-apply (import dialog) and .k-undo-b; a confirmed click is sent again and goes through. */
		var importConfirmed = false;
		document.addEventListener('click', function (e) {
			var b = e.target && e.target.closest ? e.target.closest('.k-apply, .k-undo-b') : null;
			if (!b || b.disabled || importConfirmed || !dirty) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			Kit.ask({ title: 'Unsaved rule changes will be replaced', text: 'The Rules tab has changes that are not saved. ' +
				(b.classList.contains('k-undo-b') ? 'Undoing the import' : 'Applying the import') + ' replaces them with the rules on the camera.', ok: 'Continue' })
				.then(function (yes) {
					if (!yes) return;
					importConfirmed = true;
					try { b.click(); } finally { importConfirmed = false; }
				});
		}, true);
		setupContextDialog();
		setupRuleDialog();

		Promise.all([listEvents(), loadAoaClasses()])
			.then(function (res) {
				events = res[0];
				eventsLoaded = true;
				/* Older rules: add the source's On/Off field and instance fields, sent on the next save */
				settings.rules.forEach(function (r) {
					var e = r.source && r.source.stateKey === undefined ? eventFor(r.source) : null;
					if (e) { var full = sourceFromEvent(e); r.source.stateful = full.stateful; r.source.stateKey = full.stateKey; r.source.sourceKeys = full.sourceKeys; }
				});
				var wasDirty = dirty;
				render();
				setDirty(wasDirty);
			})
			.catch(function (e) {
				eventsLoaded = true;
				toast('Could not list the camera\'s events: ' + e.message, 'bad');
			});

		refreshStatus();
		setInterval(refreshStatus, 2000);
		Kit.onApps(appsChanged);
	});
})();
