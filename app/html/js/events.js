/*
 * events.js - lists the events this camera can send, through VAPIX
 * (GetEventInstances). Each event is returned as a subscription
 * declaration: { name, label, topic0: {ns: value}, topic1: ..., path }.
 */

var RELAY_PACKAGE = 'data_bender';

function parseEventInstances(xmlString) {
	var doc = new DOMParser().parseFromString(xmlString, 'application/xml');
	if (doc.getElementsByTagName('parsererror').length) return [];
	var topicSet = doc.getElementsByTagName('wstop:TopicSet')[0];
	if (!topicSet) return [];

	var result = [];

	function walk(element, parentNs, topics, labels) {
		for (var i = 0; i < element.children.length; i++) {
			var child = element.children[i];
			var parts = child.tagName.split(':');
			var ns = parts.length === 2 ? parts[0] : parentNs;
			var tag = parts.length === 2 ? parts[1] : parts[0];
			var topic = {};
			topic[ns || ''] = tag;
			var niceName = child.getAttribute('aev:NiceName') || tag;
			var newTopics = topics.concat([topic]);
			/* The path shown under each event: only the parts the camera gives readable names */
			var newLabels = child.getAttribute('aev:NiceName') ? labels.concat([niceName]) : labels;

			if (child.getAttribute('wstop:topic') === 'true') {
				var ev = { name: niceName, label: (newLabels.length ? newLabels : [niceName]).join(' › '), path: '' };
				newTopics.forEach(function (t, index) { ev['topic' + index] = t; });
				ev.path = newTopics.map(function (t) { return Object.values(t)[0]; }).join('/');
				ev.meta = messageInfo(child);
				if (usable(ev, newTopics.length)) result.push(ev);
			}
			walk(child, ns, newTopics, newLabels);
		}
	}

	/* What the camera says about an event's fields:
	 * stateful (has an On/Off state), stateKey (the On/Off field),
	 * sources (fields naming the instance, e.g. port 1-64, heater 0/1, with their values),
	 * data (other field names, e.g. classTypes for Object Analytics) */
	function messageInfo(topicEl) {
		var info = { stateful: false, stateKey: '', stateNice: '', sources: [], data: [] };
		var msg = null;
		for (var i = 0; i < topicEl.children.length; i++)
			if (topicEl.children[i].tagName === 'aev:MessageInstance') { msg = topicEl.children[i]; break; }
		if (!msg) return info;
		info.stateful = msg.getAttribute('aev:isProperty') === 'true';
		for (var j = 0; j < msg.children.length; j++) {
			var part = msg.children[j];
			var items = part.getElementsByTagName('aev:SimpleItemInstance');
			for (var k = 0; k < items.length; k++) {
				var it = items[k];
				var name = it.getAttribute('Name');
				if (part.tagName === 'aev:SourceInstance') {
					var values = [];
					var vs = it.getElementsByTagName('aev:Value');
					for (var v = 0; v < vs.length; v++) values.push(vs[v].textContent);
					values.sort(function (a, b) { return (Number(a) - Number(b)) || a.localeCompare(b); });
					info.sources.push({ key: name, nice: it.getAttribute('aev:NiceName') || name, values: values });
				} else if (part.tagName === 'aev:DataInstance') {
					if (it.getAttribute('isPropertyState') === 'true') { info.stateKey = name; info.stateNice = it.getAttribute('aev:NiceName') || ''; }
					else info.data.push(name);
				}
			}
		}
		return info;
	}

	function usable(ev, depth) {
		// The relay can subscribe to four topic levels at most
		if (depth > 4) return false;
		var t0 = Object.values(ev.topic0 || {})[0];
		var t1 = Object.values(ev.topic1 || {})[0];
		// Never offer the relay's own events
		if (t0 === 'CameraApplicationPlatform' && t1 === RELAY_PACKAGE) return false;
		if (t0 === 'RecordingConfig' || t0 === 'MediaClip') return false;
		if (t1 === 'SystemMessage' || t1 === 'Log' || t1 === 'MQTT') return false;
		if (/xinternal/i.test(ev.path)) return false;
		return true;
	}

	walk(topicSet, null, [], []);

	// Object Analytics first, then the rest by name
	function rank(ev) { return /\/ObjectAnalytics\//.test(ev.path) ? 0 : 1; }
	result.sort(function (a, b) { return rank(a) - rank(b) || a.label.localeCompare(b.label); });
	return result;
}

function listEvents() {
	var body =
		'<?xml version="1.0" encoding="utf-8"?>' +
		'<soap:Envelope xmlns:aev="http://www.axis.com/vapix/ws/event1"' +
		' xmlns:soap="http://www.w3.org/2003/05/soap-envelope">' +
		'<soap:Body><aev:GetEventInstances/></soap:Body></soap:Envelope>';
	return fetch('/vapix/services', {
		method: 'POST',
		headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
		body: body
	})
		.then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
		.then(parseEventInstances);
}

function sourcePath(source) {
	if (!source) return '';
	var parts = [];
	for (var i = 0; i < 6; i++) {
		var t = source['topic' + i];
		if (!t) break;
		parts.push(Object.values(t)[0]);
	}
	return parts.join('/');
}
