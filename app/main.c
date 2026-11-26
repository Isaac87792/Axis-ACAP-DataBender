/*
 * Data Bender
 *
 * Subscribes to other apps' events (for example AXIS Object Analytics
 * scenarios) and sends its own stateful events with short names, so a VMS
 * can listen to "Person Detected" instead of the long original.
 *
 * Settings (settings/settings.json, saved to localdata/settings.json):
 *   rules[] - { id, enabled, name, object, source{name, topic0..topic3}, portTesting? }
 *   portTesting (1.6.0, optional) - { on, camera, game: pong|battleship|check, minutes, speed, encrypt,
 *                proto, port }: each time the rule fires, ask Port Testing on this camera to start that
 *                (see "Also do: Port Testing" below). Rules saved before 1.6.0 have none and load unchanged.
 *
 * The relay declares its events on its own event handler, not through the
 * ACAP.c wrapper, so settings can change at runtime without editing ACAP.c.
 *
 * Unsubscribing and undeclaring block for about 2 s each on AXIS OS 12, so a
 * save only touches the rules that changed, and shutdown skips them (the event
 * system drops a process's declarations and subscriptions when it exits).
 *
 * Copy settings to other cameras: the rules are one section of the UI kit's
 * configio endpoint (Rules_Get, Rules_Check, Rules_Apply below).
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <syslog.h>
#include <glib.h>
#include <glib-unix.h>
#include <gio/gio.h>
#include <curl/curl.h>
#include <signal.h>
#include <axsdk/axevent.h>
#include "ACAP.h"
#include "cJSON.h"
#include "context.h"
#include "kit.h"
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/resource.h>

#define APP_PACKAGE      "data_bender"
/* The On/Off field of every event Data Bender sends. "active", like AXIS Object Analytics and
 * Motion Detection, which VMSs such as Genetec already read. */
#define STATE_KEY        "active"
#define APP_NAME         "Data Bender"   /* the app's event group: a VMS shows it before each event name */
#define MAX_RULES        32
#define MAX_NAME_CHARS   64
#define MAX_OBJECT_CHARS 32
#define MAX_ID_LEN       24
#define PULSE_MS         1000
#define APPLY_DELAY_MS   300
/* Guards against slow leaks (the same three as Resource Monitor 1.0.1):
 * nothing that only grows, a memory self-limit, and a lower priority than the camera's own work. */
#define MAX_INSTANCES    256    /* source instances (ports, channels, tokens) a rule tracks as On */
#ifndef MEM_LIMIT_KB          /* a test build sets it below normal use (-DMEM_LIMIT_KB=512) to see the restart work */
#define MEM_LIMIT_KB     32768  /* about fifteen times normal use (about 2 MB): above it, the app restarts itself */
#endif
/* The self-limit check, the resources sample and the process list are the UI kit's (kit.h):
 * kit_limits() checks memory every minute and restarts the app after 3 checks over the limit. */

#define LOG(fmt, args...)      { syslog(LOG_INFO, fmt, ## args); printf(fmt, ## args); }
#define LOG_WARN(fmt, args...) { syslog(LOG_WARNING, fmt, ## args); printf(fmt, ## args); }

typedef struct {
	char   id[MAX_ID_LEN + 1];
	gchar* name;        /* name sent, e.g. "Person Detected" */
	gchar* filterKey;   /* field to filter on (classTypes, port, heater...), NULL = none */
	gchar* filterValue;
	int    filterContains; /* 1: field contains the value (object types); 0: field equals it (port 1) */
	gchar* stateKey;    /* the source's On/Off field, from the camera's event list; NULL = guess */
	int    stateless;   /* the source has no On/Off state: each event is a pulse */
	gchar** sourceKeys; /* fields naming the instance (port, heater...), NULL = guess */
	gchar* source;      /* source declaration as JSON text, to spot changes */
	int    enabled;
	int    mode;        /* MODE_BOTH, MODE_ON or MODE_OFF: which changes are sent */
	/* Dwell: the condition (source On, or Off for "Off only") must last this long before the rule fires */
	guint  dwell;       /* seconds; 0 = fire at once */
	guint  dwellTimer;
	gint64 dwellUntil;  /* monotonic time the dwell ends */
	gint64 dwellStart;
	gchar* dwellReceived;   /* the event that started the dwell, for the log */
	cJSON* lastEvent;  /* the last source event, for {field:name} in the Context */
	guint  declId;      /* 0 = not declared */
	int    declared;    /* declaration confirmed by the event system */
	int    subId;       /* 0 = not subscribed */
	cJSON* subData;     /* subscription declaration, passed as user_data */
	int    state;       /* wanted state */
	int    sentState;   /* last state sent, -1 = none yet */
	guint  pulseTimer;
	GHashTable* onInstances;  /* instances of the source that are On (port 1, channel 2...) */
	char   lastFired[32];
	char   activeSince[32];
	/* Context: text sent with each event, with {formulas} and a counter */
	gchar* ctxTemplate;  /* NULL or "" = no context */
	double ctrStart;
	double ctrStep;
	int    ctrReset;     /* 0 never, 1 every day at midnight, 2 every hour, 3 when the rule is saved */
	int    ctrEvery;     /* 1: count every source event; 0: count when the rule fires */
	double count;        /* last counter value used */
	long   ctrPeriod;    /* the day or hour the count belongs to */
	int    ctrStarted;
	gchar* ctxText;      /* context filled in for the event being sent */
	gchar* lastObject;   /* object types of the event being handled */
	gchar* lastSource;   /* source name of the event being handled */
	gchar* lastScenarioType;  /* scenarioType of the event being handled (Object Analytics) */
	gchar* lastObjectId;      /* objectId of the event being handled (Object Analytics) */
	char   topic[40];    /* event topic name, readable: "PersonDetected" */
	guint  triggerOffTimer;   /* On/Off trigger: the Off that follows the On */
	/* Reactivation threshold: after firing, wait before the rule can fire again */
	double rearmWait;    /* seconds; 0 = no wait */
	int    rearmFromOff; /* 1: the wait starts when the source turns Off, not when the event is sent */
	int    heldSend;     /* 1: when the wait ends, send one event if triggers were held back */
	gint64 rearmUntil;   /* monotonic time the wait ends; 0 = not waiting */
	int    waitingOff;   /* fired, and waiting for the source to turn Off before the wait starts */
	int    held;         /* triggers held back during the current wait */
	int    heldLast;     /* held back during the previous wait, for {held} */
	guint  rearmTimer;
	gchar* error;
	/* Also do: start a Port Testing match or check each time the rule fires */
	int    ptOn;
	gchar* ptCamera;      /* the device's name on Port Testing's Devices tab */
	char   ptGame[12];    /* pong, battleship or check */
	int    ptMinutes;     /* 1-15, matches only */
	char   ptSpeed[8];    /* slow, normal or fast (Pong) */
	int    ptEncrypt;     /* Battleship */
	char   ptProto[4];    /* tcp or udp (check) */
	int    ptPort;        /* 1-65535 (check); 0 = none */
	gchar* ptLast;        /* the last result, for the status */
	char   ptLastAt[32];
} Rule;

#define MODE_BOTH 0
#define MODE_ON   1
#define MODE_OFF  2

#define TEST_MS      3000
/* The log (what came in, what was sent) is the UI kit's: the last 100 lines, kept on storage */
static cJSON* savedCounters = NULL;   /* counters kept across restarts: localdata/counters.json */

static Rule*  rules[MAX_RULES];
static int    ruleCount = 0;
static AXEventHandler* relayHandler = NULL;
static GMainLoop* main_loop = NULL;
static gint   applyPending = 0;
/* The settings for the next apply: copied by the thread that changed them (the web thread, through
 * Settings_Updated_Callback), taken by apply_settings on the main loop. The main loop never reads
 * the wrapper's settings object, which the web thread changes. */
static GMutex settingsLock;
static cJSON* pendingSettings = NULL;   /* under settingsLock */
/* Subscription data of removed subscriptions: freed one save later, in case a
 * queued event for them is still delivered */
static GPtrArray* retired = NULL;
static GPtrArray* retiredOld = NULL;

/*-----------------------------------------------------
 * Text helpers
 *-----------------------------------------------------*/

/* Valid UTF-8, no control characters, trimmed, at most maxChars characters. */
static gchar* clean_text(const char* in, int maxChars) {
	if (!in) return g_strdup("");
	gchar* valid = g_utf8_make_valid(in, -1);
	for (gchar* p = valid; *p; p++)
		if ((unsigned char)*p < 0x20 || *p == 0x7f) *p = ' ';
	g_strstrip(valid);
	if (g_utf8_strlen(valid, -1) > maxChars) {
		gchar* cut = g_utf8_substring(valid, 0, maxChars);
		g_free(valid);
		valid = cut;
		g_strstrip(valid);
	}
	return valid;
}

/* Event topic keys must be simple names: a letter, then letters, digits or '_'. */
static int valid_id(const char* id) {
	if (!id || !*id || strlen(id) > MAX_ID_LEN || !isalpha((unsigned char)id[0])) return 0;
	for (const char* p = id; *p; p++)
		if (!isalnum((unsigned char)*p) && *p != '_') return 0;
	return 1;
}

static const char* json_string(cJSON* obj, const char* key) {
	cJSON* item = cJSON_GetObjectItem(obj, key);
	return cJSON_IsString(item) ? item->valuestring : NULL;
}

static int same_text(const char* a, const char* b) {
	return g_strcmp0(a ? a : "", b ? b : "") == 0;
}

/* The event name sent for a rule: its name. Free with g_free. */
static gchar* sent_name(const char* name) {
	return g_strdup(name);
}

/*-----------------------------------------------------
 * Status shown on the settings page
 *-----------------------------------------------------*/

static void publish_status(void) {
	cJSON* list = cJSON_CreateObject();
	for (int i = 0; i < ruleCount; i++) {
		Rule* r = rules[i];
		cJSON* s = cJSON_CreateObject();
		cJSON_AddBoolToObject(s, "active", r->sentState == 1);
		cJSON_AddBoolToObject(s, "declared", r->declared);
		cJSON_AddBoolToObject(s, "subscribed", r->subId > 0);
		cJSON_AddBoolToObject(s, "enabled", r->enabled);
		cJSON_AddStringToObject(s, "send", r->mode == MODE_ON ? "on" : r->mode == MODE_OFF ? "off" : "both");
		cJSON_AddBoolToObject(s, "sourceActive", r->state == 1);
		int waiting = (r->rearmUntil && g_get_monotonic_time() < r->rearmUntil) || r->waitingOff;
		cJSON_AddBoolToObject(s, "waiting", waiting);
		if (r->rearmUntil) cJSON_AddNumberToObject(s, "waitLeft", MAX(0, (r->rearmUntil - g_get_monotonic_time()) / 1000000));
		if (r->waitingOff) cJSON_AddTrueToObject(s, "waitingOff");
		if (r->dwellTimer) {
			cJSON_AddTrueToObject(s, "dwelling");
			cJSON_AddNumberToObject(s, "dwellLeft", MAX(0, (r->dwellUntil - g_get_monotonic_time()) / 1000000));
		}
		cJSON_AddStringToObject(s, "lastFired", r->lastFired);
		cJSON_AddStringToObject(s, "activeSince", r->sentState == 1 ? r->activeSince : "");
		if (r->error) cJSON_AddStringToObject(s, "error", r->error);
		if (r->ptLast) {
			cJSON_AddStringToObject(s, "portTesting", r->ptLast);
			cJSON_AddStringToObject(s, "portTestingAt", r->ptLastAt);
		}
		cJSON_AddItemToObject(list, r->id, s);
	}
	ACAP_STATUS_SetObject("relay", "rules", list);
	cJSON_Delete(list);
}

/* One line of the log: what came in, and what was sent out (sent = -1: nothing sent).
 * Written through the UI kit (kit_log_fields): the page's Rule column is the rule's name. */
