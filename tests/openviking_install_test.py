"""Contract tests for the platform-aware OpenViking installer."""
import hashlib
import importlib.util
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("openviking_install", ROOT / "scripts/openviking-install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class OpenVikingInstallerTest(unittest.TestCase):
    def test_supported_platform_aliases(self):
        cases = [
            (("Linux", "x86_64"), "linux-x64"),
            (("Linux", "amd64"), "linux-x64"),
            (("Linux", "aarch64"), "linux-arm64"),
            (("Linux", "arm64"), "linux-arm64"),
            (("Darwin", "arm64"), "macos-arm64"),
        ]
        for values, expected in cases:
            with self.subTest(values=values):
                self.assertEqual(installer.platform_key(*values), expected)

    def test_unsupported_platform_fails_closed(self):
        for values in [("Darwin", "x86_64"), ("Windows", "AMD64"), ("Linux", "ppc64le")]:
            with self.subTest(values=values):
                with self.assertRaisesRegex(RuntimeError, "Linux x64"):
                    installer.platform_key(*values)

    def test_manifest_selects_each_target_and_rejects_unsafe_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_hash = installer.MODEL_SHA256
            manifest = {
                "schemaVersion": 1,
                "commit": installer.COMMIT,
                "version": installer.VERSION,
                "model": {"filename": installer.MODEL, "sha256": model_hash},
                "requirements": {"filename": "requirements-installed.txt",
                                 "sha256": "0" * 64},
                "targets": {
                    target: {
                        "openviking": {"filename": f"openviking-{installer.VERSION}-cp310-abi3-manylinux_2_28_{arch}.whl",
                                       "sha256": "1" * 64},
                        "llama": {"filename": f"llama_cpp_python-0.3.36-py3-none-manylinux_2_28_{arch}.whl",
                                  "sha256": "2" * 64},
                    }
                    for target, arch in [("linux-x64", "x86_64"), ("linux-arm64", "aarch64"),
                                         ("macos-arm64", "arm64")]
                },
            }
            path = root / "manifest.json"
            path.write_text(json.dumps(manifest))
            for target in installer.TARGETS:
                profile, requirements, explicit = installer.load_profile(root, path, target)
                self.assertTrue(explicit)
                self.assertEqual(profile["openviking"]["sha256"], "1" * 64)
                self.assertEqual(requirements["filename"], "requirements-installed.txt")
            manifest["targets"]["linux-x64"]["openviking"]["filename"] = "../escape.whl"
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(RuntimeError, "unsafe artifact filename"):
                installer.load_profile(root, path, "linux-x64")

    def test_wheel_compatibility_requires_an_intersection(self):
        wheel = "openviking-" + installer.VERSION + "-cp310-abi3-manylinux_2_28_x86_64.whl"
        compatible = {"name": "openviking", "version": installer.VERSION, "compatible": True}
        with patch.object(installer.subprocess, "check_output",
                          return_value=json.dumps(compatible) + "\n") as check:
            self.assertEqual(installer.wheel_compatible(Path("/runtime/python"), wheel), compatible)
            check.assert_called_once()
        incompatible = {"name": "openviking", "version": installer.VERSION, "compatible": False}
        with patch.object(installer.subprocess, "check_output",
                          return_value=json.dumps(incompatible) + "\n"):
            with self.assertRaisesRegex(RuntimeError, "incompatible"):
                installer.wheel_compatible(Path("/runtime/python"), wheel)

    def test_native_runtime_accepts_universal_and_rejects_foreign_wheel(self):
        python = Path(sys.executable)
        # Invoke the real interpreter and its pip tags; never load a backend.
        result = installer.wheel_compatible(python, "synthetic_package-1.0-py3-none-any.whl")
        self.assertEqual(result["name"], "synthetic-package")
        foreign = ("win_amd64" if sys.platform != "win32" else "manylinux_2_28_x86_64")
        with self.assertRaisesRegex(RuntimeError, "incompatible"):
            installer.wheel_compatible(python, "synthetic_package-1.0-py3-none-" + foreign + ".whl")
        with self.assertRaisesRegex(RuntimeError, "Unexpected distribution"):
            installer.validate_wheel(python, Path("synthetic_package-1.0-py3-none-any.whl"), "openviking")
        with self.assertRaisesRegex(RuntimeError, "version mismatch"):
            installer.validate_wheel(python, Path("openviking-0.0.1-py3-none-any.whl"), "openviking")
        with self.assertRaisesRegex(RuntimeError, "version mismatch"):
            installer.validate_wheel(python, Path("llama_cpp_python-0.0.1-py3-none-any.whl"), "llama-cpp-python")

    def test_independent_python_must_match_host_version_architecture_and_prefix(self):
        root = Path("/synthetic-python")
        valid = {"prefix": str(root), "basePrefix": str(root), "version": [3, 12],
                 "system": "Linux", "machine": "aarch64"}
        for changes in [{}, {"version": [3, 11]}, {"machine": "x86_64"},
                        {"system": "Darwin", "machine": "arm64"},
                        {"basePrefix": "/system-python"}, {"prefix": "/system-python"}]:
            result = {**valid, **changes}
            with self.subTest(changes=changes), patch.object(installer.subprocess, "check_output", return_value=json.dumps(result)):
                if changes:
                    with self.assertRaisesRegex(RuntimeError, "independent Python 3.12"):
                        installer.inspect_runtime(root / "bin/python3.12", root, "linux-arm64")
                else:
                    self.assertEqual(installer.inspect_runtime(root / "bin/python3.12", root, "linux-arm64"), valid)

    def test_requirements_are_exact_and_exclude_native_distributions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "requirements.txt"
            path.write_text("requests==2.32.3\nopenviking @ file:///private/wheel.whl\nllama_cpp_python==0.3.36\n")
            self.assertEqual(installer.load_requirements(path), ["requests==2.32.3"])
            path.write_text("requests>=2.0\n")
            with self.assertRaisesRegex(RuntimeError, "exact version pin"):
                installer.load_requirements(path)


class InstallerDryRunTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.artifacts = self.base / "artifacts"
        self.runtime = self.base / "python"
        self.destination = self.base / "new-installation"
        (self.runtime / "bin").mkdir(parents=True)
        (self.runtime / "bin/python3.12").touch()
        (self.artifacts / "wheels").mkdir(parents=True)
        (self.artifacts / "models").mkdir()
        self.model = self.artifacts / "models" / installer.MODEL
        self.model.write_bytes(b"synthetic embedding model")
        self.model_hash = installer.digest(self.model)
        (self.artifacts / "source.commit").write_text(installer.COMMIT + "\n")
        self.manifest = {"schemaVersion": 1, "commit": installer.COMMIT, "version": installer.VERSION,
                         "model": {"filename": installer.MODEL, "sha256": self.model_hash}, "targets": {}}
        for target, tag in [("linux-x64", "manylinux_2_28_x86_64"),
                            ("linux-arm64", "manylinux_2_28_aarch64"),
                            ("macos-arm64", "macosx_14_0_arm64")]:
            entry = {}
            for key, distribution, version in [("openviking", "openviking", installer.VERSION),
                                                ("llama", "llama_cpp_python", "0.3.36")]:
                name = f"{distribution}-{version}-py3-none-{tag}.whl"
                path = self.artifacts / "wheels" / name
                path.write_bytes(("synthetic wheel " + name).encode())
                entry[key] = {"filename": name, "sha256": installer.digest(path)}
            requirements = self.artifacts / ("requirements-" + target + ".txt")
            requirements.write_text("synthetic_dependency==1.0.0\n")
            entry["requirements"] = {"filename": requirements.name, "sha256": installer.digest(requirements)}
            self.manifest["targets"][target] = entry
        self.save_manifest()

    def save_manifest(self):
        (self.artifacts / "manifest.json").write_text(json.dumps(self.manifest))

    def invoke(self, target="linux-arm64", compatibility=True, extra=()):
        system, machine = {"linux-x64": ("Linux", "x86_64"), "linux-arm64": ("Linux", "aarch64"),
                           "macos-arm64": ("Darwin", "arm64")}[target]
        runtime = {"prefix": str(self.runtime), "basePrefix": str(self.runtime), "version": [3, 12],
                   "system": system, "machine": machine}

        def probe(command, **kwargs):
            if command[-1].endswith(".whl"):
                parts = command[-1].split("-")
                return json.dumps({"name": parts[0].replace("_", "-"), "version": parts[1],
                                   "compatible": compatibility})
            return json.dumps(runtime)

        output = io.StringIO()
        arguments = ["openviking-install.py", "--root", str(self.destination), "--runtime-source", str(self.runtime),
                     "--artifacts", str(self.artifacts), "--dry-run", *extra]
        with (patch.object(sys, "argv", arguments),
              patch.object(installer.platform, "system", return_value=system),
              patch.object(installer.platform, "machine", return_value=machine),
              patch.object(installer, "MODEL_SHA256", self.model_hash),
              patch.object(installer.subprocess, "check_output", side_effect=probe),
              patch.object(installer.subprocess, "run") as install,
              contextlib.redirect_stdout(output)):
            try:
                installer.main()
            finally:
                install.assert_not_called()
        return json.loads(output.getvalue())

    def test_three_targets_select_their_own_wheels_and_lock_without_writes(self):
        before = {str(p): p.stat().st_mtime_ns for p in self.base.rglob("*")}
        for target in sorted(installer.TARGETS):
            with self.subTest(target=target):
                result = self.invoke(target)
                self.assertEqual(result["target"], target)
                self.assertEqual(result["wheel"], self.manifest["targets"][target]["openviking"]["filename"])
                self.assertEqual(result["requirementsFile"], "requirements-" + target + ".txt")
                self.assertFalse(result["startsService"])
                self.assertFalse(self.destination.exists())
        self.assertEqual(before, {str(p): p.stat().st_mtime_ns for p in self.base.rglob("*")})

    def test_wheel_corruption_is_rejected_before_creating_root(self):
        wheel = self.artifacts / "wheels" / self.manifest["targets"]["linux-arm64"]["llama"]["filename"]
        wheel.write_bytes(b"damaged wheel")
        with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
            self.invoke()
        self.assertFalse(self.destination.exists())

    def test_incompatible_wheel_is_rejected_before_creating_root(self):
        with self.assertRaisesRegex(RuntimeError, "incompatible"):
            self.invoke(compatibility=False)
        self.assertFalse(self.destination.exists())

    def test_changed_dependency_lock_is_rejected_before_creating_root(self):
        (self.artifacts / "requirements-linux-arm64.txt").write_text("synthetic_dependency==2.0.0\n")
        with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
            self.invoke()
        self.assertFalse(self.destination.exists())

    def test_manifest_cannot_replace_pinned_backend_or_embedding_model(self):
        for changes, message in [({"commit": "0" * 40}, "commit/version"),
                                 ({"version": "99.0"}, "commit/version"),
                                 ({"model": {"filename": installer.MODEL, "sha256": "0" * 64}}, "embedding model")]:
            original = self.manifest.copy()
            self.manifest.update(changes)
            self.save_manifest()
            with self.subTest(changes=changes), self.assertRaisesRegex(RuntimeError, message):
                self.invoke()
            self.manifest = original
        self.assertFalse(self.destination.exists())

    def test_missing_linux_profile_has_no_legacy_fallback(self):
        (self.artifacts / "manifest.json").unlink()
        with self.assertRaisesRegex(RuntimeError, "Linux requires"):
            self.invoke()
        self.assertFalse(self.destination.exists())

    def test_explicit_manifest_does_not_silently_fall_back(self):
        with self.assertRaisesRegex(RuntimeError, "Unable to read artifact manifest"):
            self.invoke(extra=("--artifact-manifest", str(self.base / "missing.json")))

    def test_existing_root_is_never_modified(self):
        self.destination.mkdir()
        sentinel = self.destination / "existing.txt"
        sentinel.write_text("keep me")
        with self.assertRaisesRegex(RuntimeError, "refusing overwrite"):
            self.invoke()
        self.assertEqual(sentinel.read_text(), "keep me")

    def test_root_inside_python_source_is_rejected_without_copying(self):
        self.destination = self.runtime / "nested-installation"
        with self.assertRaisesRegex(RuntimeError, "outside runtime-source"):
            self.invoke()
        self.assertFalse(self.destination.exists())

    def test_external_runtime_symlink_is_rejected(self):
        (self.runtime / "outside").symlink_to(self.artifacts)
        with self.assertRaisesRegex(RuntimeError, "External runtime symlink"):
            self.invoke()
        self.assertFalse(self.destination.exists())


if __name__ == "__main__":
    unittest.main()

