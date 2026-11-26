/*
 * kit_resources: what the camera is using, the share of all installed apps (appsCpu, appsMemKb) and
 * this app's own numbers (appCpu, appMemKb, appDiskKb), for the page's resource bar.
 * Sampled every 2 s on the main loop; the SD card and temperature fall back to VAPIX when
 * the app can't read them directly. The top processes are read only when the page asks
 * (while its drawer is open). Also holds kit_init(), which starts every kit part.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <math.h>
#include <unistd.h>
#include <syslog.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <glib.h>
#include "ACAP.h"
#include "cJSON.h"
#include "kit.h"

#define SD_PATH        "/var/spool/storage/SD_DISK"
#define TOP_PROCESSES  10

static GMutex lock;
static cJSON* now = NULL;          /* the latest sample, under lock */
static guint tickN = 0;
static guint sampleEvery = 2;      /* seconds between samples; stretched while samples run slow */

/*----------------------------------------------------- small readers
 * ACAP.h pulls in fcgi_stdio.h, which swaps FILE for FCGI_FILE: fopen, fgets and fclose
 * are wrapped, but fscanf is not. So read lines with fgets and parse with sscanf. */

static gboolean first_line(const char* path, char* buf, size_t size) {
	FILE* f = fopen(path, "r");
	if (!f) return FALSE;
	gboolean ok = fgets(buf, (int)size, f) != NULL;
	fclose(f);
	return ok;
}

static long read_kb(const char* file, const char* key) {
	FILE* f = fopen(file, "r");
	if (!f) return -1;
	char line[256];
	long v = -1;
	size_t n = strlen(key);
	while (fgets(line, sizeof(line), f))
		if (strncmp(line, key, n) == 0) { v = atol(line + n); break; }
	fclose(f);
	return v;
}

static unsigned long long camera_ticks(unsigned long long* idle) {
	unsigned long long total = 0, v[8] = { 0 };
	FILE* f = fopen("/proc/stat", "r");
	if (!f) return 0;
	char line[512];
	if (fgets(line, sizeof(line), f) && sscanf(line, "cpu %llu %llu %llu %llu %llu %llu %llu %llu", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6], &v[7]) >= 4) {
		for (int i = 0; i < 8; i++) total += v[i];
		if (idle) *idle = v[3] + v[4];
	}
	fclose(f);
	return total;
}

static unsigned long long self_ticks(void) {
	FILE* f = fopen("/proc/self/stat", "r");
	if (!f) return 0;
	char buf[1024];
	unsigned long ut = 0, st = 0;
	if (fgets(buf, sizeof(buf), f)) {
		char* p = strrchr(buf, ')');
		if (p) sscanf(p + 2, "%*c %*d %*d %*d %*d %*d %*u %*u %*u %*u %*u %lu %lu", &ut, &st);
	}
	fclose(f);
	return (unsigned long long)ut + st;
}

static long long dir_bytes(const char* path, int depth) {
	if (depth > 12) return 0;
	GDir* d = g_dir_open(path, 0, NULL);
	if (!d) return 0;
	long long sum = 0;
	const gchar* name;
	while ((name = g_dir_read_name(d))) {
		gchar* p = g_build_filename(path, name, NULL);
		struct stat st;
		if (lstat(p, &st) == 0) sum += S_ISDIR(st.st_mode) ? dir_bytes(p, depth + 1) : (long long)st.st_blocks * 512;
		g_free(p);
	}
	g_dir_close(d);
	return sum;
}

static gboolean fs_use(const char* path, double* totalKb, double* freeKb) {
	struct statvfs v;
	if (statvfs(path, &v) != 0 || v.f_blocks == 0) return FALSE;
	*totalKb = (double)v.f_blocks * v.f_frsize / 1024.0;
	*freeKb = (double)v.f_bavail * v.f_frsize / 1024.0;
	return TRUE;
}

static gboolean sd_present(void) {
	struct stat a, b;
	return stat(SD_PATH, &a) == 0 && stat("/", &b) == 0 && a.st_dev != b.st_dev;
}

/*----------------------------------------------------- temperature */

static char thermal[8][64];
static int thermalN = 0;
static double vapixTemp = NAN;