static void log_activity(Rule* r, const char* received, int sent, const char* note) {
	cJSON* e = cJSON_CreateObject();
	cJSON_AddStringToObject(e, "rule", r->id);
	if (received) cJSON_AddStringToObject(e, "received", received);
	if (sent >= 0) {
		gchar* nameSent = sent_name(r->name ? r->name : r->id);
		gchar* full = nameSent;
		gchar* topic = g_strdup_printf("tnsaxis:CameraApplicationPlatform/%s/%s", APP_PACKAGE, r->topic[0] ? r->topic : r->id);
		cJSON_AddStringToObject(e, "sent", full);
		cJSON_AddStringToObject(e, "topic", topic);
		cJSON_AddStringToObject(e, "state", sent ? "On" : "Off");
		if (r->mode != MODE_BOTH) cJSON_AddTrueToObject(e, "trigger");
		g_free(full);
		g_free(topic);
	}
	if (note) cJSON_AddStringToObject(e, "note", note);
	if (sent >= 0 && r->ctxTemplate && *r->ctxTemplate && r->ctxText) cJSON_AddStringToObject(e, "context", r->ctxText);
	kit_log_fields(r->name && *r->name ? r->name : r->id, e, "");
	cJSON_Delete(e);
}

static void set_error(Rule* r, const char* message) {
	g_free(r->error);
	r->error = message ? g_strdup(message) : NULL;
}

/*-----------------------------------------------------
 * The relay's own events
 *-----------------------------------------------------*/

static Rule* find_rule(Rule** list, int count, const char* id) {
	if (!id) return NULL;
	for (int i = 0; i < count; i++)
		if (list[i] && strcmp(list[i]->id, id) == 0) return list[i];
	return NULL;
}

/*-----------------------------------------------------
 * Context: counter and filled-in text
 *-----------------------------------------------------*/

static long period_now(int reset) {
	time_t t = time(NULL);
	struct tm lt;
	localtime_r(&t, &lt);
	long day = (lt.tm_year + 1900) * 10000L + (lt.tm_mon + 1) * 100 + lt.tm_mday;
	if (reset == 1) return day;
	if (reset == 2) return day * 100 + lt.tm_hour;
	return 0;
}

static void save_counters(void) {
	cJSON* all = cJSON_CreateObject();
	for (int i = 0; i < ruleCount; i++) {
		Rule* r = rules[i];
		if (!r->ctrStarted) continue;
		cJSON* c = cJSON_CreateObject();
		cJSON_AddNumberToObject(c, "count", r->count);
		cJSON_AddNumberToObject(c, "period", r->ctrPeriod);
		cJSON_AddItemToObject(all, r->id, c);
	}
	ACAP_FILE_Write("localdata/counters.json", all);
	cJSON_Delete(all);
}

/* The counter value this event would use, without counting it yet */
static double counter_peek(Rule* r) {
	long p = period_now(r->ctrReset);
	if (!r->ctrStarted || ((r->ctrReset == 1 || r->ctrReset == 2) && p != r->ctrPeriod)) return r->ctrStart;
	return r->count + r->ctrStep;
}

static void counter_bump(Rule* r) {
	r->count = counter_peek(r);
	r->ctrPeriod = period_now(r->ctrReset);
	r->ctrStarted = 1;
	save_counters();
}

static gchar* item_text(cJSON* item);

static gchar* render_context(Rule* r, const char* tmpl, double count, const char* state) {
	const char* model = ACAP_DEVICE_Prop("model");
	const char* serial = ACAP_DEVICE_Prop("serial");
	const char* ip = ACAP_DEVICE_Prop("IPv4");
	const char* date = ACAP_DEVICE_Date();
	const char* time = ACAP_DEVICE_Time();
	const char* source = r->lastSource ? r->lastSource : "";
	CtxVar v[] = {
		{ "count", NULL, count, 1 },
		{ "time", time ? time : "", 0, 0 },
		{ "date", date ? date : "", 0, 0 },
		{ "camera", model ? model : "", 0, 0 },
		{ "serial", serial ? serial : "", 0, 0 },
		{ "ip", ip ? ip : "", 0, 0 },
		{ "rule", r->name ? r->name : r->id, 0, 0 },
		{ "source", source, 0, 0 },
		{ "scenario", source, 0, 0 },
		{ "object", r->lastObject ? r->lastObject : "", 0, 0 },
		{ "state", state, 0, 0 },
		{ "held", NULL, r->heldLast, 1 },
	};
	/* {field:name}: every field of the last source event */
	int nBase = (int)(sizeof(v) / sizeof(v[0]));
	GArray* all = g_array_new(FALSE, FALSE, sizeof(CtxVar));
	g_array_append_vals(all, v, nBase);
	GPtrArray* keep = g_ptr_array_new_with_free_func(g_free);
	for (cJSON* f = r->lastEvent ? r->lastEvent->child : NULL; f; f = f->next) {
		if (!f->string) continue;
		gchar* name = g_strdup_printf("field:%s", f->string);
		g_ptr_array_add(keep, name);
		CtxVar fv = { name, NULL, 0, 0 };
		if (cJSON_IsNumber(f)) { fv.num = f->valuedouble; fv.isNum = 1; }
		else {
			gchar* t = item_text(f);
			if (!t) continue;
			g_ptr_array_add(keep, t);
			fv.text = t;
		}
		g_array_append_val(all, fv);
	}
	gchar* out = ctx_render(tmpl, (CtxVar*)all->data, (int)all->len);
	g_array_free(all, TRUE);
	g_ptr_array_free(keep, TRUE);
	return out;
}

static int testing = 0;   /* 1 while a Test press sends: the event goes out, the counter does not move */

#define SENT    1   /* an event went out */
#define SKIPPED 2   /* the change is one this rule doesn't send (On only / Off only) */

/* Sends the rule's wanted state if it differs from the last one sent.
 * Returns 0 (nothing to do), SENT, or SKIPPED.
 * "On only" and "Off only" rules use a stateless event: one trigger per change
 * in that direction, nothing for the other direction. */
#define HELD    3   /* held back: the rule is waiting before it can fire again */
static int bypassWait = 0;   /* 1 while sending the one held-back event at the end of a wait */
static int fire_now(Rule* r, int isTest, const char* received, const char* note);
static void pt_fire(Rule* r);   /* Also do: Port Testing (below) */

static int rearm_active(Rule* r) {
	return (r->rearmUntil && g_get_monotonic_time() < r->rearmUntil) || r->waitingOff;
}

static void stop_wait(Rule* r) {
	if (r->rearmTimer) { g_source_remove(r->rearmTimer); r->rearmTimer = 0; }
	r->rearmUntil = 0;
	r->waitingOff = 0;
	r->held = 0;
}

static gboolean rearm_end(gpointer user_data) {
	Rule* r = (Rule*)user_data;
	r->rearmTimer = 0;
	r->rearmUntil = 0;
	int h = r->held;
	r->heldLast = h;
	r->held = 0;
	if (r->heldSend && h > 0 && r->enabled) {
		gchar* note = g_strdup_printf("Wait over: sent one event for %d trigger%s held back", h, h == 1 ? "" : "s");
		fire_now(r, 0, "Reactivation wait ended", note);
		g_free(note);
	}
	publish_status();
	return G_SOURCE_REMOVE;
}

static void begin_wait(Rule* r) {
	if (r->rearmTimer) g_source_remove(r->rearmTimer);
	r->waitingOff = 0;
	r->held = 0;
	r->rearmUntil = g_get_monotonic_time() + (gint64)(r->rearmWait * 1000000);
	guint ms = (guint)MIN(r->rearmWait * 1000, 86400000.0);
	r->rearmTimer = g_timeout_add(ms ? ms : 1, rearm_end, r);
}

/* After the rule fired: start the wait now, or once the source turns Off */
static void start_wait(Rule* r) {
	if (r->rearmWait <= 0) return;
	int sourceOn = (r->onInstances && g_hash_table_size(r->onInstances) > 0) ? 1 : 0;
	if (r->rearmFromOff && sourceOn) { r->waitingOff = 1; r->held = 0; }
	else begin_wait(r);
}

/* Sends one event with the given On/Off value: active, plus context when the rule has one.
 * Declared like AXIS Object Analytics (stateful, active as the only state). */
static int send_event(Rule* r, int value) {
	AXEventKeyValueSet* set = ax_event_key_value_set_new();
	ax_event_key_value_set_add_key_value(set, STATE_KEY, NULL, &value, AX_VALUE_TYPE_BOOL, NULL);
	if (r->ctxTemplate && *r->ctxTemplate)
		ax_event_key_value_set_add_key_value(set, "context", NULL, r->ctxText ? r->ctxText : "", AX_VALUE_TYPE_STRING, NULL);
	AXEvent* ev = ax_event_new2(set, NULL);
	ax_event_key_value_set_free(set);
	GError* err = NULL;
	int ok = ax_event_handler_send_event(relayHandler, r->declId, ev, &err) ? 1 : 0;
	if (!ok) {
		LOG_WARN("Rule %s: could not send event: %s\n", r->id, err ? err->message : "unknown");
		if (err) g_error_free(err);
	}
	ax_event_free(ev);
	return ok;
}

/* On/Off triggers (Condition On or Off): the event goes On, then Off a moment later */
static gboolean trigger_off(gpointer user_data) {
	Rule* r = (Rule*)user_data;
	r->triggerOffTimer = 0;
	send_event(r, 0);
	return G_SOURCE_REMOVE;
}

/* Sends the rule's wanted state if it differs from the last one sent.
 * Returns 0 (nothing to do), SENT, or SKIPPED.
 * Condition "On and Off": the event follows the source. Condition "On" or "Off": each change in
 * that direction sends a short On then Off (like Object Analytics), the other direction nothing. */
static int send_state(Rule* r) {
	if (!r->declId || !r->declared || r->sentState == r->state) return 0;
	if (r->state) g_strlcpy(r->activeSince, ACAP_DEVICE_ISOTime(), sizeof(r->activeSince));
	if ((r->mode == MODE_ON && !r->state) || (r->mode == MODE_OFF && r->state)) {
		r->sentState = r->state;
		publish_status();
		return SKIPPED;
	}

	/* The rule "fires" on a trigger, or when an On + Off rule turns On. Announcing the state
	 * after publishing the event (sentState -1) is not a firing. */
	int fires = r->sentState != -1 && (r->mode != MODE_BOTH || r->state);

	/* Reactivation threshold: while waiting, a firing is held back (an Off that follows is then
	 * not sent either, because the On never went out) */
	if (fires && !testing && !bypassWait && rearm_active(r)) {
		r->held++;
		if (r->mode != MODE_BOTH) r->sentState = r->state;
		publish_status();
		return HELD;
	}

	if (r->ctxTemplate && *r->ctxTemplate) {
		if (fires && !r->ctrEvery && !testing) counter_bump(r);
		g_free(r->ctxText);
		r->ctxText = render_context(r, r->ctxTemplate, testing ? counter_peek(r) : (r->ctrStarted ? r->count : r->ctrStart), r->state ? "On" : "Off");
	}

	int ok;
	if (r->mode == MODE_BOTH) {
		ok = send_event(r, r->state ? 1 : 0);
	} else {
		if (r->triggerOffTimer) { g_source_remove(r->triggerOffTimer); r->triggerOffTimer = 0; }
		ok = send_event(r, 1);
		if (ok) r->triggerOffTimer = g_timeout_add(PULSE_MS, trigger_off, r);
	}
	int sent = 0;
	if (ok) {
		r->sentState = r->state;
		set_error(r, NULL);
		sent = SENT;
		if (fires && !testing) start_wait(r);
		/* Also do: the rule fired (a Test press too), so start Port Testing's match or check. A held-back
		 * firing returned above, so the reactivation wait applies to it as to the event. */
		if (fires) pt_fire(r);
	} else {
		set_error(r, "Could not send the event");
	}
	publish_status();
	return sent;
}

