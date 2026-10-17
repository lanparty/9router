SHELL := /usr/bin/env bash

# Load .env (if present) into the environment of every recipe. Sourcing via the
# shell keeps quoting/spaces in values intact, unlike Make's `include`.
ENV_FILE ?= .env
# Values already in the environment (or given as `make PORT=...`) win over .env.
LOAD_ENV := _P="$$PORT"; set -a; [ -f "$(ENV_FILE)" ] && . "$(ENV_FILE)"; set +a; [ -n "$$_P" ] && PORT="$$_P";

# Fallbacks when neither the shell nor .env sets them (override: make dev PORT=3000).
DEFAULT_PORT ?= 20128

VERSION ?= $(shell node -p "require('./package.json').version")
TARBALL ?= 9router-$(shell node -p "require('./cli/package.json').version").tgz
IMAGE   ?= maxzio/9router

.DEFAULT_GOAL := help

.PHONY: help install dev dev-webpack build start prod docker cli-tarball cli-install cli-uninstall cli-reinstall

help:
	@printf '%s\n' \
		'make install        npm install (root)' \
		'make dev            Dev server (Turbopack), reads .env (PORT, default $(DEFAULT_PORT))' \
		'make dev-webpack    Dev server with webpack (broken CSS on next 16.3.7)' \
		'make build          Production build' \
		'make start          Run the built production server, reads .env' \
		'make prod           build + start' \
		'make docker         Build the Docker image ($(IMAGE):$(VERSION))' \
		'make cli-tarball    Build the CLI tarball' \
		'make cli-install    Install the CLI tarball globally' \
		'make cli-uninstall  Uninstall the global 9router' \
		'make cli-reinstall  Rebuild, then reinstall the CLI globally' \
		'' \
		'Options: ENV_FILE=path/to/.env  PORT=20128  BIND_HOST=0.0.0.0  (PORT/BIND_HOST from the environment or command line win over .env)'

install:
	npm install

# `--port` after `--` overrides the fixed port baked into the npm script.
# Turbopack is the default: webpack dev cannot parse the CSS imports on next 16.3.7.
dev:
	@$(LOAD_ENV) \
	 PORT="$${PORT:-$(DEFAULT_PORT)}"; export PORT; \
	 echo "dev (turbopack) on port $$PORT"; \
	 exec npm run dev -- --port "$$PORT"

dev-webpack:
	@$(LOAD_ENV) \
	 PORT="$${PORT:-$(DEFAULT_PORT)}"; export PORT; \
	 echo "dev (webpack) on port $$PORT"; \
	 exec npm run dev:webpack -- --port "$$PORT"

build:
	@$(LOAD_ENV) exec npm run build

start:
	@$(LOAD_ENV) \
	 PORT="$${PORT:-$(DEFAULT_PORT)}"; export PORT; \
	 HOSTNAME="$${BIND_HOST:-0.0.0.0}"; export HOSTNAME; \
	 echo "start on $$HOSTNAME:$$PORT"; \
	 exec npm run start -- --port "$$PORT"

prod: build start

docker:
	docker build -t "$(IMAGE):$(VERSION)" -t "$(IMAGE):latest" .

cli-tarball:
	@scripts/build-cli-tarball.sh

cli-uninstall:
	npm uninstall -g 9router

cli-install:
	@test -f "$(TARBALL)" || { printf 'Missing %s; run make cli-tarball first\n' "$(TARBALL)" >&2; exit 1; }
	npm i -g ./$(TARBALL)

cli-reinstall: cli-tarball cli-uninstall cli-install
