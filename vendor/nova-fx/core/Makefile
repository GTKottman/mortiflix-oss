# Nova FX core. Built on the machine that runs it, so -march=native is safe.
CC ?= gcc
CFLAGS ?= -O3 -march=native -ffast-math -fno-math-errno -fopenmp -fPIC -fvisibility=hidden -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers
OUT ?= ../addon/nova_fx/lib/libnovacore.so
SHADERS := $(wildcard shaders/*.comp)
SHADER_DEPS := $(SHADERS) shaders/common.glsl

$(OUT): nova_core.c gpu_vk.c nova_params.h shaders_spv.h
	mkdir -p $(dir $(OUT))
	$(CC) $(CFLAGS) -shared -o $@ nova_core.c gpu_vk.c -lm -ldl
	cp nova_core.c gpu_vk.c nova_params.h shaders_spv.h $(dir $(OUT))

# SPIR-V is generated with glslc and committed, so building the core never needs a shader compiler.
shaders_spv.h: $(SHADER_DEPS)
	@if command -v glslc >/dev/null; then \
	  python3 embed_spv.py $(SHADERS) > $@.tmp && mv $@.tmp $@; \
	else echo "glslc not found: using the committed shaders_spv.h"; touch $@; fi

clean:
	rm -f $(OUT)

# Installable extension zip: ships the C source, the add-on compiles it on first use.
VERSION := $(shell sed -n 's/^version = "\(.*\)"/\1/p' ../addon/nova_fx/blender_manifest.toml)
package:
	rm -rf ../dist/stage && mkdir -p ../dist/stage
	cp -r ../addon/nova_fx ../dist/stage/nova_fx
	rm -rf ../dist/stage/nova_fx/__pycache__ ../dist/stage/nova_fx/lib/libnovacore.so
	cp nova_core.c gpu_vk.c nova_params.h shaders_spv.h ../dist/stage/nova_fx/lib/
	cd ../dist/stage && zip -qr ../nova_fx-$(VERSION).zip nova_fx
	rm -rf ../dist/stage
	@echo "../dist/nova_fx-$(VERSION).zip"

.PHONY: clean package