static void declaration_complete(guint declaration, gpointer user_data) {
	(void)user_data;
	for (int i = 0; i < ruleCount; i++) {
		Rule* r = rules[i];
		if (r->declId == declaration) {
			r->declared = 1;
			if (r->mode != MODE_BOTH) {
				/* A trigger rests at Off between triggers: announce that, don't fire */
				send_event(r, 0);
				r->sentState = r->state;
				log_activity(r, NULL, -1, r->mode == MODE_ON
				             ? "Event published (On only: a trigger each time the source turns On)"
				             : "Event published (Off only: a trigger each time the source turns Off)");
				publish_status();
				return;
			}
			/* Announce the current state, so subscribers know it */
			r->sentState = -1;
			if (send_state(r) == SENT)
				log_activity(r, NULL, r->sentState, "Event published; current state announced to subscribers");
			return;
		}
	}
}

static void declare_rule(Rule* r) {
	AXEventKeyValueSet* set = ax_event_key_value_set_new();
	int initial = r->state ? 1 : 0;

	ax_event_key_value_set_add_key_value(set, "topic0", "tnsaxis", "CameraApplicationPlatform", AX_VALUE_TYPE_STRING, NULL);
	ax_event_key_value_set_add_key_value(set, "topic1", "tnsaxis", APP_PACKAGE, AX_VALUE_TYPE_STRING, NULL);
	/* The app's topic level shows the app's name, so a VMS lists the events under "Data Bender",
	 * not the internal ID data_bender (Genetec also uses it as the app's label) */
	ax_event_key_value_set_add_nice_names(set, "topic1", "tnsaxis", APP_PACKAGE, APP_NAME, NULL);
	const char* topic = r->topic[0] ? r->topic : r->id;
	ax_event_key_value_set_add_key_value(set, "topic2", "tnsaxis", topic, AX_VALUE_TYPE_STRING, NULL);
	gchar* nameSent = sent_name(r->name);
	ax_event_key_value_set_add_nice_names(set, "topic2", "tnsaxis", topic, nameSent, NULL);
	g_free(nameSent);
	ax_event_key_value_set_add_key_value(set, STATE_KEY, NULL, &initial, AX_VALUE_TYPE_BOOL, NULL);
	ax_event_key_value_set_mark_as_data(set, STATE_KEY, NULL, NULL);
	/* Only the Context is sent as extra data: a VMS such as Genetec shows every data field
	 * except the state in its event description (Description = only the Context) */
	if (r->ctxTemplate && *r->ctxTemplate) {
		ax_event_key_value_set_add_key_value(set, "context", NULL, "", AX_VALUE_TYPE_STRING, NULL);
		ax_event_key_value_set_add_nice_names(set, "context", NULL, "Context", NULL, NULL);
		ax_event_key_value_set_mark_as_data(set, "context", NULL, NULL);
	}

	GError* err = NULL;
	guint id = 0;
	r->declared = 0;
	/* Always a stateful (property) event, like Object Analytics, with "active" as its only state;
	 * the other fields are data that comes with it */
	if (ax_event_handler_declare2(relayHandler, set, FALSE, (gchar*)STATE_KEY, &id, declaration_complete, NULL, &err)) {
		r->declId = id;
	} else {
		r->declId = 0;
		LOG_WARN("Rule %s: could not declare event: %s\n", r->id, err ? err->message : "unknown");
		set_error(r, "Could not declare the event");
		if (err) g_error_free(err);
	}
	ax_event_key_value_set_free(set);
}

static void undeclare_rule(Rule* r) {
	if (r->triggerOffTimer) { g_source_remove(r->triggerOffTimer); r->triggerOffTimer = 0; }
	if (!r->declId) return;
	ax_event_handler_undeclare(relayHandler, r->declId, NULL);
	r->declId = 0;
	r->declared = 0;
	r->sentState = -1;
}

static void stop_dwell(Rule* r) {
	if (r->dwellTimer) g_source_remove(r->dwellTimer);
	r->dwellTimer = 0;
	r->dwellUntil = 0;
}

/* The rule's settled state: while a dwell runs, the condition has not taken effect yet */
static int settled_state(Rule* r) {
	int raw = (r->onInstances && g_hash_table_size(r->onInstances) > 0) ? 1 : 0;
	return r->dwellTimer ? !raw : raw;
}

static void unsubscribe_rule(Rule* r) {
	stop_dwell(r);
	if (r->subId) ACAP_EVENTS_Unsubscribe(r->subId);
	r->subId = 0;
	if (r->onInstances) g_hash_table_remove_all(r->onInstances);
	if (r->subData) g_ptr_array_add(retired, r->subData);
	r->subData = NULL;
}

static gboolean pulse_off(gpointer user_data) {
	Rule* r = (Rule*)user_data;
	r->pulseTimer = 0;
	r->state = settled_state(r);
	if (r->waitingOff && !r->state) begin_wait(r);
	if (send_state(r) == SENT)
		log_activity(r, NULL, r->sentState, "Back to Off after a pulse or test");
	return G_SOURCE_REMOVE;
}

static void free_rule(Rule* r) {
	if (r->lastEvent) cJSON_Delete(r->lastEvent);
	if (r->dwellTimer) g_source_remove(r->dwellTimer);
	g_free(r->dwellReceived);
	if (r->rearmTimer) g_source_remove(r->rearmTimer);
	if (r->triggerOffTimer) g_source_remove(r->triggerOffTimer);
	g_free(r->lastScenarioType);
	g_free(r->lastObjectId);
	g_free(r->ctxTemplate);
	g_free(r->ctxText);
	g_free(r->lastObject);
	g_free(r->lastSource);
	if (r->pulseTimer) g_source_remove(r->pulseTimer);
	if (r->subData) g_ptr_array_add(retired, r->subData);
	if (r->onInstances) g_hash_table_destroy(r->onInstances);
	g_free(r->name);
	g_free(r->filterKey);
	g_free(r->filterValue);
	g_free(r->stateKey);
	g_strfreev(r->sourceKeys);
	g_free(r->source);
	g_free(r->error);
	g_free(r->ptCamera);
	g_free(r->ptLast);
	g_free(r);
}

/*-----------------------------------------------------
 * Incoming events
 *-----------------------------------------------------*/

static int item_true(cJSON* item) {
	if (cJSON_IsBool(item)) return cJSON_IsTrue(item) ? 1 : 0;
	if (cJSON_IsNumber(item)) return item->valueint ? 1 : 0;
	if (cJSON_IsString(item))
		return (strcmp(item->valuestring, "1") == 0 || g_ascii_strcasecmp(item->valuestring, "true") == 0) ? 1 : 0;
	return 1;
}

/* A field's value as text, for filters and the log. NULL if the event doesn't have it. */
static gchar* item_text(cJSON* item) {
	if (cJSON_IsString(item)) return g_strdup(item->valuestring);
	if (cJSON_IsNumber(item)) return g_strdup_printf("%g", item->valuedouble);
	if (cJSON_IsBool(item)) return g_strdup(cJSON_IsTrue(item) ? "1" : "0");
	return NULL;
}

/* Reads the On/Off state from an incoming event. *found = 0 for events with no state (pulses).
 * Uses the source's own On/Off field when the camera told us which one it is. */
static int event_state(Rule* r, cJSON* event, int* found) {
	*found = 0;
	if (r->stateKey && *r->stateKey) {
		cJSON* item = cJSON_GetObjectItem(event, r->stateKey);
		if (!item) return 1;
		*found = 1;
		return item_true(item);
	}
	if (r->stateless) return 1;
	static const char* names[] = {
		"running", "active", "state", "triggered", "LogicalState", "ready", "Open", "lost",
		"Detected", "recording", "accessed", "connected", "day", "sensor_level",
		"disruption", "alert", "fan_failure", "Failed", "limit_exceeded",
		"abr_error", "tampering", "signal_status_ok", "Playing", NULL
	};
	for (int i = 0; names[i]; i++) {
		cJSON* item = cJSON_GetObjectItem(event, names[i]);
		if (!item) continue;
		*found = 1;
		return item_true(item);
	}
	return 1;
}

/* Which instance of the source an event is about. One topic can cover many
 * instances (virtual input ports 1-64, video channels...); the rule is On while
 * any of them is On. Sources without these keys have a single instance. */
static gchar* event_instance(Rule* r, cJSON* event) {
	static const char* guess[] = {
		"port", "channel", "heater", "VideoSource", "VideoSourceToken", "VideoSourceConfigurationToken",
		"InputToken", "RelayToken", "Token", NULL
	};
	const char* const* keys = (r->sourceKeys && r->sourceKeys[0]) ? (const char* const*)r->sourceKeys : guess;
	GString* s = g_string_new("");
	for (int i = 0; keys[i]; i++) {
		cJSON* item = cJSON_GetObjectItem(event, keys[i]);
		if (cJSON_IsString(item)) g_string_append_printf(s, "%s=%s;", keys[i], item->valuestring);
		else if (cJSON_IsNumber(item)) g_string_append_printf(s, "%s=%g;", keys[i], item->valuedouble);
	}
	return g_string_free(s, FALSE);
}

/* "30 s", "5 min", "2 h", "1 d" */
static const char* duration_text(guint sec, char* buf) {   /* buf: 32 bytes */
	if (sec && sec % 86400 == 0) g_snprintf(buf, 32, "%u d", sec / 86400);
	else if (sec && sec % 3600 == 0) g_snprintf(buf, 32, "%u h", sec / 3600);
	else if (sec && sec % 60 == 0) g_snprintf(buf, 32, "%u min", sec / 60);
	else g_snprintf(buf, 32, "%u s", sec);
	return buf;
}

/* The condition lasted the dwell time: the rule acts on it now */
static gboolean dwell_end(gpointer user_data) {
	Rule* r = (Rule*)user_data;
	r->dwellTimer = 0;
	r->dwellUntil = 0;
	if (!r->enabled) return G_SOURCE_REMOVE;
	r->state = (r->onInstances && g_hash_table_size(r->onInstances) > 0) ? 1 : 0;
	if (r->waitingOff && !r->state) begin_wait(r);
	int sent = send_state(r);
	char b1[32];
	gchar* note = g_strdup_printf("Condition lasted %s: %s", duration_text(r->dwell, b1),
		sent == SENT ? (r->mode == MODE_BOTH ? "sent" : "trigger sent") : sent == HELD ? "held back, waiting before it can fire again" : "nothing new to send");
	log_activity(r, r->dwellReceived, sent == SENT ? r->sentState : -1, note);
	g_free(note);
	publish_status();
	return G_SOURCE_REMOVE;
}

