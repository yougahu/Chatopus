#!/usr/bin/env python3
"""Install pinned OpenViking artifacts into a new, independent local root.

The application is platform-neutral; the optional native OpenViking backend is
installed from an operator-owned artifact bundle. The bundle can contain Linux
x64, Linux arm64, and macOS arm64 wheels. No service is started and an existing
installation root is never overwritten.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import time

COMMIT = "9ac008f9b86c91b79d6e93eb8df8ea7f4d48cecb"
VERSION = "0.5.3.dev0+g9ac008f9b86c"
LLAMA_VERSION = "0.3.36"
MODEL = "bge-small-zh-v1.5-f16.gguf"
MODEL_SHA256 = "ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c"

LEGACY_PROFILE = {
    "linux-x64": None,
    "linux-arm64": None,
    "macos-arm64": {
        "openviking": {
            "filename": "openviking-" + VERSION + "-cp310-abi3-macosx_14_0_arm64.whl",
            "sha256": "278f55be58ad9602b4e6cfc92d5ad38780df3288910beccff489df730ca2597b",
        },
        "llama": {
            "filename": "llama_cpp_python-0.3.36-py3-none-macosx_27_0_arm64.whl",
            "sha256": "fb39c7e35d20212a61e84cce9604f6d53aa0d93b87b4206c1e7a4061270dab67",
        },
    },
}
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+!-]*$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
PIN = re.compile(r"^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+$")
TARGETS = {"linux-x64", "linux-arm64", "macos-arm64"}


def clean_environment():
    return {k: v for k, v in os.environ.items()
            if k not in {"PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"}}


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def verify(path, expected):
    if not path.is_file() or digest(path) != expected:
        raise RuntimeError("Artifact missing or SHA-256 mismatch: " + str(path))


def platform_key(system=None, machine=None):
    system = system or platform.system()
    machine = (machine or platform.machine()).lower()
    machines = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}
    if system == "Linux" and machine in machines:
        return "linux-" + machines[machine]
    if system == "Darwin" and machine == "arm64":
        return "macos-arm64"
    raise RuntimeError("Supported OpenViking hosts are Linux x64, Linux arm64, and macOS arm64")


def runtime_links(source):
    """Repair only absolute links that point at files within the runtime."""
    repairs = {}
    known = {
        "lib/pkgconfig/python3.pc": "python-3.12.pc",
        "lib/pkgconfig/python3-embed.pc": "python-3.12-embed.pc",
        "share/man/man1/python3.1": "python3.12.1",
    }
    for path in source.rglob("*"):
        if not path.is_symlink():
            continue
        relative = str(path.relative_to(source))
        resolved = path.resolve()
        try:
            inside = resolved.relative_to(source)
        except ValueError:
            target = known.get(relative)
            if not target or not (path.parent / target).is_file():
                raise RuntimeError("External runtime symlink: " + relative)
            repairs[relative] = target
        else:
            if os.path.isabs(os.readlink(path)):
                repairs[relative] = os.path.relpath(source / inside, path.parent)
    return repairs


def _safe_artifact(value, field):
    if not isinstance(value, dict):
        raise RuntimeError("Manifest field must be an object: " + field)
    filename, sha256 = value.get("filename"), value.get("sha256")
    if not isinstance(filename, str) or Path(filename).name != filename or not SAFE_NAME.fullmatch(filename):
        raise RuntimeError("Manifest contains an unsafe artifact filename: " + field)
    if not isinstance(sha256, str) or not SHA256.fullmatch(sha256):
        raise RuntimeError("Manifest contains an invalid SHA-256: " + field)
    return {"filename": filename, "sha256": sha256}


def load_profile(artifacts, manifest_path, target):
    """Load an explicit manifest, or the one legacy macOS bundle profile."""
    selected = manifest_path
    if selected is None and (artifacts / "manifest.json").is_file():
        selected = artifacts / "manifest.json"
    if selected is None:
        profile = LEGACY_PROFILE.get(target)
        if profile is None:
            raise RuntimeError("Linux requires artifacts/manifest.json with a matching native wheel")
        requirements = {"filename": "requirements-installed.txt", "sha256": None}
        return profile, requirements, False
    selected = selected.expanduser().resolve()
    try:
        manifest = json.loads(selected.read_text())
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("Unable to read artifact manifest") from error
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 \
            or manifest.get("commit") != COMMIT or manifest.get("version") != VERSION:
        raise RuntimeError("Artifact manifest commit/version does not match the pinned OpenViking release")
    model = _safe_artifact(manifest.get("model"), "model")
    if model["filename"] != MODEL or model["sha256"] != MODEL_SHA256:
        raise RuntimeError("Artifact manifest embedding model does not match the pinned model")
    targets = manifest.get("targets")
    if not isinstance(targets, dict) or target not in targets:
        raise RuntimeError("Artifact manifest has no target profile for " + target)
    entry = targets[target]
    if not isinstance(entry, dict):
        raise RuntimeError("Artifact target profile must be an object: " + target)
    requirements = _safe_artifact(entry.get("requirements", manifest.get("requirements")), target + ".requirements")
    profile = {
        "openviking": _safe_artifact(entry.get("openviking"), target + ".openviking"),
        "llama": _safe_artifact(entry.get("llama"), target + ".llama"),
    }
    return profile, requirements, True


def inspect_runtime(python, runtime, target):
    """Reject foreign, non-3.12, venv or non-independent runtime sources early."""
    script = (
        "import json,platform,ssl,sqlite3,sys; "
        "print(json.dumps({'prefix':sys.prefix,'basePrefix':sys.base_prefix,"
        "'version':list(sys.version_info[:2]),'system':platform.system(),'machine':platform.machine()}))"
    )
    try:
        output = subprocess.check_output([str(python), "-I", "-c", script],
                                         env=clean_environment(), text=True, timeout=30)
        result = json.loads(output)
        valid = (result["version"] == [3, 12] and
                 platform_key(result["system"], result["machine"]) == target and
                 Path(result["prefix"]).resolve() == runtime and
                 Path(result["basePrefix"]).resolve() == runtime)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
        raise RuntimeError("Unable to inspect standalone Python 3.12 runtime") from error
    if not valid:
        raise RuntimeError("runtime-source must be an independent Python 3.12 directory matching " + target)
    return result


def wheel_compatible(python, filename):
    """Check the wheel's PEP 425/600 tags against the supplied runtime."""
    script = (
        "from pip._vendor.packaging.tags import sys_tags; "
        "from pip._vendor.packaging.utils import parse_wheel_filename; "
        "import json,sys; "
        "name,version,build,tags=parse_wheel_filename(sys.argv[1]); "
        "supported={str(tag) for tag in sys_tags()}; "
        "print(json.dumps({'name':str(name),'version':str(version),'compatible':bool({str(tag) for tag in tags} & supported)}))"
    )
    try:
        result = subprocess.check_output([str(python), "-I", "-c", script, filename],
                                         env=clean_environment(), text=True, timeout=30)
        parsed = json.loads(result)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise RuntimeError("Unable to inspect wheel compatibility with runtime Python") from error
    if not parsed.get("compatible"):
        raise RuntimeError("Wheel is incompatible with runtime Python/platform: " + filename)
    return parsed


