PROG1	= data_bender
OBJS1	= main.c context.c kit_resources.c kit_log.c kit_apps.c kit_configio.c ACAP.c cJSON.c
PROGS	= $(PROG1)

PKGS = glib-2.0 gio-2.0 axevent axparameter fcgi libcurl

CFLAGS += $(shell PKG_CONFIG_PATH=$(PKG_CONFIG_PATH) pkg-config --cflags $(PKGS))
LDLIBS += $(shell PKG_CONFIG_PATH=$(PKG_CONFIG_PATH) pkg-config --libs $(PKGS))
LDLIBS  += -s -lm -ldl -lpthread
CFLAGS += -Wall -Wno-format-overflow

all:	$(PROGS)

$(PROG1): $(OBJS1)
	$(CC) $(CFLAGS) $(LDFLAGS) $^ $(LDLIBS) -o $@

clean:
	rm -rf $(PROGS) *.o $(LIBDIR) *.eap* *_LICENSE.txt