static void find_thermal(void) {
	for (int i = 0; i < 16 && thermalN < 8; i++) {
		char p[64], b[32];
		long v;
		snprintf(p, sizeof(p), "/sys/class/thermal/thermal_zone%d/temp", i);
		if (first_line(p, b, sizeof(b)) && sscanf(b, "%ld", &v) == 1 && v > -40000 && v < 150000) g_strlcpy(thermal[thermalN++], p, sizeof(thermal[0]));
	}
}

static double read_temp(void) {
	double best = NAN;
	for (int i = 0; i < thermalN; i++) {
		char b[32];
		long v;
		if (first_line(thermal[i], b, sizeof(b)) && sscanf(b, "%ld", &v) == 1 && (isnan(best) || v / 1000.0 > best)) best = v / 1000.0;
	}
	if (!isnan(best)) return best;
	if (tickN % 15 == 1) {   /* no readable zone: ask the camera every 30 s */
		char* r = ACAP_VAPIX_Get("temperaturecontrol.cgi?action=statusall");
		double t = NAN;
		if (r) {
			for (char* p = strstr(r, ".Celsius="); p; p = strstr(p + 1, ".Celsius=")) {
				double c = atof(p + 9);
				if (isnan(t) || c > t) t = c;
			}
			free(r);
		}
		vapixTemp = t;
	}
	return vapixTemp;
}

/*----------------------------------------------------- all apps' share (the same method as Resource Monitor)
 * Every process started from /usr/local/packages/<app>/ belongs to an installed app, Axis's own included.
 * Their CPU since the last scan (a share of the whole camera) and their private memory (resident minus
 * shared) are added up. Each process's app is read once, from its command line. The table holds only the
 * processes running now. A scan runs on its own timer, every 2 s while it is quick; one that takes over 0.4 s doubles the
 * gap, up to 10 s, and a quick one brings it back. */
#define APPS_SCAN_EVERY 2
#define APPS_SCAN_MAX   10

typedef struct { unsigned long long start; guint64 prevTicks; gboolean isApp; gboolean seen; } AppPid;
static GHashTable* appPids = NULL;          /* pid -> AppPid, processes seen in the last scan */
static unsigned long long appsPrevTotal = 0;
static double appsCpu = -1, appsMemKb = -1;
static gint64 appsLastUs = 0;
static int appsEvery = APPS_SCAN_EVERY;

static void unsee(gpointer k, gpointer v, gpointer u) { (void)k; (void)u; ((AppPid*)v)->seen = FALSE; }
static gboolean gone(gpointer k, gpointer v, gpointer u) { (void)k; (void)u; return !((AppPid*)v)->seen; }

