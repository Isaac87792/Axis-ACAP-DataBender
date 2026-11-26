/* Tests for app/context.c. Build and run on a Linux machine:
 *   gcc -O1 -Wall -fsanitize=address,undefined -o /tmp/tc tools/test_context.c app/context.c \
 *       $(pkg-config --cflags --libs glib-2.0) -lm && /tmp/tc
 */
#include <stdio.h>
#include <string.h>
#include "../app/context.h"

static int fails = 0;

static void check(const char* tmpl, const char* want) {
	CtxVar vars[] = {
		{ "count", NULL, 14, 1 }, { "time", "11:05:32", 0, 0 }, { "camera", "Front Door", 0, 0 },
		{ "object", "human", 0, 0 }, { "rule", "Person Detected", 0, 0 }, { "state", "On", 0, 0 },
	};
	gchar* got = ctx_render(tmpl, vars, 6);
	if (strcmp(got, want) != 0) { printf("FAIL  %-45s -> \"%s\" (want \"%s\")\n", tmpl, got, want); fails++; }
	else printf("ok    %-45s -> \"%s\"\n", tmpl, got);
	g_free(got);
}

int main(void) {
	check("Person #{count} today on {camera} at {time}", "Person #14 today on Front Door at 11:05:32");
	check("{count * 2}", "28");
	check("{count % 10 + 1}", "5");
	check("{(count + 1) * 2}", "30");
	check("{count / 4}", "3.5");
	check("{count / 0}", "?");
	check("{if(count > 10, \"busy\", \"normal\")}", "busy");
	check("{if(count <= 10, \"busy\", \"normal\")}", "normal");
	check("{if(object == \"human\", \"Person\", \"Thing\")}", "Person");
	check("{if(state != \"On\", 1, 0)}", "0");
	check("{upper(object)} {lower(rule)}", "HUMAN person detected");
	check("{round(count / 3, 2)}", "4.67");
	check("{pad(count, 5)}", "00014");
	check("{\"a\" + count}", "a14");
	check("{-count + 4}", "-10");
	check("{nosuchfield}x", "x");
	check("{{literal}} braces", "{literal} braces");
	check("broken {count +", "broken {count +");
	check("bad {count +}", "bad {?}");
	check("bad {foo(1)}", "bad {?}");
	check("{\"text with } brace\"}", "text with } brace");
	check("", "");
	check("{((((((((((((((((((((((((((((((((((count))))))))))))))))))))))))))))))))))}", "{?}");
	printf(fails ? "\n%d FAILED\n" : "\nall passed\n", fails);
	return fails ? 1 : 0;
}
