#!/usr/bin/env python3
"""Run one local OpenViking process with private generated configuration.

This launcher never starts VikingBot, daemonizes, or changes a launchd service.
Use an absolute Python path when installing it as a launchd entry point.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import stat
import sys
from urllib.parse import urlsplit

MODEL_SHA256 = "ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c"


def read_credential(name, env_file):
    result = os.environ.get(name)
    if env_file:
        if stat.S_IMODE(env_file.stat().st_mode) & 0o077:
            raise RuntimeError("Credential env file must not be group/world accessible")
        for line in env_file.read_text().splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip().removeprefix("export ") == name:
                parts = shlex.split(value, comments=True)
                result = " ".join(parts)
    return result


def private_write(path, text):
    temporary = path.with_name(path.name + ".new")
    with temporary.open("w") as output:
        os.chmod(temporary, 0o600)
        output.write(text)
    os.replace(temporary, path)


def model_configuration(args, env_file):
    """The saved private file owns VLM settings after initial provisioning."""
    config_path = args.root.expanduser().resolve() / "ov.conf"
    if config_path.exists():
        if stat.S_IMODE(config_path.stat().st_mode) & 0o077:
            raise RuntimeError("ov.conf permissions must be 600")
        try:
            saved = json.loads(config_path.read_text())
            vlm = saved.get("vlm")
            if not isinstance(vlm, dict) or not vlm:
                raise ValueError()
        except (ValueError, AttributeError, UnicodeError):
            # Neither parse errors nor invalid values may expose private file contents.
            raise RuntimeError("Existing ov.conf must contain a valid VLM configuration") from None
        return vlm, "ov.conf"
    base = urlsplit(args.vlm_base_url)
    if (base.scheme not in {"https", "http"} or not base.hostname
            or base.username or base.password or base.query or base.fragment):
        raise RuntimeError("Invalid model base URL")
    credential = read_credential(args.vlm_api_key_env, env_file)
    if not credential:
        raise RuntimeError("Model credential is missing: " + args.vlm_api_key_env)
    return {
        "provider": "openai", "model": args.vlm_model, "api_base": args.vlm_base_url,
        "api_key": credential, "max_concurrent": 2, "max_retries": 1, "timeout": 60,
        "extra_request_body": {"thinking": {"type": "disabled"}},
    }, "launcher"


def model_description(vlm):
    """Project only non-secret identity fields, including the credentials-list format."""
    credentials = vlm.get("credentials") or []
    first = credentials[0] if credentials and isinstance(credentials[0], dict) else {}
    endpoint = first.get("api_base") or vlm.get("api_base")
    return {
        "model": first.get("model") or vlm.get("model"),
        "modelDomain": urlsplit(endpoint).hostname if isinstance(endpoint, str) else None,
        "credentialConfigured": bool(first.get("api_key") or vlm.get("api_key")),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--port", type=int, default=1933)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--vlm-api-key-env", default="OPENVIKING_VLM_API_KEY", help="Initial VLM key source; saved ov.conf takes precedence")
    parser.add_argument("--vlm-model", default="deepseek-flash", help="Initial model; saved ov.conf takes precedence")
    parser.add_argument("--vlm-base-url", default="https://api.deepseek.com", help="Initial API base; saved ov.conf takes precedence")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--prepare-only", action="store_true",
                      help="Write private key/configuration without starting a service")
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    workspace = (args.workspace or root / "data").expanduser().resolve()
    if not 1 <= args.port <= 65535:
        raise RuntimeError("Invalid port")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", args.vlm_api_key_env):
        raise RuntimeError("Invalid credential environment variable name")
    env_file = args.env_file.expanduser().resolve() if args.env_file else None
    vlm, vlm_source = model_configuration(args, env_file)
    server = root / "venv/bin/openviking-server"
    model = root / "models/bge-small-zh-v1.5-f16.gguf"
    if not server.is_file() or not model.is_file():
        raise RuntimeError("Run openviking-install.py first")
    if hashlib.sha256(model.read_bytes()).hexdigest() != MODEL_SHA256:
        raise RuntimeError("Embedding model SHA-256 mismatch")
    description = {
        "endpoint": "http://127.0.0.1:" + str(args.port), "workspace": str(workspace),
        **model_description(vlm), "modelConfigurationSource": vlm_source,
        "credentialVariable": args.vlm_api_key_env if vlm_source == "launcher" else None,
        "embedding": "bge-small-zh-v1.5-f16", "embeddingDimension": 512,
        "vikingBot": False, "rootKeyFile": str(root / "root-api-key"),
    }
    print(json.dumps(description, ensure_ascii=False), flush=True)
    if args.dry_run:
        return
    os.umask(0o077)
    # Hold through exec so two launchers cannot generate different root keys
    # before the HTTP listener and the backend's workspace lock are acquired.
    launch_lock = os.open(root / "launcher.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(launch_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise RuntimeError("Another launcher owns this installation") from error
    os.set_inheritable(launch_lock, True)
    # Do not rewrite secrets or runtime configuration while another listener runs.
    with socket.socket() as probe:
        probe.settimeout(0.3)
        if probe.connect_ex(("127.0.0.1", args.port)) == 0:
            raise RuntimeError("Requested local port is already occupied")
    root_key_file = root / "root-api-key"
    if root_key_file.exists():
        if stat.S_IMODE(root_key_file.stat().st_mode) & 0o077:
            raise RuntimeError("root-api-key permissions must be 600")
        root_key = root_key_file.read_text().strip()
        if len(root_key) < 32:
            raise RuntimeError("Invalid existing root-api-key")
    else:
        root_key = secrets.token_hex(32)
        private_write(root_key_file, root_key + "\n")
    config = {
        "server": {"host": "127.0.0.1", "port": args.port, "auth_mode": "api_key",
                   "root_api_key": root_key, "with_bot": False},
        "storage": {"workspace": str(workspace), "agfs": {"backend": "local", "queuefs": {"backend": "sqlite"}},
                    "vectordb": {"backend": "local"}},
        "embedding": {"max_concurrent": 2, "max_input_tokens": 256,
                      "dense": {"provider": "local", "model": "bge-small-zh-v1.5-f16",
                                "dimension": 512, "model_path": str(model)}},
        "vlm": vlm,
        # Deployment-owned schemas pair with the runtime source guard. Model/admin
        # edits cannot turn generated prose into member facts or select its owner.
        "memory": {"custom_templates_dir": str(Path(__file__).resolve().with_name("openviking-memory-templates"))},
    }
    config_path = root / "ov.conf"
    private_write(config_path, json.dumps(config, ensure_ascii=False, indent=2) + "\n")
    private_write(root / "serve-manifest.json", json.dumps(description, indent=2) + "\n")
    if args.prepare_only:
        print(json.dumps({"status": "prepared", "config": str(config_path), "startsService": False}))
        return
    env = {k: v for k, v in os.environ.items() if k not in {"PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"}}
    env["OPENVIKING_CONFIG_FILE"] = str(config_path)
    os.chdir(root)
    python = root / "venv/bin/python"
    guarded_server = Path(__file__).resolve().with_name("openviking-server.py")
    os.execve(str(python), [str(python), str(guarded_server), "--config", str(config_path),
                           "--host", "127.0.0.1", "--port", str(args.port)], env)


if __name__ == "__main__":
    main()