static void Event_Callback(cJSON* event, void* user_data) {
	Rule* r = find_rule(rules, ruleCount, json_string((cJSON*)user_data, "rid"));
	if (!r || !r->enabled || r->subData != user_data) return;

	int found = 0;
	int on = event_state(r, event, &found);

	/* Exact filter (port 1, heater 0): other instances are not this rule's business */
	if (r->filterKey && !r->filterContains) {
		gchar* v = item_text(cJSON_GetObjectItem(event, r->filterKey));
		int match = v && g_strcmp0(v, r->filterValue) == 0;
		g_free(v);
		if (!match) return;
	}

	gchar* instance = event_instance(r, event);
	const char* sourceName = json_string((cJSON*)user_data, "name");
	gchar* inst = g_strdup(instance);   /* "port=1;" -> "port=1" */
	size_t instLen = strlen(inst);
	if (instLen && inst[instLen - 1] == ';') inst[instLen - 1] = '\0';
	g_strdelimit(inst, ";", ',');
	gchar* received = *inst ? g_strdup_printf("%s (%s)", sourceName ? sourceName : "Source event", inst)
	                        : g_strdup(sourceName ? sourceName : "Source event");
	g_free(inst);
	gchar* receivedText = g_strdup_printf("%s: %s", received, found ? (on ? "active" : "inactive") : "triggered");
	g_free(received);

	/* Object filter (contains): only for "On"; "Off" always clears the rule's event */
	if (on && r->filterKey && r->filterContains) {
		const char* classes = json_string(event, r->filterKey);
		if (classes && *classes && !strcasestr(classes, r->filterValue)) {
			gchar* note = g_strdup_printf("Ignored: object is \"%s\", this rule only relays \"%s\"", classes, r->filterValue);
			log_activity(r, receivedText, -1, note);
			g_free(note);
			g_free(instance);
			g_free(receivedText);
			return;
		}
	}

	if (on) g_strlcpy(r->lastFired, ACAP_DEVICE_ISOTime(), sizeof(r->lastFired));

	/* For the context: what this event is about */
	g_free(r->lastObject);
	r->lastObject = g_strdup(json_string(event, "classTypes") ? json_string(event, "classTypes") : "");
	g_free(r->lastSource);
	r->lastSource = g_strdup(sourceName ? sourceName : "");
	g_free(r->lastScenarioType);
	r->lastScenarioType = g_strdup(json_string(event, "scenarioType") ? json_string(event, "scenarioType") : "");
	g_free(r->lastObjectId);
	r->lastObjectId = item_text(cJSON_GetObjectItem(event, "objectId"));
	if (r->lastEvent) cJSON_Delete(r->lastEvent);
	r->lastEvent = cJSON_Duplicate(event, 1);
	if (r->ctxTemplate && *r->ctxTemplate && r->ctrEvery) counter_bump(r);

	int sent = 0;
	if (found) {
		if (!r->onInstances)
			r->onInstances = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
		/* Instances whose Off never comes (a token that changes each time) would pile up:
		 * past MAX_INSTANCES the list starts again from this event */
		if (on && g_hash_table_size(r->onInstances) >= MAX_INSTANCES && !g_hash_table_contains(r->onInstances, instance)) {
			g_hash_table_remove_all(r->onInstances);
			log_activity(r, receivedText, -1, "Over " G_STRINGIFY(MAX_INSTANCES) " source instances On at once: the list was cleared and starts again from this one");
		}
		if (on) { g_hash_table_add(r->onInstances, instance); instance = NULL; }
		else g_hash_table_remove(r->onInstances, instance);
		int raw = g_hash_table_size(r->onInstances) > 0;
		int cond = r->mode == MODE_OFF ? !raw : raw;   /* the condition this rule acts on */
		if (r->dwell && cond && r->state != raw) {
			/* Condition met: it must last the dwell time before the rule acts on it */
			if (!r->dwellTimer) {
				r->dwellStart = g_get_monotonic_time();
				r->dwellUntil = r->dwellStart + (gint64)r->dwell * 1000000;
				r->dwellTimer = g_timeout_add_seconds(r->dwell, dwell_end, r);
				g_free(r->dwellReceived);
				r->dwellReceived = g_strdup(receivedText);
				char b1[32];
				gchar* note = g_strdup_printf("Condition met: sends if it lasts %s", duration_text(r->dwell, b1));
				log_activity(r, receivedText, -1, note);
				g_free(note);
			}
			g_free(instance);
			g_free(receivedText);
			publish_status();
			return;
		}
		if (r->dwellTimer && !cond) {
			gint64 lasted = (g_get_monotonic_time() - r->dwellStart) / 1000000;
			stop_dwell(r);
			char b1[32], b2[32];
			gchar* note = g_strdup_printf("Condition ended after %s, before the %s dwell: nothing sent", duration_text((guint)lasted, b1), duration_text(r->dwell, b2));
			log_activity(r, receivedText, -1, note);
			g_free(note);
			r->state = raw;
			g_free(instance);
			g_free(receivedText);
			publish_status();
			return;
		}
		r->state = raw;
		if (r->waitingOff && !r->state) begin_wait(r);
		sent = send_state(r);
		if (sent == SENT) log_activity(r, receivedText, r->sentState, r->mode == MODE_BOTH ? NULL : r->mode == MODE_ON ? "On only: trigger sent" : "Off only: trigger sent");
		else if (sent == SKIPPED) log_activity(r, receivedText, -1, r->mode == MODE_ON ? "Off not sent: this rule sends On only" : "On not sent: this rule sends Off only");
		else if (sent == HELD) log_activity(r, receivedText, -1, rearm_active(r) && r->waitingOff ? "Held back: the rule waits for the source to turn Off, then for its reactivation time" : "Held back: waiting before it can fire again");
		else if (on) log_activity(r, receivedText, -1, "Already On: nothing new to send");
		/* An Off that changes nothing (other instances, start-up) is not listed */
	} else if (on) {
		/* Source has no state: send a short On pulse */
		r->state = 1;
		sent = send_state(r);
		log_activity(r, receivedText, sent == SENT ? r->sentState : -1,
		             sent == SKIPPED ? "On not sent: this rule sends Off only (Off follows in 1 s)" : sent == HELD ? "Held back: waiting before it can fire again" : sent != SENT ? "Already On" : r->mode == MODE_ON ? "On only: trigger sent" : "Source has no On/Off state: sending a 1 s pulse");
		if (r->pulseTimer) g_source_remove(r->pulseTimer);
		r->pulseTimer = g_timeout_add(PULSE_MS, pulse_off, r);
	}
	g_free(instance);
	g_free(receivedText);
	publish_status();
}

/*-----------------------------------------------------
 * Settings page endpoints: test and context preview
 *-----------------------------------------------------*/

/* Sends the rule's own event straight out, as the rule would: On + Off: On, then Off a moment
 * later. On only: one trigger. Off only: one Off trigger. The source app is never triggered.
 * isTest: Test button (the counter does not move, no wait starts). */
static int fire_now(Rule* r, int isTest, const char* received, const char* note) {
	if (!r->enabled || !r->declId || !r->declared) return 0;
	int sourceOn = settled_state(r);
	testing = isTest;
	bypassWait = 1;
	if (r->pulseTimer) { g_source_remove(r->pulseTimer); r->pulseTimer = 0; }
	int sent;
	if (r->mode == MODE_OFF) {
		r->sentState = 1;          /* make the Off a change, so it goes out */
		r->state = 0;
		sent = send_state(r);
		log_activity(r, received, sent == SENT ? 0 : -1, sent == SENT ? note : "Could not send the event");
		r->state = sourceOn;       /* back to the source's real state */
		r->sentState = sourceOn;
	} else {
		r->sentState = 0;          /* make the On a change, so it goes out */
		r->state = 1;
		sent = send_state(r);
		log_activity(r, received, sent == SENT ? 1 : -1, sent == SENT ? note : "Could not send the event");
		if (r->mode == MODE_BOTH) {
			r->pulseTimer = g_timeout_add(isTest ? TEST_MS : PULSE_MS, pulse_off, r);   /* then back to the source's real state */
		} else {
			r->state = sourceOn;
			r->sentState = sourceOn;
		}
	}
	testing = 0;
	bypassWait = 0;
	publish_status();
	return sent;
}

/* Runs on the main loop: the Test button */
static gboolean run_test(gpointer user_data) {
	gchar* id = (gchar*)user_data;
	Rule* r = find_rule(rules, ruleCount, id);
	if (r && r->enabled && r->declId && r->declared) {
		fire_now(r, 1, "Test button", r->mode == MODE_OFF ? "Test: Off trigger sent" : r->mode == MODE_ON ? "Test: trigger sent" : "Test: On sent; Off follows in 3 seconds");
	} else if (r) {
		log_activity(r, "Test button", -1, !r->enabled ? "Test: the rule is switched off" : "Test: the rule's event is not published yet");
	}
	g_free(id);
	return G_SOURCE_REMOVE;
}

/* POST {"id":"<rule id>"}, JSON only: another web site can't send this from a form or a link */
static void HTTP_Endpoint_test(const ACAP_HTTP_Response response, const ACAP_HTTP_Request request) {
	const char* method = ACAP_HTTP_Get_Method(request);
	const char* type = ACAP_HTTP_Get_Content_Type(request);
	if (!method || strcmp(method, "POST") != 0 || !type || !strstr(type, "application/json")) {
		ACAP_HTTP_Respond_Error(response, 405, "Use POST with JSON");
		return;
	}
	const char* body = ACAP_HTTP_Get_Body(request);
	cJSON* in = body ? cJSON_ParseWithLength(body, ACAP_HTTP_Get_Body_Length(request)) : NULL;
	const char* id = in ? json_string(in, "id") : NULL;
	if (!valid_id(id)) {
		cJSON_Delete(in);
		ACAP_HTTP_Respond_Error(response, 400, "Missing or invalid rule id");
		return;
	}
	g_idle_add(run_test, g_strdup(id));
	cJSON_Delete(in);
	ACAP_HTTP_Respond_Text(response, "Test started");
}

/* POST { id, context: { text, start, step, ... } }: what the next event would carry, for the popup */
static void HTTP_Endpoint_preview(const ACAP_HTTP_Response response, const ACAP_HTTP_Request request) {
	const char* body = ACAP_HTTP_Get_Body(request);
	cJSON* in = body ? cJSON_Parse(body) : NULL;
	if (!in) { ACAP_HTTP_Respond_Error(response, 400, "Expected JSON"); return; }
	cJSON* ctx = cJSON_GetObjectItem(in, "context");
	const char* text = cJSON_IsObject(ctx) ? json_string(ctx, "text") : NULL;
	double start = 1;
	cJSON* n = cJSON_IsObject(ctx) ? cJSON_GetObjectItem(ctx, "start") : NULL;
	if (cJSON_IsNumber(n)) start = n->valuedouble;

	Rule tmp = { 0 };
	Rule* r = find_rule(rules, ruleCount, json_string(in, "id"));
	if (!r) {
		g_strlcpy(tmp.id, "preview", sizeof(tmp.id));
		tmp.name = (gchar*)(json_string(in, "name") ? json_string(in, "name") : "");
		tmp.ctrStart = start;
		r = &tmp;
	}
	double count = r == &tmp ? start : counter_peek(r);
	gchar* out = render_context(r, text ? text : "", count, "On");
	cJSON* res = cJSON_CreateObject();
	cJSON_AddStringToObject(res, "text", out);
	cJSON_AddNumberToObject(res, "count", count);
	ACAP_HTTP_Respond_JSON(response, res);
	cJSON_Delete(res);
	g_free(out);
	cJSON_Delete(in);
}

/*-----------------------------------------------------
 * Applying settings
 *-----------------------------------------------------*/

/* A source is a subscription declaration: { name, topic0: {ns: value}, ... } */
static cJSON* make_subscription(cJSON* source, const char* rid) {
	if (!cJSON_IsObject(source)) return NULL;
	cJSON* t0 = cJSON_GetObjectItem(source, "topic0");
	if (!cJSON_IsObject(t0) || !t0->child || !cJSON_IsString(t0->child)) return NULL;

	/* Never listen to our own events */
	cJSON* t1 = cJSON_GetObjectItem(source, "topic1");
	if (strcmp(t0->child->valuestring, "CameraApplicationPlatform") == 0 &&
	    cJSON_IsObject(t1) && t1->child && cJSON_IsString(t1->child) &&
	    strcmp(t1->child->valuestring, APP_PACKAGE) == 0)
		return NULL;

	cJSON* sub = cJSON_CreateObject();
	const char* name = json_string(source, "name");
	cJSON_AddStringToObject(sub, "name", (name && *name) ? name : rid);
	const char* keys[] = { "topic0", "topic1", "topic2", "topic3" };
	for (int i = 0; i < 4; i++) {
		cJSON* t = cJSON_GetObjectItem(source, keys[i]);
		if (!t) break;
		if (!cJSON_IsObject(t) || !t->child || !cJSON_IsString(t->child)) {
			cJSON_Delete(sub);
			return NULL;
		}
		cJSON_AddItemToObject(sub, keys[i], cJSON_Duplicate(t, 1));
	}
	cJSON_AddStringToObject(sub, "rid", rid);
	return sub;
}

