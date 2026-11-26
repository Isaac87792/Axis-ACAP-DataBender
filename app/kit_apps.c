/*
 * kit_apps: the apps installed on the camera and their status, from list.cgi every 5 s.
 * The page uses it for source lights (green Running, red Stopped) and the app's own
 * code can ask kit_app_status() or be told of changes with kit_on_app_change().
 * Needs the VAPIX service account (manifest.json resources.dbus, see the starter app).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <glib.h>
#include "ACAP.h"
#include "cJSON.h"
#include "kit.h"

static GMutex lock;
static cJSON* apps = NULL;             /* [{id, name, vendor, version, status, self}] */
static GHashTable* lastStatus = NULL;  /* id -> status; main loop only */
static gchar* selfId = NULL;
static KitAppChanged changed = NULL;

static gchar* xml_attr(const char* tag, const char* end, const char* name) {
	gchar* key = g_strdup_printf(" %s=\"", name);
	const char* p = g_strstr_len(tag, end - tag, key);
	gchar* v = NULL;
	if (p) {
		p += strlen(key);
		const char* q = strchr(p, '"');
		if (q && q <= end) v = g_strndup(p, q - p);
	}
	g_free(key);
	return v ? v : g_strdup("");
}

static gboolean poll_apps(gpointer user_data) {
	(void)user_data;
	char* xml = ACAP_VAPIX_Get("applications/list.cgi");
	if (!xml) return G_SOURCE_CONTINUE;
	cJSON* list = cJSON_CreateArray();
	/* Rebuilt on each read, so removed apps drop out (nothing only grows) */
	GHashTable* seen = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
	for (const char* p = strstr(xml, "<application "); p; p = strstr(p + 1, "<application ")) {
		const char* end = strchr(p, '>');
		if (!end) break;
		gchar* id = xml_attr(p, end, "Name");
		gchar* nice = xml_attr(p, end, "NiceName");
		gchar* vendor = xml_attr(p, end, "Vendor");
		gchar* version = xml_attr(p, end, "Version");
		gchar* st = xml_attr(p, end, "Status");
		cJSON* a = cJSON_CreateObject();
		cJSON_AddStringToObject(a, "id", id);
		cJSON_AddStringToObject(a, "name", *nice ? nice : id);
		cJSON_AddStringToObject(a, "vendor", vendor);
		cJSON_AddStringToObject(a, "version", version);
		cJSON_AddStringToObject(a, "status", st);
		cJSON_AddBoolToObject(a, "self", selfId && strcmp(id, selfId) == 0);
		cJSON_AddItemToArray(list, a);
		const char* was = g_hash_table_lookup(lastStatus, id);
		if (was && strcmp(was, st) != 0 && changed) changed(id, *nice ? nice : id, was, st);
		g_hash_table_replace(seen, g_strdup(id), g_strdup(st));
		g_free(id); g_free(nice); g_free(vendor); g_free(version); g_free(st);
	}
	free(xml);
	g_hash_table_destroy(lastStatus);
	lastStatus = seen;
	g_mutex_lock(&lock);
	if (apps) cJSON_Delete(apps);
	apps = list;
	g_mutex_unlock(&lock);
	return G_SOURCE_CONTINUE;
}

static gchar* field_of(const char* id, const char* key) {
	gchar* v = NULL;
	if (!id) return NULL;
	g_mutex_lock(&lock);
	cJSON* a;
	cJSON_ArrayForEach(a, apps) {
		const char* aid = cJSON_GetStringValue(cJSON_GetObjectItem(a, "id"));
		if (aid && strcmp(aid, id) == 0) { v = g_strdup(cJSON_GetStringValue(cJSON_GetObjectItem(a, key))); break; }
	}
	g_mutex_unlock(&lock);
	return v;
}

gchar* kit_app_status(const char* id) { return field_of(id, "status"); }
gchar* kit_app_name(const char* id) { return field_of(id, "name"); }
void kit_on_app_change(KitAppChanged cb) { changed = cb; }

static void HTTP_apps(const ACAP_HTTP_Response response, const ACAP_HTTP_Request request) {
	(void)request;
	g_mutex_lock(&lock);
	cJSON* out = cJSON_CreateObject();
	cJSON_AddItemToObject(out, "apps", apps ? cJSON_Duplicate(apps, 1) : cJSON_CreateArray());
	g_mutex_unlock(&lock);
	ACAP_HTTP_Respond_JSON(response, out);
	cJSON_Delete(out);
}

void kit_apps_init(const char* appPackage) {
	g_mutex_init(&lock);
	selfId = g_strdup(appPackage);
	lastStatus = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
	poll_apps(NULL);
	ACAP_HTTP_Node("apps", HTTP_apps);
	g_timeout_add_seconds(5, poll_apps, NULL);
}
