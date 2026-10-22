PYTHON ?= python3

.PHONY: run test check

run:
	$(PYTHON) server.py

test:
	PYTHONDONTWRITEBYTECODE=1 $(PYTHON) -m unittest discover -s tests -v

check: test
	$(PYTHON) -m py_compile server.py