/* The source's topics as text: only these decide whether to subscribe again */
static gchar* source_key(cJSON* source) {
	GString* s = g_string_new("");
	const char* keys[] = { "topic0", "topic1", "topic2", "topic3" };
	for (int i = 0; cJSON_IsObject(source) && i < 4; i++) {
		cJSON* t = cJSON_GetObjectItem(source, keys[i]);
		if (!cJSON_IsObject(t) || !t->child || !cJSON_IsString(t->child)) break;
		g_string_append_printf(s, "%s:%s/", t->child->string, t->child->valuestring);
	}
	return g_string_free(s, FALSE);
}

/* Event topic name from the rule's name: letters and digits, e.g. "PersonDetected". Must start
 * with a letter and be unique among the rules; falls back to the rule id. */
static void make_topic(Rule* r, Rule** others, int count) {
	char base[33] = "";
	int n = 0, up = 1;
	for (const char* p = r->name ? r->name : ""; *p && n < 32; p++) {
		unsigned char c = (unsigned char)*p;
		if (isalnum(c) && c < 128) { base[n++] = up ? (char)toupper(c) : (char)c; up = 0; }
		else up = 1;
	}
	base[n] = '\0';
	if (!n || !isalpha((unsigned char)base[0])) { g_strlcpy(r->topic, r->id, sizeof(r->topic)); return; }
	for (int k = 1; k < 100; k++) {
		char cand[40];
		if (k == 1) g_strlcpy(cand, base, sizeof(cand)); else g_snprintf(cand, sizeof(cand), "%s%d", base, k);
		int used = 0;
		for (int i = 0; i < count; i++) if (others[i] && others[i] != r && strcmp(others[i]->topic, cand) == 0) used = 1;
		if (!used) { g_strlcpy(r->topic, cand, sizeof(r->topic)); return; }
	}
	g_strlcpy(r->topic, r->id, sizeof(r->topic));
}

/* A rule's "portTesting" (Also do): kept off unless it is switched on and names a device. Values out of
 * range are brought into it; Port Testing checks them again and says why when it can't start. */
static void pt_read(Rule* r, cJSON* pt) {
	g_free(r->ptCamera);
	r->ptCamera = NULL;
	r->ptOn = 0;
	if (!cJSON_IsObject(pt)) return;
	const char* g = json_string(pt, "game");
	g_strlcpy(r->ptGame, same_text(g, "battleship") ? "battleship" : same_text(g, "check") ? "check" : "pong", sizeof(r->ptGame));
	r->ptCamera = clean_text(json_string(pt, "camera"), MAX_NAME_CHARS);
	cJSON* n = cJSON_GetObjectItem(pt, "minutes");
	r->ptMinutes = cJSON_IsNumber(n) ? CLAMP((int)n->valuedouble, 1, 15) : 2;
	const char* s = json_string(pt, "speed");
	g_strlcpy(r->ptSpeed, same_text(s, "fast") ? "fast" : same_text(s, "slow") ? "slow" : "normal", sizeof(r->ptSpeed));
	r->ptEncrypt = cJSON_IsTrue(cJSON_GetObjectItem(pt, "encrypt"));
	g_strlcpy(r->ptProto, same_text(json_string(pt, "proto"), "udp") ? "udp" : "tcp", sizeof(r->ptProto));
	n = cJSON_GetObjectItem(pt, "port");
	r->ptPort = cJSON_IsNumber(n) && n->valuedouble >= 1 && n->valuedouble <= 65535 ? (int)n->valuedouble : 0;
	r->ptOn = cJSON_IsTrue(cJSON_GetObjectItem(pt, "on")) && *r->ptCamera;
}

static gboolean apply_settings(gpointer user_data) {
	(void)user_data;
	g_atomic_int_set(&applyPending, 0);
	/* Take the newest settings; none when an earlier apply already took them */
	g_mutex_lock(&settingsLock);
	cJSON* settings = pendingSettings;
	pendingSettings = NULL;
	g_mutex_unlock(&settingsLock);
	if (!settings) return G_SOURCE_REMOVE;
	gint64 started = g_get_monotonic_time();
	int blocking = 0;   /* calls that block for about 2 s each */

	ACAP_STATUS_SetBool("relay", "applying", 1);

	/* Free subscription data retired two saves ago */
	g_ptr_array_set_size(retiredOld, 0);
	GPtrArray* swap = retiredOld; retiredOld = retired; retired = swap;



	Rule* next[MAX_RULES] = { 0 };
	int nextCount = 0;
	cJSON* list = settings ? cJSON_GetObjectItem(settings, "rules") : NULL;
	cJSON* item = cJSON_IsArray(list) ? list->child : NULL;

	for (; item && nextCount < MAX_RULES; item = item->next) {
		const char* id = json_string(item, "id");
		if (!valid_id(id) || find_rule(next, nextCount, id)) {
			LOG_WARN("Skipping a rule with a missing, invalid or repeated id\n");
			continue;
		}
		gchar* name = clean_text(cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(item, "name")), MAX_NAME_CHARS);   /* "name" exactly, as the kit matches it */
		if (!*name) { g_free(name); name = g_strdup(id); }
		/* Filter: { key, value, match: "contains" | "equals" }, or the older "object" (object types) */
		gchar* fKey = NULL;
		gchar* fValue = NULL;
		int fContains = 0;
		cJSON* filter = cJSON_GetObjectItem(item, "filter");
		if (cJSON_IsObject(filter) && json_string(filter, "key") && json_string(filter, "value")) {
			fKey = clean_text(json_string(filter, "key"), MAX_OBJECT_CHARS);
			fValue = clean_text(json_string(filter, "value"), MAX_NAME_CHARS);
			fContains = same_text(json_string(filter, "match"), "contains");
		} else {
			gchar* object = clean_text(json_string(item, "object"), MAX_OBJECT_CHARS);
			if (*object) { fKey = g_strdup("classTypes"); fValue = object; fContains = 1; }
			else g_free(object);
		}
		if (fKey && (!*fKey || !*fValue)) { g_free(fKey); g_free(fValue); fKey = fValue = NULL; }
		int enabled = cJSON_IsFalse(cJSON_GetObjectItem(item, "enabled")) ? 0 : 1;
		/* "send": "both" (default), "on" or "off" */
		/* Context: { text, start, step, reset: never|daily|hourly|save, count: fires|every } */
		cJSON* ctx = cJSON_GetObjectItem(item, "context");
		gchar* cText = NULL;
		double cStart = 1, cStep = 1;
		int cReset = 1, cEvery = 0;
		if (cJSON_IsObject(ctx)) {
			const char* t = json_string(ctx, "text");
			if (t && *t) cText = g_utf8_substring(t, 0, MIN(g_utf8_strlen(t, -1), 500));
			cJSON* n;
			if (cJSON_IsNumber(n = cJSON_GetObjectItem(ctx, "start"))) cStart = n->valuedouble;
			if (cJSON_IsNumber(n = cJSON_GetObjectItem(ctx, "step"))) cStep = n->valuedouble;
			const char* rs = json_string(ctx, "reset");
			cReset = same_text(rs, "never") ? 0 : same_text(rs, "hourly") ? 2 : same_text(rs, "save") ? 3 : 1;
			cEvery = same_text(json_string(ctx, "count"), "every");
		}
		cJSON* dw = cJSON_GetObjectItem(item, "dwell");
		guint rDwell = cJSON_IsNumber(dw) && dw->valuedouble >= 1 ? (guint)MIN(dw->valuedouble, 2592000) : 0;
		cJSON* re = cJSON_GetObjectItem(item, "reactivation");
		double rWait = 0;
		int rFromOff = 0, rHeldSend = 0;
		if (cJSON_IsObject(re)) {
			cJSON* w = cJSON_GetObjectItem(re, "wait");
			if (cJSON_IsNumber(w)) rWait = MAX(0, MIN(w->valuedouble, 86400));
			rFromOff = same_text(json_string(re, "from"), "off");
			rHeldSend = same_text(json_string(re, "held"), "send");
		}
		const char* sendText = json_string(item, "send");
		int mode = same_text(sendText, "on") ? MODE_ON : same_text(sendText, "off") ? MODE_OFF : MODE_BOTH;
		cJSON* sourceJson = cJSON_GetObjectItem(item, "source");
		gchar* source = source_key(sourceJson);

		/* Take over the existing rule with this id, or start a new one */
		Rule* r = NULL;
		for (int i = 0; i < ruleCount; i++) {
			if (rules[i] && strcmp(rules[i]->id, id) == 0) { r = rules[i]; rules[i] = NULL; break; }
		}
		int isNew = (r == NULL);
		if (isNew) {
			r = g_new0(Rule, 1);
			g_strlcpy(r->id, id, sizeof(r->id));
			r->sentState = -1;
		}

		int nameChanged = isNew || !same_text(r->name, name);
		int sourceChanged = isNew || !same_text(r->source, source);
		int enabledChanged = isNew || r->enabled != enabled;
		int sendChanged = !isNew && r->mode != mode;

		g_free(r->name);   r->name = name;
		int filterChanged = !isNew && (!same_text(r->filterKey, fKey) || !same_text(r->filterValue, fValue) || r->filterContains != fContains);
		g_free(r->filterKey);   r->filterKey = fKey;
		g_free(r->filterValue); r->filterValue = fValue;
		r->filterContains = fContains;
		/* What the camera told the page about the source: its On/Off field and instance fields */
		g_free(r->stateKey);
		r->stateKey = cJSON_IsObject(sourceJson) && json_string(sourceJson, "stateKey") ? clean_text(json_string(sourceJson, "stateKey"), MAX_OBJECT_CHARS) : NULL;
		r->stateless = cJSON_IsObject(sourceJson) && cJSON_IsFalse(cJSON_GetObjectItem(sourceJson, "stateful")) && !(r->stateKey && *r->stateKey);
		g_strfreev(r->sourceKeys);
		r->sourceKeys = NULL;
		cJSON* keys = cJSON_IsObject(sourceJson) ? cJSON_GetObjectItem(sourceJson, "sourceKeys") : NULL;
		if (cJSON_IsArray(keys) && cJSON_GetArraySize(keys) > 0) {
			GPtrArray* a = g_ptr_array_new();
			for (cJSON* k = keys->child; k; k = k->next)
				if (cJSON_IsString(k) && *k->valuestring) g_ptr_array_add(a, clean_text(k->valuestring, MAX_OBJECT_CHARS));
			g_ptr_array_add(a, NULL);
			r->sourceKeys = (gchar**)g_ptr_array_free(a, FALSE);
		}
		g_free(r->source); r->source = source;
		r->enabled = enabled;
		r->mode = mode;
		int hadContext = r->ctxTemplate && *r->ctxTemplate;
		int ctxChanged = !same_text(r->ctxTemplate, cText);
		if (r->rearmWait != rWait || r->rearmFromOff != rFromOff || r->heldSend != rHeldSend) stop_wait(r);
		r->rearmWait = rWait; r->rearmFromOff = rFromOff; r->heldSend = rHeldSend;
		if (!enabled) stop_wait(r);
		if (r->dwell != rDwell || sendChanged || !enabled) stop_dwell(r);
		r->dwell = rDwell;
		int ctrChanged = r->ctrStart != cStart || r->ctrStep != cStep || r->ctrReset != cReset || r->ctrEvery != cEvery;
		g_free(r->ctxTemplate);
		r->ctxTemplate = cText;
		r->ctrStart = cStart; r->ctrStep = cStep; r->ctrReset = cReset; r->ctrEvery = cEvery;
		pt_read(r, cJSON_GetObjectItem(item, "portTesting"));
		/* A context field added or removed changes what the event carries: publish it again */
		if (!isNew && hadContext != (cText != NULL)) sendChanged = 1;
		if (isNew && savedCounters) {   /* counter kept from before a restart */
			cJSON* c = cJSON_GetObjectItem(savedCounters, r->id);
			if (cJSON_IsObject(c)) {
				r->count = cJSON_GetObjectItem(c, "count") ? cJSON_GetObjectItem(c, "count")->valuedouble : 0;
				r->ctrPeriod = (long)(cJSON_GetObjectItem(c, "period") ? cJSON_GetObjectItem(c, "period")->valuedouble : 0);
				r->ctrStarted = 1;
			}
		}
		if (!isNew && (ctrChanged || (cReset == 3 && (ctxChanged || nameChanged || sourceChanged || filterChanged || enabledChanged || sendChanged))))
			r->ctrStarted = 0;   /* start counting again */
		next[nextCount++] = r;

		/* Subscription: drop it if the source or filter changed (subscribing again brings the current
		 * state of each instance) or the rule was turned off */
		if (r->subId && (sourceChanged || filterChanged || !enabled)) {
			unsubscribe_rule(r);
			blocking++;
		}
		if (!enabled) {
			if (r->pulseTimer) { g_source_remove(r->pulseTimer); r->pulseTimer = 0; }
			r->state = 0;
			/* Turning a trigger rule off must not fire its Off trigger */
			if (r->mode != MODE_BOTH) r->sentState = 0;
		}

		/* Declaration: a new name or On/Off choice needs a new declaration */
		if (r->declId && (nameChanged || sendChanged)) {
			undeclare_rule(r);
			blocking++;
		}
		/* An unfinished rule (saved switched off, no source yet) publishes no event */
		if (!r->declId && *r->source) {
			make_topic(r, next, nextCount);
			declare_rule(r);
		}
		else if (enabledChanged && send_state(r) == SENT)
			log_activity(r, NULL, r->sentState, enabled ? "Rule enabled" : "Rule disabled");

		if (enabled && !r->subId) {
			set_error(r, NULL);
			cJSON* sub = make_subscription(sourceJson, r->id);
			if (!sub) {
				set_error(r, "No valid source event");
				continue;
			}
			int subId = ACAP_EVENTS_Subscribe(sub, sub);
			if (subId > 0) {
				r->subId = subId;
				r->subData = sub;
			} else {
				cJSON_Delete(sub);
				set_error(r, "Could not subscribe to the source event");
			}
		}
	}

	/* Rules that were deleted */
	for (int i = 0; i < ruleCount; i++) {
		Rule* r = rules[i];
		if (!r) continue;
		if (r->subId) { unsubscribe_rule(r); blocking++; }
		if (r->declId) { undeclare_rule(r); blocking++; }
		free_rule(r);
	}

	memcpy(rules, next, sizeof(rules));
	ruleCount = nextCount;
	cJSON_Delete(settings);
	/* The counters saved before the restart are now in the rules: no need to keep the copy */
	if (savedCounters) { cJSON_Delete(savedCounters); savedCounters = NULL; }

	int subscribed = 0;
	for (int i = 0; i < ruleCount; i++) if (rules[i]->subId) subscribed++;
	LOG("Applied settings: %d rules, %d subscriptions, %d slow calls, %lld ms\n",
	    ruleCount, subscribed, blocking, (long long)((g_get_monotonic_time() - started) / 1000));
	ACAP_STATUS_SetBool("relay", "applying", 0);
	publish_status();
	return G_SOURCE_REMOVE;
}