static gboolean apps_scan(void) {
	gint64 t0 = g_get_monotonic_time();
	if (appsLastUs && t0 - appsLastUs < (gint64)appsEvery * G_USEC_PER_SEC - G_USEC_PER_SEC / 2) return FALSE;
	unsigned long long total = camera_ticks(NULL);
	appsLastUs = t0;
	if (!appPids) appPids = g_hash_table_new_full(g_direct_hash, g_direct_equal, NULL, g_free);
	double dt = appsPrevTotal && total > appsPrevTotal ? (double)(total - appsPrevTotal) : 0;
	appsPrevTotal = total;
	double pageKb = (double)sysconf(_SC_PAGESIZE) / 1024.0, cpu = 0, mem = 0;
	g_hash_table_foreach(appPids, unsee, NULL);
	GDir* d = g_dir_open("/proc", 0, NULL);
	const gchar* entry;
	while (d && (entry = g_dir_read_name(d))) {
		if (!isdigit((unsigned char)entry[0])) continue;
		int pid = atoi(entry);
		char path[64], buf[1024];
		snprintf(path, sizeof(path), "/proc/%d/stat", pid);
		FILE* f = fopen(path, "r");
		if (!f) continue;
		gboolean got = fgets(buf, sizeof(buf), f) != NULL;
		fclose(f);
		char* r = got ? strrchr(buf, ')') : NULL;
		unsigned long ut = 0, st = 0;
		unsigned long long start = 0;
		if (!r || sscanf(r + 2, "%*c %*d %*d %*d %*d %*d %*u %*u %*u %*u %*u %lu %lu %*d %*d %*d %*d %*d %*d %llu", &ut, &st, &start) != 3) continue;
		guint64 ticks = (guint64)ut + st;
		AppPid* ap = g_hash_table_lookup(appPids, GINT_TO_POINTER(pid));
		if (!ap || ap->start != start) {
			/* New process: is it an app's? Read once, from the command line */
			ap = g_new0(AppPid, 1);
			ap->start = start;
			ap->prevTicks = ticks;
			snprintf(path, sizeof(path), "/proc/%d/cmdline", pid);
			f = fopen(path, "r");
			if (f) {
				char cmd[256];
				size_t k = fread(cmd, 1, sizeof(cmd) - 1, f);
				fclose(f);
				cmd[k] = 0;
				ap->isApp = strstr(cmd, "/usr/local/packages/") != NULL;
			}
			g_hash_table_replace(appPids, GINT_TO_POINTER(pid), ap);
		}
		ap->seen = TRUE;
		if (ap->isApp) {
			if (dt > 0 && ticks >= ap->prevTicks) cpu += 100.0 * (double)(ticks - ap->prevTicks) / dt;
			snprintf(path, sizeof(path), "/proc/%d/statm", pid);
			f = fopen(path, "r");
			if (f) {
				char mb[128];
				long size = 0, resident = 0, shared = 0;
				if (fgets(mb, sizeof(mb), f) && sscanf(mb, "%ld %ld %ld", &size, &resident, &shared) == 3 && resident > shared)
					mem += (double)(resident - shared) * pageKb;
				fclose(f);
			}
		}
		ap->prevTicks = ticks;
	}
	if (d) g_dir_close(d);
	g_hash_table_foreach_remove(appPids, gone, NULL);
	appsCpu = dt > 0 ? cpu : -1;
	appsMemKb = mem;
	double took = (double)(g_get_monotonic_time() - t0) / 1e6;
	if (took > 0.4 && appsEvery < APPS_SCAN_MAX) appsEvery = MIN(appsEvery * 2, APPS_SCAN_MAX);
	else if (took < 0.15) appsEvery = APPS_SCAN_EVERY;
	return TRUE;
}

/*----------------------------------------------------- the 2 s sample */

static unsigned long long prevTotal = 0, prevIdle = 0, prevSelf = 0;
static unsigned long long prevRx = 0, prevTx = 0;
static gint64 prevNetUs = 0;
static char prevIf[16] = "";
static double sdTotalKb = -1, sdFreeKb = -1, appDiskKb = -1;
static gboolean sdDirect = FALSE;

static void add(cJSON* o, const char* k, double v) { if (!isnan(v) && v >= 0) cJSON_AddNumberToObject(o, k, v); }

static void sample_net(cJSON* o) {
	FILE* f = fopen("/proc/net/dev", "r");
	if (!f) return;
	char line[512], best[16] = "";
	unsigned long long bRx = 0, bTx = 0;
	while (fgets(line, sizeof(line), f)) {
		char* colon = strchr(line, ':');
		if (!colon) continue;
		*colon = 0;
		char* name = line;
		while (*name == ' ') name++;
		if (strncmp(name, "eth", 3) != 0 && strncmp(name, "en", 2) != 0) continue;
		unsigned long long rx = 0, tx = 0;
		if (sscanf(colon + 1, "%llu %*u %*u %*u %*u %*u %*u %*u %llu", &rx, &tx) != 2) continue;
		if (!best[0] || rx + tx > bRx + bTx) { g_strlcpy(best, name, sizeof(best)); bRx = rx; bTx = tx; }
	}
	fclose(f);
	if (!best[0]) return;
	cJSON_AddStringToObject(o, "netIf", best);
	char sp[64], b[32];
	long m = 0;
	snprintf(sp, sizeof(sp), "/sys/class/net/%s/speed", best);
	if (first_line(sp, b, sizeof(b)) && sscanf(b, "%ld", &m) == 1 && m > 0) cJSON_AddNumberToObject(o, "netLinkMbps", (double)m);
	gint64 t = g_get_monotonic_time();
	if (prevNetUs && strcmp(prevIf, best) == 0 && bRx >= prevRx && bTx >= prevTx && t > prevNetUs) {
		double sec = (double)(t - prevNetUs) / 1e6;
		cJSON_AddNumberToObject(o, "netInBps", 8.0 * (double)(bRx - prevRx) / sec);
		cJSON_AddNumberToObject(o, "netOutBps", 8.0 * (double)(bTx - prevTx) / sec);
	}
	prevRx = bRx; prevTx = bTx; prevNetUs = t;
	g_strlcpy(prevIf, best, sizeof(prevIf));
}

