.PHONY: usage setup start build clean fmt deploy config infra
.PHONY: test test/lint test/unit test/worker test/integration test/infra

args ?=
environment ?= .

usage:
	@cat .usage

setup: node_modules

node_modules:
	yarn install --immutable

start: setup
	yarn migrate:local
	yarn dev

build: setup
	yarn build

clean:
	rm -rf node_modules cloudflare/generated service/assets/css/output.css

fmt: setup
	yarn format
	terraform fmt -recursive infra/cloudflare

deploy: setup
	yarn --cwd "${environment}" deploy ${args}

config: setup
	yarn config

infra: setup
	yarn infra ${args}

test: test/lint test/unit test/worker test/integration test/infra

test/lint: setup
	yarn lint

test/unit: setup
	yarn test:unit
	yarn test:deployment

test/worker: setup
	yarn check:worker

test/integration: setup
	yarn test:integration

test/infra: setup
	yarn check:infra