/* Called by the wrapper (HTTP thread) once per changed setting, right after it changed it; apply once,
 * on the main loop, from a copy made here on the thread that changes the settings */
static void Settings_Updated_Callback(const char* service, cJSON* data) {
	(void)service;
	(void)data;
	cJSON* copy = cJSON_Duplicate(ACAP_Get_Config("settings"), 1);
	g_mutex_lock(&settingsLock);
	cJSON_Delete(pendingSettings);
	pendingSettings = copy;
	g_mutex_unlock(&settingsLock);
	if (g_atomic_int_compare_and_exchange(&applyPending, 0, 1))
		g_timeout_add(APPLY_DELAY_MS, apply_settings, NULL);
}

/*-----------------------------------------------------
 * Copy settings to other cameras (the UI kit's configio endpoint, kit.h)
 * The rules are one list section. The export leaves out each rule's id; an imported rule
 * named like one on this camera keeps that rule's id, so applying it touches only the rules
 * that changed (apply_settings), the same as a Save on the page.
 *-----------------------------------------------------*/

#define EVENTS_MAX_BYTES (8 * 1024 * 1024)

static gchar* vapixLogin = NULL;   /* "user:password" of this app's own VAPIX service account (web thread) */

/* A login of this app's VAPIX service account. Each thread that calls the camera asks for its own
 * account name (web thread "databender-events", the Port Testing worker "databender-start"). */
static gchar* service_login(const char* account) {
	GError* error = NULL;
	GDBusConnection* bus = g_bus_get_sync(G_BUS_TYPE_SYSTEM, NULL, &error);
	if (!bus) { LOG_WARN("Service account: no system bus: %s\n", error ? error->message : "?"); g_clear_error(&error); return NULL; }
	GVariant* r = g_dbus_connection_call_sync(bus, "com.axis.HTTPConf1", "/com/axis/HTTPConf1/VAPIXServiceAccounts1",
		"com.axis.HTTPConf1.VAPIXServiceAccounts1", "GetCredentials", g_variant_new("(s)", account),
		NULL, G_DBUS_CALL_FLAGS_NONE, 3000, NULL, &error);
	g_object_unref(bus);
	if (!r) { LOG_WARN("Service account %s: none: %s\n", account, error ? error->message : "?"); g_clear_error(&error); return NULL; }
	const char* text = NULL;
	g_variant_get(r, "(&s)", &text);
	gchar* login = text && strchr(text, ':') ? g_strdup(text) : NULL;
	g_variant_unref(r);
	return login;
}

static size_t gstring_write(char* data, size_t size, size_t count, void* user) {
	GString* out = user;
	size_t n = size * count;
	if (out->len + n > EVENTS_MAX_BYTES) return 0;
	g_string_append_len(out, data, (gssize)n);
	return n;
}

/* The camera's event list, as the page reads it: VAPIX GetEventInstances. NULL when it can't be read.
 * It runs on the web thread, so the waits are short: 3 s for the login, 5 s for the list, one retry
 * when the login went stale. */
static gchar* events_xml(void) {
	static const char body[] =
		"<?xml version=\"1.0\" encoding=\"utf-8\"?>"
		"<soap:Envelope xmlns:aev=\"http://www.axis.com/vapix/ws/event1\" xmlns:soap=\"http://www.w3.org/2003/05/soap-envelope\">"
		"<soap:Body><aev:GetEventInstances/></soap:Body></soap:Envelope>";
	for (int attempt = 0; attempt < 2; attempt++) {
		if (!vapixLogin) vapixLogin = service_login("databender-events");
		if (!vapixLogin) return NULL;
		CURL* c = curl_easy_init();
		if (!c) return NULL;
		GString* out = g_string_new(NULL);
		struct curl_slist* head = curl_slist_append(NULL, "Content-Type: application/soap+xml; charset=utf-8");
		curl_easy_setopt(c, CURLOPT_URL, "http://127.0.0.12/vapix/services");
		curl_easy_setopt(c, CURLOPT_USERPWD, vapixLogin);
		curl_easy_setopt(c, CURLOPT_HTTPAUTH, (long)CURLAUTH_BASIC);
		curl_easy_setopt(c, CURLOPT_HTTPHEADER, head);
		curl_easy_setopt(c, CURLOPT_POSTFIELDS, body);
		curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, gstring_write);
		curl_easy_setopt(c, CURLOPT_WRITEDATA, out);
		curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT, 3L);
		curl_easy_setopt(c, CURLOPT_TIMEOUT, 5L);
		curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
		CURLcode res = curl_easy_perform(c);
		long code = 0;
		curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &code);
		curl_slist_free_all(head);
		curl_easy_cleanup(c);
		if (res == CURLE_OK && code == 200) return g_string_free(out, FALSE);
		g_string_free(out, TRUE);
		LOG_WARN("Event list: %s, HTTP %ld\n", curl_easy_strerror(res), code);
		if (code != 401) return NULL;
		g_free(vapixLogin);   /* the login went stale: get it again once */
		vapixLogin = NULL;
	}
	return NULL;
}

/*-----------------------------------------------------
 * Also do: Port Testing (Data Bender 1.6.0)
 * Each time a rule with portTesting.on fires (after its dwell and reactivation wait, as for the event it
 * sends; a Test press too), Data Bender POSTs to Port Testing's start endpoint on this camera
 * (/local/port_testing/start) as its own VAPIX service account, so no password is kept:
 *   {"camera","game":"pong"|"battleship"|"check","minutes"?,"speed"?,"encrypt"?,"proto"?,"port"?}
 * Answers: 200 {"ok":true,"message"}, 409 when a match (or check) is already running, 400 with the reason
 * as text. The call runs on one worker thread with a 15 s limit, so the main loop never waits; at most
 * PT_QUEUE_MAX starts wait their turn, more are skipped. Each result goes to the log and the rule's status.
 * Without Port Testing installed, or not running, the setting is kept and does nothing; the log says so.
 *-----------------------------------------------------*/
#define PT_PACKAGE   "port_testing"
#define PT_QUEUE_MAX 4
#define PT_TIMEOUT_S 15L

static GThreadPool* ptPool = NULL;
static gchar* ptLogin = NULL;   /* the worker's service account login: worker thread only */

typedef struct {
	gchar* id;      /* the rule's id and name, for the log and status */
	gchar* item;
	gchar* body;    /* the JSON sent */
	gchar* what;    /* "Pong with Q1728 test" */
	int    check;
	int    minutes;
} PtJob;

typedef struct { gchar* id; gchar* text; } PtDone;

/* A call to this camera's own web server as this app's service account: GET when json is NULL, else a
 * JSON POST. *login is the calling thread's login (asked for under account, again once when it went
 * stale). Returns the answer (g_free) with its HTTP code, or NULL with *err when none came. */
static gchar* local_call(gchar** login, const char* account, const char* path, const char* json, long timeoutS, long* code, gchar** err) {
	*code = 0;
	for (int attempt = 0; attempt < 2; attempt++) {
		if (!*login) *login = service_login(account);
		if (!*login) { *err = g_strdup("Data Bender has no service account login"); return NULL; }
		CURL* c = curl_easy_init();
		if (!c) { *err = g_strdup("out of memory"); return NULL; }
		GString* out = g_string_new(NULL);
		gchar* url = g_strdup_printf("http://127.0.0.12%s", path);
		struct curl_slist* head = json ? curl_slist_append(NULL, "Content-Type: application/json") : NULL;
		curl_easy_setopt(c, CURLOPT_URL, url);
		curl_easy_setopt(c, CURLOPT_USERPWD, *login);
		curl_easy_setopt(c, CURLOPT_HTTPAUTH, (long)CURLAUTH_BASIC);
		if (json) {
			curl_easy_setopt(c, CURLOPT_HTTPHEADER, head);
			curl_easy_setopt(c, CURLOPT_POSTFIELDS, json);
		}
		curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, gstring_write);
		curl_easy_setopt(c, CURLOPT_WRITEDATA, out);
		curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT, 3L);
		curl_easy_setopt(c, CURLOPT_TIMEOUT, timeoutS);
		curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
		CURLcode res = curl_easy_perform(c);
		curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, code);
		curl_slist_free_all(head);
		curl_easy_cleanup(c);
		g_free(url);
		if (res != CURLE_OK) {
			*err = res == CURLE_OPERATION_TIMEDOUT ? g_strdup_printf("no answer in %ld s", timeoutS) : g_strdup(curl_easy_strerror(res));
			g_string_free(out, TRUE);
			return NULL;
		}
		if (*code != 401 || attempt) return g_string_free(out, FALSE);
		g_string_free(out, TRUE);
		g_free(*login);   /* the login went stale (a refused call started nothing): get it again once */
		*login = NULL;
	}
	return NULL;
}