static gboolean sample(gpointer user_data) {
	(void)user_data;
	tickN++;
	cJSON* o = cJSON_CreateObject();
	cJSON_AddNumberToObject(o, "t", (double)g_get_real_time() / 1e6);

	unsigned long long idle = 0, total = camera_ticks(&idle), self = self_ticks();
	if (prevTotal && total > prevTotal) {
		double dt = (double)(total - prevTotal);
		cJSON_AddNumberToObject(o, "cpu", 100.0 * (dt - (double)(idle - prevIdle)) / dt);
		if (self >= prevSelf) cJSON_AddNumberToObject(o, "appCpu", 100.0 * (double)(self - prevSelf) / dt);
	}
	prevTotal = total; prevIdle = idle; prevSelf = self;
	/* all installed apps: the yellow share on the page, from the latest apps scan (its own timer, apps_tick) */
	add(o, "appsCpu", appsCpu);
	add(o, "appsMemKb", appsMemKb);
	cJSON_AddNumberToObject(o, "cores", (double)sysconf(_SC_NPROCESSORS_ONLN));

	long rss = read_kb("/proc/self/status", "RssAnon:");   /* private memory, as in the process list */
	if (rss < 0) rss = read_kb("/proc/self/status", "VmRSS:");
	add(o, "appMemKb", (double)rss);
	add(o, "memTotalKb", (double)read_kb("/proc/meminfo", "MemTotal:"));
	add(o, "memAvailKb", (double)read_kb("/proc/meminfo", "MemAvailable:"));

	double ft, ff;
	if (fs_use(".", &ft, &ff)) { add(o, "flashTotalKb", ft); add(o, "flashFreeKb", ff); }
	if (tickN % 30 == 1) appDiskKb = (double)dir_bytes(".", 0) / 1024.0;   /* every minute */
	add(o, "appDiskKb", appDiskKb);

	if (tickN % 15 == 1) {   /* the SD card can come and go: look again every 30 s */
		sdDirect = sd_present() && fs_use(SD_PATH, &sdTotalKb, &sdFreeKb);
		if (!sdDirect) {
			/* The app may not see the card's folder: ask the camera's disk list (sizes in kB) */
			sdTotalKb = sdFreeKb = -1;
			char* r = ACAP_VAPIX_Get("disks/list.cgi?diskid=SD_DISK");
			const char* d = r ? strstr(r, "diskid=\"SD_DISK\"") : NULL;
			const char* ts = d ? strstr(d, "totalsize=\"") : NULL;
			const char* fs = d ? strstr(d, "freesize=\"") : NULL;
			const char* st = d ? strstr(d, "status=\"") : NULL;
			if (ts && fs && st && strncmp(st + 8, "OK", 2) == 0 && atof(ts + 11) > 0) { sdTotalKb = atof(ts + 11); sdFreeKb = atof(fs + 10); }
			free(r);
		}
	}
	if (sdDirect) fs_use(SD_PATH, &sdTotalKb, &sdFreeKb);
	if (sdTotalKb > 0) { add(o, "sdTotalKb", sdTotalKb); add(o, "sdFreeKb", sdFreeKb); }

	sample_net(o);
	double temp = read_temp();
	if (!isnan(temp)) cJSON_AddNumberToObject(o, "tempC", temp);

	char ub[64];
	double up = 0;
	if (first_line("/proc/uptime", ub, sizeof(ub)) && sscanf(ub, "%lf", &up) == 1) cJSON_AddNumberToObject(o, "uptime", round(up));

	cJSON_AddNumberToObject(o, "every", sampleEvery);
	g_mutex_lock(&lock);
	if (now) cJSON_Delete(now);
	now = o;
	g_mutex_unlock(&lock);
	return G_SOURCE_CONTINUE;
}

