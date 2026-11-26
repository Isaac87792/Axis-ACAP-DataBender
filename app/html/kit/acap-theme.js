/*
 * acap-theme.js 1.4.0 - sets the page's light or dark theme before the first paint, so the page never flashes
 * the other theme. Load it first in <head>, before the style sheets:
 *     <script src="kit/acap-theme.js"></script>
 * Copy html/kit/ unchanged. The rule is the same as Kit.theme in acap-kit.js, which keeps it up to date after
 * that: the camera's own saved "theme" in browser storage ("dark" or "light", plain or JSON-quoted; the camera's
 * web page and this page are the same site), else "?theme=light" or "?theme=dark" in the address, else the
 * computer's light or dark setting. Apps have no theme switch of their own.
 */
(function () {
	'use strict';
	var ok = function (v) { return v === 'light' || v === 'dark'; };
	var t = null;
	try {
		var v = localStorage.getItem('theme');
		try { v = JSON.parse(v); } catch (e) { /* a plain word */ }
		if (ok(v)) t = v;
	} catch (e) { /* no storage */ }
	if (!t) { try { var q = new URLSearchParams(location.search).get('theme'); if (ok(q)) t = q; } catch (e) { /* no address */ } }
	if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
	document.documentElement.setAttribute('data-theme', t);
})();