/* "Pong with Q1728 test", "Port check TCP 443 with Q1728 test" */
static gchar* pt_what(Rule* r) {
	if (strcmp(r->ptGame, "check") == 0)
		return g_strdup_printf("Port check %s %d with %s", strcmp(r->ptProto, "udp") == 0 ? "UDP" : "TCP", r->ptPort, r->ptCamera);
	return g_strdup_printf("%s with %s", strcmp(r->ptGame, "battleship") == 0 ? "Battleship" : "Pong", r->ptCamera);
}

/* One log line about Port Testing: the page shows the text in its own row (field "pt") */
static void pt_log(const char* id, const char* item, const char* text) {
	cJSON* e = cJSON_CreateObject();
	cJSON_AddStringToObject(e, "rule", id);
	cJSON_AddStringToObject(e, "pt", text);
	kit_log_fields(item, e, "");
	cJSON_Delete(e);
}

static void pt_set_last(Rule* r, const char* text) {
	g_free(r->ptLast);
	r->ptLast = g_strdup(text);
	g_strlcpy(r->ptLastAt, ACAP_DEVICE_ISOTime(), sizeof(r->ptLastAt));
}

/* Main loop: the worker's result into the rule's status */
static gboolean pt_done(gpointer data) {
	PtDone* d = data;
	Rule* r = find_rule(rules, ruleCount, d->id);
	if (r) { pt_set_last(r, d->text); publish_status(); }
	g_free(d->id);
	g_free(d->text);
	g_free(d);
	return G_SOURCE_REMOVE;
}

/* The worker: one start at a time */
static void pt_job(gpointer data, gpointer user_data) {
	(void)user_data;
	PtJob* j = data;
	long code = 0;
	gchar* err = NULL;
	gchar* ans = local_call(&ptLogin, "databender-start", "/local/" PT_PACKAGE "/start", j->body, PT_TIMEOUT_S, &code, &err);
	gchar* reason = clean_text(ans, 200);   /* a refusal's reason is plain text */
	gchar* text;
	if (!ans) {
		text = g_strdup_printf("Port Testing did not answer (%s): %s not started", err ? err : "no answer", j->what);
	} else if (code == 200) {
		cJSON* o = cJSON_Parse(ans);
		const char* msg = o ? json_string(o, "message") : NULL;
		text = j->check ? g_strdup_printf("%s: %s", j->what, msg && *msg ? msg : "done")
		                : g_strdup_printf("Started %s for %d minute%s", j->what, j->minutes, j->minutes == 1 ? "" : "s");
		cJSON_Delete(o);
	} else if (code == 409) {
		text = j->check ? g_strdup_printf("%s not started: %s", j->what, *reason ? reason : "a check is already running")
		                : g_strdup_printf("Already playing: %s not started", j->what);
	} else if (code == 400) {
		text = g_strdup_printf("%s not started: %s", j->what, *reason ? reason : "Port Testing gave no reason");
	} else if (code == 401 || code == 403) {
		text = g_strdup_printf("Port Testing refused Data Bender's service account (HTTP %ld): %s not started", code, j->what);
	} else if (code == 404) {
		text = g_strdup_printf("Port Testing has no start for other apps (HTTP 404; it may be stopping or too old): %s not started", j->what);
	} else {
		text = g_strdup_printf("Port Testing answered HTTP %ld: %s not started", code, j->what);
	}
	LOG("Rule %s: Port Testing: %s\n", j->id, text);
	pt_log(j->id, j->item, text);
	PtDone* d = g_new0(PtDone, 1);
	d->id = g_strdup(j->id);
	d->text = text;
	g_idle_add(pt_done, d);
	g_free(reason);
	g_free(ans);
	g_free(err);
	g_free(j->id); g_free(j->item); g_free(j->body); g_free(j->what);
	g_free(j);
}

/* Main loop: the rule fired. Hands the start to the worker, or says why nothing starts. */
static void pt_fire(Rule* r) {
	if (!r->ptOn || !r->ptCamera) return;
	const char* item = r->name && *r->name ? r->name : r->id;
	gchar* what = pt_what(r);
	gchar* st = kit_app_status(PT_PACKAGE);
	gchar* stop = NULL;
	int check = strcmp(r->ptGame, "check") == 0;
	if (!st)
		stop = g_strdup_printf("Port Testing not installed: %s not started", what);
	else if (strcmp(st, "Running") != 0)
		stop = g_strdup_printf("Port Testing is not running (%s): %s not started", *st ? st : "Stopped", what);
	else if (!ptPool || g_thread_pool_unprocessed(ptPool) >= PT_QUEUE_MAX)
		stop = g_strdup_printf("Port Testing has not answered the last starts yet: %s not started", what);
	else if (check && !r->ptPort)
		stop = g_strdup_printf("%s not started: the rule has no port", what);
	g_free(st);
	if (stop) {
		pt_log(r->id, item, stop);
		pt_set_last(r, stop);
		g_free(stop);
		g_free(what);
		return;
	}
	cJSON* b = cJSON_CreateObject();
	cJSON_AddStringToObject(b, "camera", r->ptCamera);
	cJSON_AddStringToObject(b, "game", r->ptGame);
	if (check) {
		cJSON_AddStringToObject(b, "proto", r->ptProto);
		cJSON_AddNumberToObject(b, "port", r->ptPort);
	} else {
		cJSON_AddNumberToObject(b, "minutes", r->ptMinutes);
		if (strcmp(r->ptGame, "pong") == 0) cJSON_AddStringToObject(b, "speed", r->ptSpeed);
		else cJSON_AddBoolToObject(b, "encrypt", r->ptEncrypt);
	}
	char* body = cJSON_PrintUnformatted(b);
	cJSON_Delete(b);
	PtJob* j = g_new0(PtJob, 1);
	j->id = g_strdup(r->id);
	j->item = g_strdup(item);
	j->body = g_strdup(body ? body : "{}");
	j->what = what;
	j->check = check;
	j->minutes = r->ptMinutes;
	free(body);
	g_thread_pool_push(ptPool, j, NULL);
}

/* GET: Port Testing's devices, for the rule popup's Device list (read from Port Testing's metrics):
 * {"installed","status","devices":[{"name","state"}],"error"?}. Web thread. */
static void HTTP_Endpoint_porttesting(const ACAP_HTTP_Response response, const ACAP_HTTP_Request request) {
	(void)request;
	cJSON* out = cJSON_CreateObject();
	gchar* st = kit_app_status(PT_PACKAGE);
	cJSON_AddBoolToObject(out, "installed", st != NULL);
	cJSON_AddStringToObject(out, "status", st ? st : "");
	cJSON* devs = cJSON_AddArrayToObject(out, "devices");
	if (st && strcmp(st, "Running") == 0) {
		long code = 0;
		gchar* err = NULL;
		gchar* ans = local_call(&vapixLogin, "databender-events", "/local/" PT_PACKAGE "/metrics", NULL, 4L, &code, &err);
		cJSON* m = ans && code == 200 ? cJSON_Parse(ans) : NULL;
		cJSON* links = cJSON_GetObjectItem(m, "links");
		if (cJSON_IsArray(links)) {
			cJSON* l;
			cJSON_ArrayForEach(l, links) {
				const char* name = json_string(l, "camera");
				if (!name || !*name) continue;
				cJSON* d = cJSON_CreateObject();
				cJSON_AddStringToObject(d, "name", name);
				cJSON_AddStringToObject(d, "state", json_string(l, "state") ? json_string(l, "state") : "");
				cJSON_AddItemToArray(devs, d);
			}
		} else {
			gchar* why = !ans ? g_strdup_printf("Port Testing did not answer (%s)", err ? err : "no answer")
			                  : g_strdup_printf("Port Testing answered HTTP %ld", code);
			cJSON_AddStringToObject(out, "error", why);
			g_free(why);
		}
		cJSON_Delete(m);
		g_free(ans);
		g_free(err);
	}
	g_free(st);
	ACAP_HTTP_Respond_JSON(response, out);
	cJSON_Delete(out);
}

/* The checks of a rule's portTesting, for an import (the page checks the same before a Save).
 * NULL when it may be saved, else the reason (g_free). */
static gchar* pt_problem(cJSON* pt) {
	if (!cJSON_IsObject(pt)) return g_strdup("its Port Testing setting must be an object.");
	cJSON* on = cJSON_GetObjectItem(pt, "on");
	if (on && !cJSON_IsBool(on)) return g_strdup("Port Testing \"on\" must be true or false.");
	if (!cJSON_IsTrue(on)) return NULL;   /* switched off: kept as it is */
	const char* cam = json_string(pt, "camera");
	gchar* c = clean_text(cam, 1000);
	int noCam = !*c, longCam = g_utf8_strlen(c, -1) > MAX_NAME_CHARS;
	g_free(c);
	if (noCam) return g_strdup("Port Testing is switched on but names no device.");
	if (longCam) return g_strdup_printf("the Port Testing device name is longer than %d characters.", MAX_NAME_CHARS);
	const char* g = json_string(pt, "game");
	if (!same_text(g, "pong") && !same_text(g, "battleship") && !same_text(g, "check"))
		return g_strdup("Port Testing \"game\" must be pong, battleship or check.");
	if (same_text(g, "check")) {
		cJSON* p = cJSON_GetObjectItem(pt, "port");
		const char* pr = json_string(pt, "proto");
		if (!cJSON_IsNumber(p) || p->valuedouble < 1 || p->valuedouble > 65535 || p->valuedouble != (int)p->valuedouble)
			return g_strdup("the Port Testing port check needs a port from 1 to 65535.");
		if (cJSON_GetObjectItem(pt, "proto") && !same_text(pr, "tcp") && !same_text(pr, "udp"))
			return g_strdup("the Port Testing port check's protocol must be tcp or udp.");
	} else {
		cJSON* m = cJSON_GetObjectItem(pt, "minutes");
		if (m && (!cJSON_IsNumber(m) || m->valuedouble < 1 || m->valuedouble > 15))
			return g_strdup("a Port Testing match lasts 1 to 15 minutes.");
		const char* s = json_string(pt, "speed");
		if (cJSON_GetObjectItem(pt, "speed") && !same_text(s, "slow") && !same_text(s, "normal") && !same_text(s, "fast"))
			return g_strdup("the Port Testing speed must be slow, normal or fast.");
		cJSON* e = cJSON_GetObjectItem(pt, "encrypt");
		if (e && !cJSON_IsBool(e)) return g_strdup("Port Testing \"encrypt\" must be true or false.");
	}
	return NULL;
}

/* The topic paths of the camera's events ("RuleEngine/ObjectAnalytics/Device1Scenario1"), the same
 * paths the page matches a rule's source on. NULL when the event list can't be read. */