/* Every 2 s; a sample that takes long (a slow VAPIX answer, a busy camera) doubles the gap, up to
 * 16 s, and quick samples bring it back */
static gboolean sample_tick(gpointer user_data) {
	(void)user_data;
	gint64 t0 = g_get_monotonic_time();
	sample(NULL);
	double ms = (double)(g_get_monotonic_time() - t0) / 1000.0;
	guint want = ms > 300 ? MIN(sampleEvery * 2, 16) : (ms < 100 && sampleEvery > 2 ? sampleEvery / 2 : sampleEvery);
	if (want == sampleEvery) return G_SOURCE_CONTINUE;
	sampleEvery = want;
	g_timeout_add_seconds(sampleEvery, sample_tick, NULL);
	return G_SOURCE_REMOVE;
}

/* The apps scan has its own timer, so a slow scan stretches only itself (2 to 10 s) and never the
 * 2 s sample. The scan runs without the lock; only the two new numbers are swapped into the latest
 * sample under it. */
static void put_num(cJSON* o, const char* k, double v) {
	cJSON_DeleteItemFromObjectCaseSensitive(o, k);
	if (!isnan(v) && v >= 0) cJSON_AddNumberToObject(o, k, v);
}
static gboolean apps_tick(gpointer user_data) {
	(void)user_data;
	if (!apps_scan()) return G_SOURCE_CONTINUE;
	g_mutex_lock(&lock);
	if (now) { put_num(now, "appsCpu", appsCpu); put_num(now, "appsMemKb", appsMemKb); }
	g_mutex_unlock(&lock);
	return G_SOURCE_CONTINUE;
}

static void HTTP_resources(const ACAP_HTTP_Response response, const ACAP_HTTP_Request request) {
	(void)request;
	g_mutex_lock(&lock);
	cJSON* out = now ? cJSON_Duplicate(now, 1) : cJSON_CreateObject();
	g_mutex_unlock(&lock);
	ACAP_HTTP_Respond_JSON(response, out);
	cJSON_Delete(out);
}

/*----------------------------------------------------- top processes (asked for by the page) */

typedef struct { char name[40]; char app[64]; int count; double cpu; double memKb; } ProcSum;
static GMutex procLock;
static GHashTable* procPrev = NULL;     /* pid -> CPU ticks at the previous scan; replaced each scan */
static unsigned long long procPrevTotal = 0;
/* A scan reads every process: at most one every 4 s (longer while scans run slow); asks in
 * between get the last answer again */
static cJSON* procLast[2] = { NULL, NULL };   /* [0] by CPU, [1] by memory */
static gint64 procLastAt = 0, procGapUs = 4 * G_USEC_PER_SEC;

static int by_cpu(const void* a, const void* b) {
	const ProcSum* x = a; const ProcSum* y = b;
	if (x->cpu != y->cpu) return x->cpu < y->cpu ? 1 : -1;
	return x->memKb < y->memKb ? 1 : (x->memKb > y->memKb ? -1 : 0);
}
static int by_mem(const void* a, const void* b) {
	const ProcSum* x = a; const ProcSum* y = b;
	if (x->memKb != y->memKb) return x->memKb < y->memKb ? 1 : -1;
	return x->cpu < y->cpu ? 1 : (x->cpu > y->cpu ? -1 : 0);
}

static cJSON* proc_json(const ProcSum* p) {
	cJSON* o = cJSON_CreateObject();
	cJSON_AddStringToObject(o, "name", p->name);
	if (p->app[0]) cJSON_AddStringToObject(o, "app", p->app);
	cJSON_AddNumberToObject(o, "count", p->count);
	cJSON_AddNumberToObject(o, "cpu", p->cpu);
	cJSON_AddNumberToObject(o, "memKb", p->memKb);
	return o;
}

/* Processes with the same name are added together. CPU is the share of the whole camera since
 * the previous ask; memory is private memory (resident minus shared), so the list adds up. */
