/*
 * kit_log: the shared log. The last 100 lines, newest first, kept on storage.
 * Lines are written to storage at most every 10 s, to spare the camera's flash.
 */
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <glib.h>
#include "ACAP.h"
#include "cJSON.h"
#include "kit.h"

#define KIT_LOG_MAX  100
#define KIT_LOG_FILE "localdata/kit_log.json"

static GMutex lock;
static cJSON* lines = NULL;          /* newest first */
static gboolean dirty = FALSE;
static gchar* ownName = NULL;

static void insert(cJSON* e) {
	cJSON_InsertItemInArray(lines, 0, e);
	while (cJSON_GetArraySize(lines) > KIT_LOG_MAX) cJSON_DeleteItemFromArray(lines, KIT_LOG_MAX);
	dirty = TRUE;
}

static cJSON* new_line(const char* item, const char* who) {
	cJSON* e = cJSON_CreateObject();
	cJSON_AddNumberToObject(e, "t", (double)time(NULL));
	cJSON_AddStringToObject(e, "item", item && *item ? item : (ownName ? ownName : ""));
	cJSON_AddStringToObject(e, "who", who && *who ? who : (ownName ? ownName : ""));
	return e;
}

static void add_line(const char* item, const char* what, const char* detail, const char* who) {
	cJSON* e = new_line(item, who);
	cJSON_AddStringToObject(e, "what", what ? what : "");
	cJSON_AddStringToObject(e, "detail", detail ? detail : "");
	insert(e);
}

void kit_log(const char* item, const char* what, const char* detail, const char* who) {
	g_mutex_lock(&lock);
	if (lines) add_line(item, what, detail, who);
	g_mutex_unlock(&lock);
}

void kit_log_fields(const char* item, cJSON* fields, const char* who) {
	g_mutex_lock(&lock);
	if (lines) {
		cJSON* e = new_line(item, who);
		cJSON* f;
		cJSON_ArrayForEach(f, fields) {
			if (!f->string || !strcmp(f->string, "t") || !strcmp(f->string, "item") || !strcmp(f->string, "who")) continue;
			cJSON_AddItemToObject(e, f->string, cJSON_Duplicate(f, 1));
		}
		insert(e);
	}
	g_mutex_unlock(&lock);
}

void kit_log_flush(void) {
	g_mutex_lock(&lock);
	if (lines && dirty) { ACAP_FILE_Write(KIT_LOG_FILE, lines); dirty = FALSE; }
	g_mutex_unlock(&lock);
}

static gboolean flush(gpointer user_data) {
	(void)user_data;
	kit_log_flush();
	return G_SOURCE_CONTINUE;
}

static void HTTP_log(const ACAP_HTTP_Response response, const ACAP_HTTP_Request request) {
	const char* method = ACAP_HTTP_Get_Method(request);
	if (method && strcmp(method, "POST") == 0) {
		/* JSON only, so another web site can't send it from a form or a link */
		const char* type = ACAP_HTTP_Get_Content_Type(request);
		const char* body = ACAP_HTTP_Get_Body(request);
		cJSON* in = body && type && strstr(type, "application/json") ? cJSON_ParseWithLength(body, ACAP_HTTP_Get_Body_Length(request)) : NULL;
		const char* action = in ? cJSON_GetStringValue(cJSON_GetObjectItem(in, "action")) : NULL;
		if (!action || strcmp(action, "clear") != 0) {
			ACAP_HTTP_Respond_Error(response, 400, "Expected {\"action\":\"clear\"}");
			cJSON_Delete(in);
			return;
		}
		cJSON_Delete(in);
		g_mutex_lock(&lock);
		cJSON_Delete(lines);
		lines = cJSON_CreateArray();
		add_line(ownName, "Log cleared", "", ACAP_HTTP_Get_User(request));
		ACAP_FILE_Write(KIT_LOG_FILE, lines);
		dirty = FALSE;
		g_mutex_unlock(&lock);
	} else if (method && strcmp(method, "GET") != 0) {
		ACAP_HTTP_Respond_Error(response, 405, "Use GET, or POST with JSON");
		return;
	}
	g_mutex_lock(&lock);
	cJSON* out = cJSON_CreateObject();
	cJSON_AddItemToObject(out, "lines", cJSON_Duplicate(lines, 1));
	g_mutex_unlock(&lock);
	ACAP_HTTP_Respond_JSON(response, out);
	cJSON_Delete(out);
}

void kit_log_init(const char* appName) {
	g_mutex_init(&lock);
	ownName = g_strdup(appName);
	cJSON* saved = ACAP_FILE_Read(KIT_LOG_FILE);
	g_mutex_lock(&lock);
	lines = cJSON_IsArray(saved) ? saved : cJSON_CreateArray();
	if (!cJSON_IsArray(saved)) cJSON_Delete(saved);
	g_mutex_unlock(&lock);
	ACAP_HTTP_Node("log", HTTP_log);
	g_timeout_add_seconds(10, flush, NULL);
}