static GHashTable* event_paths(void) {
	gchar* xml = events_xml();
	if (!xml) return NULL;
	GHashTable* set = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
	GPtrArray* stack = g_ptr_array_new_with_free_func(g_free);
	int inSet = 0;   /* inside <wstop:TopicSet> */
	const char* p = xml;
	while ((p = strchr(p, '<')) != NULL) {
		p++;
		if (*p == '?' || *p == '!') {   /* declaration or comment */
			const char* end = strchr(p, '>');
			if (!end) break;
			p = end + 1;
			continue;
		}
		int closing = *p == '/';
		if (closing) p++;
		size_t n = strcspn(p, " \t\r\n/>");
		const char* colon = memchr(p, ':', n);
		const char* local = colon ? colon + 1 : p;
		size_t localLen = n - (size_t)(local - p);
		const char* end = p + n;   /* the tag's '>', outside quoted values */
		char quote = 0;
		for (; *end && (quote || *end != '>'); end++) {
			if (quote) { if (*end == quote) quote = 0; }
			else if (*end == '"' || *end == '\'') quote = *end;
		}
		if (!*end) break;
		int empty = end > p && end[-1] == '/';
		int isSet = localLen == 8 && strncmp(local, "TopicSet", 8) == 0;
		if (closing) {
			if (isSet) inSet = 0;
			else if (inSet && stack->len) g_ptr_array_set_size(stack, stack->len - 1);
		} else if (isSet) {
			inSet = !empty;
			g_ptr_array_set_size(stack, 0);
		} else if (inSet) {
			gchar* name = g_strndup(local, localLen);
			if (g_strstr_len(p + n, end - (p + n), "topic=\"true\"")) {
				GString* path = g_string_new("");
				for (guint i = 0; i < stack->len; i++) g_string_append_printf(path, "%s/", (char*)g_ptr_array_index(stack, i));
				g_string_append(path, name);
				g_hash_table_add(set, g_string_free(path, FALSE));
			}
			if (empty) g_free(name); else g_ptr_array_add(stack, name);
		}
		p = end + 1;
	}
	g_ptr_array_free(stack, TRUE);
	g_free(xml);
	return set;
}

/* event_paths(), kept 30 s (a failed read too), so a Preview and the Apply after it read the list once.
 * Web thread only. */
#define EVENTS_KEEP_US (30 * G_USEC_PER_SEC)
static GHashTable* eventsKept = NULL;
static gint64 eventsKeptAt = 0;
static int eventsKeptRead = 0;

static GHashTable* event_paths_kept(void) {
	if (eventsKeptRead && g_get_monotonic_time() - eventsKeptAt < EVENTS_KEEP_US) return eventsKept;
	if (eventsKept) g_hash_table_destroy(eventsKept);
	eventsKept = event_paths();
	eventsKeptAt = g_get_monotonic_time();
	eventsKeptRead = 1;
	return eventsKept;
}

/* At most maxChars characters of s, cut on a character boundary, for a message */
static gchar* short_text(const char* s, glong maxChars) {
	gchar* v = g_utf8_make_valid(s ? s : "", -1);
	if (g_utf8_strlen(v, -1) <= maxChars) return v;
	gchar* cut = g_utf8_substring(v, 0, maxChars);
	g_free(v);
	return cut;
}

/* A rule's source as a topic path, or NULL when it isn't one Data Bender can subscribe to */
static gchar* source_path(cJSON* source) {
	const char* keys[] = { "topic0", "topic1", "topic2", "topic3" };
	GString* s = g_string_new("");
	for (int i = 0; i < 4; i++) {
		cJSON* t = cJSON_GetObjectItem(source, keys[i]);
		if (!t) break;
		if (!cJSON_IsObject(t) || !t->child || !cJSON_IsString(t->child) || !*t->child->valuestring) { g_string_free(s, TRUE); return NULL; }
		g_string_append_printf(s, "%s%s", i ? "/" : "", t->child->valuestring);
	}
	if (!s->len) { g_string_free(s, TRUE); return NULL; }
	return g_string_free(s, FALSE);
}

static cJSON* Rules_Get(void) {
	cJSON* list = cJSON_GetObjectItem(ACAP_Get_Config("settings"), "rules");
	return cJSON_IsArray(list) ? cJSON_Duplicate(list, 1) : cJSON_CreateArray();
}

/* The checks of a Save: at most MAX_RULES; a rule that is switched on needs a name and a source.
 * A source this camera doesn't have is kept with a note, as on the page (the rule shows Problem
 * until another source is picked). Rules new to this camera get their own id. Names and fields this
 * version doesn't use are kept exactly as they are (the page's Save trims names), as the settings
 * endpoint keeps them, so an undo puts back exactly what was there. */
static gchar* Rules_Check(cJSON* value, cJSON* notes) {
	int count = cJSON_GetArraySize(value);
	/* The kit doesn't tell check() the mode, so the message gives no advice on it */
	if (count > MAX_RULES)
		return g_strdup_printf("this camera can have %d rules; that would make %d.", MAX_RULES, count);
	GHashTable* ids = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
	GHashTable* events = NULL;
	int eventsRead = 0;
	gchar* err = NULL;
	int n = 0;
	cJSON* it;
	cJSON_ArrayForEach(it, value) {
		n++;
		cJSON* nm = cJSON_GetObjectItemCaseSensitive(it, "name");   /* exactly "name", as the kit matches it */
		if (nm && !cJSON_IsString(nm) && !cJSON_IsNull(nm)) { err = g_strdup_printf("rule %d: its name must be text.", n); break; }
		gchar* name = clean_text(cJSON_GetStringValue(nm), 1000);
		gchar* shortName = short_text(name, 64);
		gchar* label = *name ? g_strdup_printf("Rule '%s'", shortName) : g_strdup_printf("Rule %d", n);
		g_free(shortName);
		cJSON* en = cJSON_GetObjectItem(it, "enabled");
		cJSON* src = cJSON_GetObjectItem(it, "source");
		int hasSource = src && !cJSON_IsNull(src);
		gchar* path = hasSource ? source_path(src) : NULL;
		if (g_utf8_strlen(name, -1) > MAX_NAME_CHARS)
			err = g_strdup_printf("%s: the name is longer than %d characters.", label, MAX_NAME_CHARS);
		else if (en && !cJSON_IsBool(en))
			err = g_strdup_printf("%s: enabled must be true or false.", label);
		else if (hasSource && (!cJSON_IsObject(src) || !path))
			err = g_strdup_printf("%s: its source event is not one Data Bender can listen to.", label);
		else if (!cJSON_IsFalse(en) && (!*name || !hasSource))
			err = g_strdup_printf("%s is switched on but has no %s. Finish it, or switch it off, on the camera it came from, and export again.",
			                      label, *name ? "source event" : "name");
		/* Also do: Port Testing (1.6.0). Rules from older versions have none. */
		cJSON* pt = cJSON_GetObjectItem(it, "portTesting");
		if (!err && pt && !cJSON_IsNull(pt)) {
			gchar* why = pt_problem(pt);
			if (why) err = g_strdup_printf("%s: %s", label, why);
			else if (cJSON_IsTrue(cJSON_GetObjectItem(pt, "on"))) {
				gchar* st = kit_app_status(PT_PACKAGE);
				if (!st) kit_configio_note(notes, "%s starts Port Testing, which isn't installed on this camera. The setting is kept and does nothing until it is.", label);
				g_free(st);
			}
			g_free(why);
		}
		if (!err) {
			/* A rule new to this camera (or with a repeated id) gets its own id */
			const char* id = json_string(it, "id");
			if (!valid_id(id) || g_hash_table_contains(ids, id)) {
				gchar* nid = NULL;
				do { g_free(nid); nid = g_strdup_printf("r%lx%04x", (unsigned long)time(NULL), (unsigned)g_random_int_range(0, 0xffff)); }
				while (g_hash_table_contains(ids, nid));
				if (cJSON_GetObjectItem(it, "id")) cJSON_ReplaceItemInObject(it, "id", cJSON_CreateString(nid));
				else cJSON_AddStringToObject(it, "id", nid);
				g_free(nid);
				id = json_string(it, "id");
			}
			g_hash_table_add(ids, g_strdup(id));
			/* A source this camera doesn't have: kept, with a note */
			if (path) {
				if (!eventsRead) {
					eventsRead = 1;
					events = event_paths_kept();
					if (!events) kit_configio_note(notes, "Could not read this camera's event list, so the rules' source events were not checked.");
				}
				if (events && !g_hash_table_contains(events, path)) {
					gchar* shortPath = short_text(path, 120);
					kit_configio_note(notes, "%s uses a source this camera doesn't have (%s). It shows Problem until you pick another source.", label, shortPath);
					g_free(shortPath);
				}
			}
		}
		g_free(path);
		g_free(label);
		g_free(name);
		if (err) break;
	}
	g_hash_table_destroy(ids);
	return err;
}

/* The same save path as the settings endpoint in ACAP.c (a Save on the page): the settings object,
 * the update callback (it hands a copy to apply_settings, which touches only the rules that changed),
 * then the file. Runs on the web thread, the only thread that changes the settings object. */
static int Rules_Apply(cJSON* value) {
	cJSON* settings = ACAP_Get_Config("settings");
	if (!settings || !cJSON_IsArray(value)) return 0;
	if (cJSON_GetObjectItem(settings, "rules")) cJSON_ReplaceItemInObject(settings, "rules", cJSON_Duplicate(value, 1));
	else cJSON_AddItemToObject(settings, "rules", cJSON_Duplicate(value, 1));
	Settings_Updated_Callback("rules", cJSON_GetObjectItem(settings, "rules"));
	return ACAP_FILE_Write("localdata/settings.json", settings);
}

static const char* const ruleStrip[] = { "id", NULL };
static const KitConfigSection rulesSection = { "rules", "Rules", 1, NULL, ruleStrip, Rules_Get, Rules_Check, Rules_Apply };

static gboolean signal_handler(gpointer user_data) {
	(void)user_data;
	if (main_loop && g_main_loop_is_running(main_loop))
		g_main_loop_quit(main_loop);
	return G_SOURCE_REMOVE;
}

int main(void) {
	/* Lower priority first, before ACAP_Init starts the web thread: on Linux each thread has its own
	 * priority and new threads take it from the thread that creates them. Video and the camera's
	 * own work come first. */
	int lowered = setpriority(PRIO_PROCESS, 0, 10) == 0;
	openlog(APP_PACKAGE, LOG_PID | LOG_CONS, LOG_USER);
	LOG("------ Starting Data Bender ------\n");
	if (!lowered) LOG_WARN("Could not lower the priority\n");

	relayHandler = ax_event_handler_new();
	retired = g_ptr_array_new_with_free_func((GDestroyNotify)cJSON_Delete);
	retiredOld = g_ptr_array_new_with_free_func((GDestroyNotify)cJSON_Delete);
	ACAP_STATUS_SetBool("relay", "applying", 1);

	ACAP_Init(APP_PACKAGE, Settings_Updated_Callback);
	/* The UI kit: resources, processes, apps, log and configio endpoints, and the memory self-limit */
	kit_init(APP_PACKAGE, APP_NAME);
	kit_limits(MEM_LIMIT_KB);
	kit_configio_section(&rulesSection);
	savedCounters = ACAP_FILE_Read("localdata/counters.json");
	ACAP_EVENTS_SetCallback(Event_Callback);
	ACAP_HTTP_Node("test", HTTP_Endpoint_test);
	ACAP_HTTP_Node("preview", HTTP_Endpoint_preview);
	ACAP_HTTP_Node("porttesting", HTTP_Endpoint_porttesting);
	/* Also do: Port Testing starts run here, one at a time, so the main loop never waits for them */
	ptPool = g_thread_pool_new(pt_job, NULL, 1, FALSE, NULL);

	main_loop = g_main_loop_new(NULL, FALSE);
	GSource* signal_source = g_unix_signal_source_new(SIGTERM);
	if (signal_source) {
		g_source_set_callback(signal_source, signal_handler, NULL, NULL);
		g_source_attach(signal_source, NULL);
	}

	/* ACAP_Init already queued the first apply through the settings callback */
	g_main_loop_run(main_loop);

	/* Exit at once: unsubscribing and undeclaring one by one would take about
	 * 2 s each, and the event system drops them when the process ends. */
	LOG("Stopping Data Bender\n");
	closelog();
	return 0;
}
