PYTHON ?= python3

.PHONY: run dev install build test test-backend test-frontend test-e2e check

run:
	$(PYTHON) server.py

dev:
	npm run dev --prefix frontend

install:
	npm ci --prefix frontend

build:
	npm run build --prefix frontend

test-backend:
	PYTHONDONTWRITEBYTECODE=1 $(PYTHON) -m unittest discover -s tests -v

test-frontend:
	npm run test --prefix frontend

test: test-backend test-frontend

test-e2e: build
	npm run test:e2e --prefix frontend

check: test build
	npm run format:check --prefix frontend
	$(PYTHON) -m compileall -q backend server.py ops
