.PHONY: build other watch clean xpi

SRC_FILES := $(shell find src -type f)
FILES := $(subst src/, dist/, $(SRC_FILES))
FILES := $(FILES:.pug=.html)
FILES := $(FILES:.styl=.css)
FILES := $(FILES:.cson=.json)

OTHER_FILES := $(filter-out %.ts, $(FILES))
JS_FILES := $(filter %.ts, $(FILES))
JS_FILES := $(JS_FILES:.ts=.js)

build: $(OTHER_FILES) $(JS_FILES)
other: $(OTHER_FILES)

LOCALE := $(firstword $(subst ., ,$(LANG)))

$(JS_FILES): $(filter %.ts, $(SRC_FILES))
	tsc --locale $(LOCALE)

dist/%.html: src/%.pug
	mkdir -p $(@D)
	pug -P < $< > $@

dist/%.json: src/%.cson
	mkdir -p $(@D)
	cson2json $< > $@

dist/%.css: src/%.styl
	mkdir -p $(@D)
	stylus < $< > $@

dist/%: src/%
	mkdir -p $(@D)
	cp $< $@

watch:
	@exec 3>&1; while true; do \
        make --no-print-directory other; \
        inotifywait -qqre close_write src; \
    done 4>&1 >&3 3>&- | tsc  --locale $(LOCALE) -w 3>&- | awk 'NF'

clean:
	rm -rf dist

xpi: build
	cd dist; zip -x 'README.md' -x 'LICENSE' -r -FS "../dist.unsigned.xpi" *