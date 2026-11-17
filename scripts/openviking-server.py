#!/usr/bin/env python3
"""Start the pinned server with the repository-owned memory source guard."""
import importlib.util
import os
from pathlib import Path
import sys

# Bind configuration before any OpenViking import initializes its singleton.
for index, arg in enumerate(sys.argv):
    if arg == "--config" and index + 1 < len(sys.argv):
        os.environ["OPENVIKING_CONFIG_FILE"] = sys.argv[index + 1]
    elif arg.startswith("--config="):
        os.environ["OPENVIKING_CONFIG_FILE"] = arg.split("=", 1)[1]

spec = importlib.util.spec_from_file_location("boe_memory_guard", Path(__file__).with_name("openviking-memory-guard.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.install()
from openviking_cli.server_bootstrap import main
sys.exit(main())