static void HTTP_processes(const ACAP_HTTP_Response response, const ACAP_HTTP_Request request) {
	char* by = ACAP_HTTP_Request_Param(request, "by");
	gboolean byMem = by && strcmp(by, "mem") == 0;
	free(by);
	g_mutex_lock(&procLock);
	gint64 t0 = g_get_monotonic_time();
	if (procLast[byMem] && t0 - procLastAt < procGapUs) {
		cJSON* again = cJSON_Duplicate(procLast[byMem], 1);
		g_mutex_unlock(&procLock);
		ACAP_HTTP_Respond_JSON(response, again);
		cJSON_Delete(again);
		return;
	}
	unsigned long long total = camera_ticks(NULL);
	double dt = procPrevTotal && total > procPrevTotal ? (double)(total - procPrevTotal) : 0;
	double pageKb = (double)sysconf(_SC_PAGESIZE) / 1024.0;

	GHashTable* ticksNow = g_hash_table_new_full(g_direct_hash, g_direct_equal, NULL, g_free);
	GHashTable* byName = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
	GArray* sums = g_array_new(FALSE, TRUE, sizeof(ProcSum));
	int seen = 0;
	GDir* d = g_dir_open("/proc", 0, NULL);
	const gchar* entry;
	while (d && (entry = g_dir_read_name(d))) {
		if (!isdigit((unsigned char)entry[0])) continue;
		int pid = atoi(entry);
		seen++;
		char path[64], buf[1024];
		snprintf(path, sizeof(path), "/proc/%d/stat", pid);
		FILE* f = fopen(path, "r");
		if (!f) continue;
		gboolean got = fgets(buf, sizeof(buf), f) != NULL;
		fclose(f);
		char* l = got ? strchr(buf, '(') : NULL;
		char* r = got ? strrchr(buf, ')') : NULL;
		unsigned long ut = 0, st = 0;
		if (!l || !r || r < l || sscanf(r + 2, "%*c %*d %*d %*d %*d %*d %*u %*u %*u %*u %*u %lu %lu", &ut, &st) != 2) continue;
		ProcSum p;
		memset(&p, 0, sizeof(p));
		size_t n = (size_t)(r - l - 1);
		if (n >= sizeof(p.name)) n = sizeof(p.name) - 1;
		memcpy(p.name, l + 1, n);
		p.count = 1;
		snprintf(path, sizeof(path), "/proc/%d/statm", pid);
		f = fopen(path, "r");
		if (f) {
			char mb[128];
			long size = 0, resident = 0, shared = 0;
			if (fgets(mb, sizeof(mb), f) && sscanf(mb, "%ld %ld %ld", &size, &resident, &shared) == 3 && resident > shared)
				p.memKb = (double)(resident - shared) * pageKb;
			fclose(f);
		}
		guint64* t = g_new(guint64, 1);
		*t = (guint64)ut + st;
		g_hash_table_insert(ticksNow, GINT_TO_POINTER(pid), t);
		if (dt > 0 && procPrev) {
			guint64* old = g_hash_table_lookup(procPrev, GINT_TO_POINTER(pid));
			if (old && *t >= *old) p.cpu = 100.0 * (double)(*t - *old) / dt;
		}
		/* Installed apps run from /usr/local/packages/<app>/; names are cut to 15 letters */
		snprintf(path, sizeof(path), "/proc/%d/cmdline", pid);
		f = fopen(path, "r");
		if (f) {
			char cmd[256];
			size_t k = fread(cmd, 1, sizeof(cmd) - 1, f);
			fclose(f);
			cmd[k] = 0;
			if (strlen(p.name) == 15 && k > 0) {
				const char* base = strrchr(cmd, '/');
				base = base ? base + 1 : cmd;
				if (strncmp(base, p.name, 15) == 0 && strlen(base) > 15) g_strlcpy(p.name, base, sizeof(p.name));
			}
			const char* m = strstr(cmd, "/usr/local/packages/");
			if (m) {
				m += strlen("/usr/local/packages/");
				size_t j = 0;
				while (m[j] && m[j] != '/' && j < sizeof(p.app) - 1) { p.app[j] = m[j]; j++; }
				p.app[j] = 0;
			}
		}
		char* at = strchr(p.name, '@');   /* vipd@0, vipd@1 ... count as one */
		if (at && at != p.name) *at = 0;
		gpointer idx;
		if (g_hash_table_lookup_extended(byName, p.name, NULL, &idx)) {
			ProcSum* s = &g_array_index(sums, ProcSum, GPOINTER_TO_UINT(idx));
			s->count++; s->cpu += p.cpu; s->memKb += p.memKb;
			if (!s->app[0] && p.app[0]) g_strlcpy(s->app, p.app, sizeof(s->app));
		} else {
			g_array_append_val(sums, p);
			g_hash_table_insert(byName, g_strdup(p.name), GUINT_TO_POINTER(sums->len - 1));
		}
	}
	if (d) g_dir_close(d);
	g_hash_table_destroy(byName);

	g_array_sort(sums, byMem ? by_mem : by_cpu);
	cJSON* out = cJSON_CreateObject();
	cJSON_AddBoolToObject(out, "ready", dt > 0);
	cJSON_AddStringToObject(out, "by", byMem ? "mem" : "cpu");
	cJSON_AddNumberToObject(out, "processes", seen);
	cJSON* top = cJSON_AddArrayToObject(out, "top");
	ProcSum other;
	memset(&other, 0, sizeof(other));
	for (guint i = 0; i < sums->len; i++) {
		ProcSum* s = &g_array_index(sums, ProcSum, i);
		if (i < TOP_PROCESSES) cJSON_AddItemToArray(top, proc_json(s));
		else { other.count += s->count; other.cpu += s->cpu; other.memKb += s->memKb; }
	}
	g_strlcpy(other.name, "Other", sizeof(other.name));
	cJSON_AddItemToObject(out, "other", proc_json(&other));
	g_array_free(sums, TRUE);
	if (procPrev) g_hash_table_destroy(procPrev);
	procPrev = ticksNow;
	procPrevTotal = total;
	gint64 took = g_get_monotonic_time() - t0;
	procGapUs = took > 500000 ? 10 * G_USEC_PER_SEC : 4 * G_USEC_PER_SEC;
	procLastAt = g_get_monotonic_time();
	if (procLast[byMem]) cJSON_Delete(procLast[byMem]);
	procLast[byMem] = cJSON_Duplicate(out, 1);
	if (procLast[!byMem]) { cJSON_Delete(procLast[!byMem]); procLast[!byMem] = NULL; }   /* the other order is from an older scan */
	g_mutex_unlock(&procLock);
	ACAP_HTTP_Respond_JSON(response, out);
	cJSON_Delete(out);
}