def validate_wheel(python, path, distribution):
    parsed = wheel_compatible(python, path.name)
    expected = distribution.replace("_", "-").lower()
    if parsed["name"].replace("_", "-").lower() != expected:
        raise RuntimeError("Unexpected distribution in wheel: " + path.name)
    expected_version = VERSION if distribution == "openviking" else LLAMA_VERSION
    if parsed["version"] != expected_version:
        raise RuntimeError(distribution + " wheel version mismatch: " + path.name)


def load_requirements(path):
    requirements = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        if line.startswith("openviking @ ") or line.startswith("llama_cpp_python==") \
                or line.startswith("llama-cpp-python=="):
            continue
        if not PIN.fullmatch(line):
            raise RuntimeError("Expected an exact version pin in requirements")
        requirements.append(line)
    return requirements


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--runtime-source", required=True, type=Path)
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--artifact-manifest", type=Path,
                        help="Explicit artifact manifest; defaults to artifacts/manifest.json when present")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    root, runtime, artifacts = (p.expanduser().resolve() for p in
                                (args.root, args.runtime_source, args.artifacts))
    if root.exists():
        raise RuntimeError("Choose a new installation root; refusing overwrite: " + str(root))
    # copytree must never encounter its own destination inside the source.
    if root == runtime or runtime in root.parents:
        raise RuntimeError("Installation root must be outside runtime-source")
    target = platform_key()
    python = runtime / "bin/python3.12"
    if not python.is_file():
        raise RuntimeError("runtime-source must be a complete standalone Python 3.12 directory")
    runtime_links_to_repair = runtime_links(runtime)
    inspect_runtime(python, runtime, target)
    profile, requirements_spec, explicit_manifest = load_profile(
        artifacts, args.artifact_manifest, target)
    wheel = artifacts / "wheels" / profile["openviking"]["filename"]
    llama = artifacts / "wheels" / profile["llama"]["filename"]
    model = artifacts / "models" / MODEL
    verify(wheel, profile["openviking"]["sha256"])
    verify(llama, profile["llama"]["sha256"])
    verify(model, MODEL_SHA256)
    validate_wheel(python, wheel, "openviking")
    validate_wheel(python, llama, "llama-cpp-python")
    source_commit = artifacts / "source.commit"
    if not source_commit.is_file() or source_commit.read_text().strip() != COMMIT:
        raise RuntimeError("Source commit evidence mismatch")
    requirements_path = artifacts / requirements_spec["filename"]
    if requirements_spec["sha256"]:
        verify(requirements_path, requirements_spec["sha256"])
    if not requirements_path.is_file():
        raise RuntimeError("Missing requirements file: " + str(requirements_path))
    requirements = load_requirements(requirements_path)
    plan = {
        "root": str(root), "target": target, "commit": COMMIT, "version": VERSION,
        "runtimeSource": str(runtime), "runtimeCopy": str(root / "python"),
        "runtimeSymlinkRepairs": runtime_links_to_repair, "wheel": wheel.name, "llamaWheel": llama.name,
        "model": MODEL, "pinnedDependencies": len(requirements),
        "requirementsFile": requirements_path.name,
        "requirementsSha256": digest(requirements_path),
        "artifactManifest": str(args.artifact_manifest.expanduser().resolve()) if args.artifact_manifest else
                            (str((artifacts / "manifest.json").resolve()) if explicit_manifest else None),
        "startsService": False, "touchesProduction": False,
    }
    print(json.dumps(plan, ensure_ascii=False, indent=2), flush=True)
    if args.dry_run:
        return
    os.umask(0o077)
    root.mkdir(parents=True, mode=0o700)
    manifest = {**plan, "startedAt": time.time(), "status": "installing"}
    (root / "install-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.copytree(runtime, root / "python", symlinks=True)
    for relative, target_link in runtime_links_to_repair.items():
        path = root / "python" / relative
        path.unlink()
        path.symlink_to(target_link)
    copied_python = root / "python/bin/python3.12"
    clean_env = clean_environment()
    probe = subprocess.check_output([
        str(copied_python), "-I", "-c",
        "import sys,ssl,sqlite3,json; print(json.dumps({'prefix':sys.prefix,'version':sys.version.split()[0]}))",
    ], env=clean_env, text=True)
    runtime_result = json.loads(probe)
    if Path(runtime_result["prefix"]).resolve() != root / "python":
        raise RuntimeError("Copied Python did not resolve its independent prefix")
    subprocess.run([str(copied_python), "-m", "venv", str(root / "venv")], env=clean_env, check=True)
    (root / "models").mkdir()
    (root / "wheels").mkdir()
    shutil.copy2(model, root / "models" / MODEL)
    for artifact in (wheel, llama):
        shutil.copy2(artifact, root / "wheels" / artifact.name)
    lock = root / "requirements.lock.txt"
    lock.write_text("\n".join(requirements) + "\n")
    clean_env["PIP_CACHE_DIR"] = str(artifacts / "pip-cache")
    env_python = root / "venv/bin/python"
    with (root / "install.log").open("w") as log:
        subprocess.run([
            str(env_python), "-m", "pip", "install", "--no-deps", "-r", str(lock),
            str(root / "wheels" / wheel.name), str(root / "wheels" / llama.name),
        ], env=clean_env, stdout=log, stderr=subprocess.STDOUT, check=True)
        subprocess.run([str(env_python), "-m", "pip", "check"], env=clean_env,
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    version = subprocess.check_output([
        str(env_python), "-I", "-c",
        "import openviking,llama_cpp,importlib.metadata;print(importlib.metadata.version('openviking'))",
    ], env=clean_env, text=True, timeout=60).strip()
    if version != VERSION:
        raise RuntimeError("Installed OpenViking version mismatch")
    manifest.update(status="installed", finishedAt=time.time(), python=runtime_result,
                    artifacts={wheel.name: profile["openviking"]["sha256"],
                               llama.name: profile["llama"]["sha256"], MODEL: MODEL_SHA256})
    (root / "install-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"status": "installed", "root": str(root), "target": target, "version": version}))


if __name__ == "__main__":
    main()
