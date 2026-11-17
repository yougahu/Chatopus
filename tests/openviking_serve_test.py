"""Exercise launcher persistence with temporary files, without starting services."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("openviking_serve", ROOT / "scripts/openviking-serve.py")
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


class OpenVikingServeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "venv/bin").mkdir(parents=True)
        (self.root / "venv/bin/openviking-server").touch()
        (self.root / "models").mkdir()
        self.model = self.root / "models/bge-small-zh-v1.5-f16.gguf"
        self.model.write_bytes(b"local embedding fixture")
        self.config = self.root / "ov.conf"

    def run_launcher(self, *args, environment=None):
        output = io.StringIO()
        original_open, descriptors = os.open, []

        def track_open(*values, **kwargs):
            fd = original_open(*values, **kwargs)
            descriptors.append(fd)
            return fd

        previous_umask = os.umask(0o022)
        try:
            with (patch.object(sys, "argv", ["openviking-serve.py", "--root", str(self.root), *args]),
                  patch.object(serve, "MODEL_SHA256", hashlib.sha256(self.model.read_bytes()).hexdigest()),
                  patch.dict(os.environ, environment or {}, clear=True),
                  patch.object(serve.os, "open", side_effect=track_open),
                  patch.object(serve.socket, "socket") as socket,
                  contextlib.redirect_stdout(output)):
                socket.return_value.__enter__.return_value.connect_ex.return_value = 1
                serve.main()
        finally:
            os.umask(previous_umask)
            for fd in descriptors:
                os.close(fd)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def save_vlm(self, vlm):
        self.config.write_text(json.dumps({"vlm": vlm}))
        self.config.chmod(0o600)

    def files(self):
        return {str(path.relative_to(self.root)): (path.read_bytes(), path.stat().st_mtime_ns)
                for path in self.root.rglob("*") if path.is_file()}

    def test_initial_prepare_uses_legacy_arguments_and_keeps_credentials_private(self):
        output = self.run_launcher("--prepare-only", "--vlm-model", "initial-model",
                                   "--vlm-base-url", "https://initial.invalid/v1",
                                   "--vlm-api-key-env", "CUSTOM_VLM_KEY",
                                   environment={"CUSTOM_VLM_KEY": "initial-private-key"})
        config = json.loads(self.config.read_text())
        self.assertEqual(config["vlm"]["model"], "initial-model")
        self.assertEqual(config["vlm"]["api_key"], "initial-private-key")
        self.assertEqual(config["memory"]["custom_templates_dir"],
                         str(ROOT / "scripts/openviking-memory-templates"))
        self.assertEqual(output[0]["modelConfigurationSource"], "launcher")
        self.assertEqual(output[0]["modelDomain"], "initial.invalid")
        self.assertNotIn("initial-private-key", json.dumps(output))
        for name in ["ov.conf", "root-api-key", "serve-manifest.json"]:
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o600)

    def test_admin_credentials_and_tuning_survive_relaunch_without_old_env_file(self):
        self.run_launcher("--prepare-only", environment={"OPENVIKING_VLM_API_KEY": "initial-private-key"})
        before = json.loads(self.config.read_text())
        saved = {"model": "admin-model", "credentials": [{"id": "primary", "provider": "openai",
                 "api_base": "https://updated.invalid/v1", "api_key": "updated-private-key",
                 "extra_request_body": {"thinking": {"type": "disabled"}}}],
                 "timeout": 42, "max_retries": 1, "max_concurrent": 2}
        before["vlm"] = saved
        self.config.write_text(json.dumps(before))
        root_key = (self.root / "root-api-key").read_bytes()
        output = self.run_launcher("--prepare-only", "--env-file", str(self.root / "missing.env"),
                                   "--vlm-model", "old-launchd-model",
                                   "--vlm-base-url", "https://old.invalid")
        self.assertEqual(json.loads(self.config.read_text())["vlm"], saved)
        self.assertEqual((self.root / "root-api-key").read_bytes(), root_key)
        self.assertEqual(output[0]["model"], "admin-model")
        self.assertEqual(output[0]["modelDomain"], "updated.invalid")
        self.assertEqual(output[0]["modelConfigurationSource"], "ov.conf")
        self.assertIsNone(output[0]["credentialVariable"])
        self.assertTrue(output[0]["credentialConfigured"])
        self.assertNotIn("updated-private-key", json.dumps(output))
        self.assertNotIn(root_key.decode().strip(), json.dumps(output))

    def test_existing_legacy_vlm_also_takes_precedence_over_environment_defaults(self):
        saved = {"provider": "openai", "model": "saved-model", "api_key": "saved-private-key",
                 "api_base": "https://saved.invalid", "extra_request_body": {"thinking": {"type": "disabled"}}}
        self.save_vlm(saved)
        self.run_launcher("--prepare-only", environment={"OPENVIKING_VLM_API_KEY": "different-private-key"})
        self.assertEqual(json.loads(self.config.read_text())["vlm"], saved)

    def test_dry_run_of_saved_configuration_does_not_create_or_modify_files(self):
        self.save_vlm({"model": "saved", "api_key": "private-value", "api_base": "https://saved.invalid"})
        before = self.files()
        output = self.run_launcher("--dry-run")
        self.assertEqual(before, self.files())
        self.assertEqual(output[0]["model"], "saved")
        self.assertNotIn("private-value", json.dumps(output))

    def test_dry_run_of_initial_configuration_does_not_create_files(self):
        before = self.files()
        output = self.run_launcher("--dry-run", environment={"OPENVIKING_VLM_API_KEY": "private-value"})
        self.assertEqual(before, self.files())
        self.assertEqual(output[0]["model"], "deepseek-flash")
        self.assertNotIn("private-value", json.dumps(output))

    def test_invalid_or_public_saved_configuration_fails_without_overwriting_it(self):
        for text, mode, error in [('private-secret-not-json', 0o600, 'valid VLM'),
                                  ('{"vlm": {}}', 0o600, 'valid VLM'),
                                  ('{"vlm":{"api_key":"private-secret"}}', 0o644, 'permissions')]:
            with self.subTest(mode=mode, error=error):
                self.config.write_text(text)
                self.config.chmod(mode)
                before = self.files()
                with self.assertRaisesRegex(RuntimeError, error) as caught:
                    self.run_launcher("--prepare-only", environment={"OPENVIKING_VLM_API_KEY": "fallback-private-key"})
                self.assertNotIn('private-secret', str(caught.exception))
                self.assertEqual(before, self.files())


if __name__ == "__main__":
    unittest.main()