/*----------------------------------------------------- start */

void kit_resources_init(void) {
	g_mutex_init(&lock);
	g_mutex_init(&procLock);
	find_thermal();
	sample(NULL);
	ACAP_HTTP_Node("resources", HTTP_resources);
	ACAP_HTTP_Node("processes", HTTP_processes);
	g_timeout_add_seconds(sampleEvery, sample_tick, NULL);
	apps_scan();                                   /* the first scan only notes each process; numbers from the next */
	g_timeout_add_seconds(1, apps_tick, NULL);     /* it scans when its own gap (2 to 10 s) has passed */
}

void kit_init(const char* appPackage, const char* appName) {
	kit_log_init(appName);
	kit_apps_init(appPackage);
	kit_resources_init();
	kit_configio_init(appPackage, appName);
}

/*----------------------------------------------------- memory self-limit */

static long memLimitKb = 0;
static gboolean check_memory(gpointer user_data) {
	(void)user_data;
	static int over = 0;
	long kb = read_kb("/proc/self/status", "RssAnon:");
	over = kb > memLimitKb ? over + 1 : 0;
	if (over < 3) return G_SOURCE_CONTINUE;
	gchar* why = g_strdup_printf("Restarted itself: its memory was %.1f MB, over its %.1f MB limit", kb / 1024.0, memLimitKb / 1024.0);
	syslog(LOG_WARNING, "%s", why);
	kit_log(NULL, why, "", NULL);
	kit_log_flush();
	g_free(why);
	closelog();
	exit(EXIT_FAILURE);
}

void kit_limits(long limitKb) {
#ifdef KIT_MEM_LIMIT_KB
	limitKb = KIT_MEM_LIMIT_KB;   /* test build */
#endif
	memLimitKb = limitKb;
	g_timeout_add_seconds(60, check_memory, NULL);
}
