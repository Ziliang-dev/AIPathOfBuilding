"""Windows portable and NSIS packaging implementation for scripts/aipob.py."""

from __future__ import annotations

import argparse
import configparser
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parent.parent
SIDECAR = ROOT / "sidecar"
POB_EXECUTABLE_NAMES = ("Path of Building.exe", "Path{space}of{space}Building.exe", "PathOfBuilding.exe")
UPDATE_BRANCH_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$")


def fail(message: str) -> "NoReturn":
    raise RuntimeError(message)


def required_file(path: Path, description: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file():
        fail(f"{description} not found: {resolved}")
    return resolved


def required_directory(path: Path, description: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_dir():
        fail(f"{description} not found: {resolved}")
    return resolved


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_sha1(path: Path) -> str:
    data = path.read_bytes()
    if b"\0" not in data:
        data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n").replace(b"\n", b"\r\n")
    return hashlib.sha1(data).hexdigest()


def validate_update_branch(value: str) -> str:
    branch = value.strip()
    if (
        UPDATE_BRANCH_PATTERN.fullmatch(branch) is None
        or branch.endswith("/")
        or "//" in branch
        or ".." in branch.split("/")
    ):
        fail(f"Invalid package update branch: {value!r}")
    return branch


def write_runtime_manifest(source: Path, destination: Path, update_branch: str) -> None:
    branch = validate_update_branch(update_branch)
    tree = ET.parse(required_file(source, "release manifest"))
    root = tree.getroot()
    versions = root.findall("Version")
    if root.tag != "PoBVersion" or len(versions) != 1:
        fail("Release manifest must contain exactly one PoBVersion/Version element.")
    versions[0].set("branch", branch)
    versions[0].set("platform", "win32")
    destination.parent.mkdir(parents=True, exist_ok=True)
    tree.write(destination, encoding="UTF-8", xml_declaration=True)


def validate_runtime_manifest(path: Path, metadata: dict[str, object]) -> None:
    manifest = ET.parse(path).getroot()
    versions = manifest.findall("Version")
    update = metadata.get("update")
    if (
        len(versions) != 1
        or not isinstance(update, dict)
        or versions[0].get("branch") != update.get("branch")
        or versions[0].get("platform") != "win32"
        or update.get("platform") != "win32"
    ):
        fail("Packaged manifest must identify its exact update branch and win32 platform.")


def safe_member(name: str) -> PurePosixPath:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    if not normalized or normalized.startswith("/") or path.is_absolute() or ".." in path.parts:
        fail(f"Archive contains an unsafe path: {name}")
    if path.parts and ":" in path.parts[0]:
        fail(f"Archive contains an unsafe path: {name}")
    return path


def safe_extract(archive_path: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive_path) as archive:
        for entry in archive.infolist():
            safe_member(entry.filename)
        archive.extractall(destination)


def safe_package_path(root: Path, relative: str) -> Path:
    member = safe_member(relative)
    candidate = (root / Path(*member.parts)).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise RuntimeError(f"Package metadata escapes package root: {relative}") from error
    return candidate


def run_capture(arguments: list[str], *, cwd: Path, timeout: float = 30) -> str:
    arguments = windows_interop_arguments(arguments)
    completed = subprocess.run(
        arguments,
        cwd=cwd,
        check=True,
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    return completed.stdout.strip()


def windows_interop_arguments(arguments: list[str]) -> list[str]:
    if os.name == "nt" or not Path(arguments[0]).name.lower().endswith(".exe"):
        return arguments
    wslpath = shutil.which("wslpath")
    if wslpath is None:
        fail("wslpath is required to pass WSL paths to a Windows executable.")
    converted = [arguments[0]]
    for argument in arguments[1:]:
        if argument.startswith("/") and not re.match(r"^/[A-Za-z](?:=|$)", argument):
            result = subprocess.run(
                [wslpath, "-w", argument],
                check=True,
                text=True,
                capture_output=True,
            )
            converted.append(result.stdout.strip())
        else:
            converted.append(argument)
    return converted


def parse_list(value: str | None) -> list[str]:
    if value is None:
        return []
    return [entry.strip() for entry in value.split(",") if entry.strip()]


def path_matches(repo_relative: str, patterns: list[str]) -> bool:
    candidate = repo_relative.replace("\\", "/").strip("/").lower()
    for pattern in patterns:
        normalized = pattern.replace("\\", "/").strip("/").lower()
        if candidate == normalized or candidate.startswith(f"{normalized}/"):
            return True
    return False


def file_matches(name: str, patterns: list[str]) -> bool:
    lowered = name.lower()
    return any(fnmatch.fnmatch(lowered, pattern.lower()) for pattern in patterns)


def manifest_files(config_path: Path) -> list[tuple[Path, str]]:
    config = configparser.ConfigParser()
    config.read(config_path, encoding="utf-8")
    selected: list[tuple[Path, str]] = []
    for section_name in config.sections():
        if section_name == "sidecar":
            continue
        source_value = config[section_name].get("path", "").strip()
        source = ROOT if source_value in ("", ".") else ROOT / source_value
        required_directory(source, f"Manifest section [{section_name}] source directory")
        include_files = parse_list(config[section_name].get("include-files"))
        include_directories = parse_list(config[section_name].get("include-directories"))
        exclude_files = parse_list(config[section_name].get("exclude-files"))
        exclude_directories = parse_list(config[section_name].get("exclude-directories"))
        for file_path in sorted(path for path in source.rglob("*") if path.is_file()):
            repo_relative = file_path.relative_to(ROOT).as_posix()
            if include_files and not file_matches(file_path.name, include_files):
                continue
            if include_directories and not path_matches(repo_relative, include_directories):
                continue
            if exclude_files and file_matches(file_path.name, exclude_files):
                continue
            if exclude_directories and path_matches(repo_relative, exclude_directories):
                continue
            relative_source = file_path.relative_to(source).as_posix()
            trimmed_source = source_value.rstrip("/\\")
            destination = relative_source if source_value in ("", ".") else f"{trimmed_source}/{relative_source}"
            selected.append((file_path, destination.replace("\\", "/")))
    return selected


def copy_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def create_zip(source: Path, destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file_path in sorted(path for path in source.rglob("*") if path.is_file()):
            archive.write(file_path, file_path.relative_to(source).as_posix())


def runtime_tree_hash(source: Path) -> str:
    digest = hashlib.sha256()
    for file_path in sorted(path for path in source.rglob("*") if path.is_file()):
        relative = file_path.relative_to(source).as_posix().encode("utf-8")
        digest.update(relative)
        digest.update(b"\0")
        digest.update(bytes.fromhex(sha256(file_path)))
    return digest.hexdigest()


def copy_runtime_tree(source: Path, destination: Path) -> None:
    for file_path in sorted(path for path in source.rglob("*") if path.is_file()):
        relative = file_path.relative_to(source).as_posix().replace("{space}", " ")
        copy_file(file_path, safe_package_path(destination, relative))


def remove_tree(path: Path, timeout: float = 15) -> None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.1)


def package_windows(args: argparse.Namespace) -> None:
    from aipob import build_sidecar

    node_value = args.node_exe or os.environ.get("AIPOB_NODE_EXE") or shutil.which("node.exe") or shutil.which("node")
    if not node_value:
        fail("Pass --node-exe or set AIPOB_NODE_EXE to a portable Node.js 24 node.exe.")
    node_path = required_file(Path(node_value), "Node runtime")
    if node_path.name.lower() != "node.exe":
        fail(f"Node runtime must be a node.exe file; received {node_path}.")
    node_info = json.loads(run_capture([
        str(node_path),
        "-p",
        "JSON.stringify({version:process.version,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch})",
    ], cwd=node_path.parent))
    if node_info["version"].removeprefix("v") != "24.20.0":
        fail(f"Portable package requires Node.js 24.20.0; found {node_info['version']}.")
    if f"{node_info['platform']}:{node_info['arch']}" != "win32:x64":
        fail(f"Portable package requires win32:x64 Node.js; found {node_info['platform']}:{node_info['arch']}.")
    if str(node_info["modules"]) != "137":
        fail(f"Portable package requires Node ABI 137; found {node_info['modules']}.")

    manifest_config = required_file(Path(args.manifest_config or ROOT / "manifest.cfg"), "Manifest configuration")
    runtime_archive = required_file(Path(args.runtime_archive), "Windows runtime archive") if args.runtime_archive else None
    runtime_source = required_directory(ROOT / "runtime", "Tracked Windows runtime")
    if runtime_archive is not None:
        with zipfile.ZipFile(runtime_archive) as archive:
            for entry in archive.infolist():
                safe_member(entry.filename)
    credential_helper = required_file(
        Path(args.credential_helper or ROOT / "native" / "wincred-helper" / "wincred-helper.exe"),
        "WinCred helper",
    )
    if args.sidecar_bundle:
        bundle_path = required_file(Path(args.sidecar_bundle), "Sidecar artifact")
    else:
        if not args.skip_build:
            build_sidecar(argparse.Namespace(skip_checks=False))
        bundle_path = required_file(SIDECAR / "dist" / "server.cjs", "Sidecar release entry")

    schema_source = required_file(SIDECAR / "src" / "schemas.ts", "sidecar schema source").read_text(encoding="utf-8")
    import re
    schema_match = re.search(r"SCHEMA_VERSION\s*=\s*(\d+)", schema_source)
    protocol_match = re.search(r"PROTOCOL_VERSION\s*=\s*(\d+)", schema_source)
    if schema_match is None or protocol_match is None:
        fail("Unable to read sidecar schema/protocol versions.")
    schema_version = int(schema_match.group(1))
    protocol_version = int(protocol_match.group(1))
    update_branch = validate_update_branch(
        args.update_branch
        or os.environ.get("GITHUB_HEAD_REF")
        or os.environ.get("GITHUB_REF_NAME")
        or "dev"
    )

    release_manifest_path = required_file(ROOT / "manifest.xml", "release manifest")
    release_manifest = ET.parse(release_manifest_path).getroot()
    entries = [
        entry for entry in release_manifest.findall("File")
        if entry.get("part") == "sidecar" and entry.get("name") == "sidecar/dist/server.cjs"
    ]
    if len(entries) != 1:
        fail("Release manifest must contain one sidecar/dist/server.cjs entry.")
    if entries[0].get("sha1") != manifest_sha1(bundle_path):
        fail("Release manifest sidecar hash does not match the selected sidecar artifact.")

    output = Path(args.output or ROOT / "artifacts" / "AIPathOfBuilding-AIPoB-windows-x64").resolve()
    zip_path = Path(f"{output}.zip")
    print(f"Package directory: {output}")
    print(f"Package archive: {zip_path}")
    if output == ROOT or SIDECAR in output.parents:
        fail("Output must not be the repository root or a child of sidecar.")
    if output.exists() or zip_path.exists():
        fail(f"Package output already exists: {output if output.exists() else zip_path}")
    output.mkdir(parents=True)
    if runtime_archive is not None:
        safe_extract(runtime_archive, output)
        runtime_input = {"path": runtime_archive.name, "sha256": sha256(runtime_archive)}
    else:
        copy_runtime_tree(runtime_source, output)
        runtime_input = {"path": "runtime/", "sha256": runtime_tree_hash(runtime_source)}

    selected = manifest_files(manifest_config)
    for source, relative in selected:
        copy_file(source, safe_package_path(output, relative))

    package_sidecar = output / "sidecar"
    package_dist = package_sidecar / "dist"
    package_runtime = package_sidecar / "runtime"
    package_modules = package_sidecar / "node_modules"
    package_dist.mkdir(parents=True, exist_ok=True)
    package_runtime.mkdir(parents=True, exist_ok=True)
    package_modules.mkdir(parents=True, exist_ok=True)
    copy_file(bundle_path, package_dist / "server.cjs")
    copy_file(node_path, package_runtime / "node.exe")
    copy_file(credential_helper, package_runtime / "aipob-credential-helper.exe")

    sqlite_source = required_directory(SIDECAR / "node_modules" / "better-sqlite3", "better-sqlite3 package")
    sqlite_package = required_file(sqlite_source / "package.json", "better-sqlite3 package metadata")
    sqlite_license = required_file(sqlite_source / "LICENSE", "better-sqlite3 license")
    sqlite_library = required_directory(sqlite_source / "lib", "better-sqlite3 library")
    sqlite_binding = required_file(sqlite_source / "prebuilds" / "win32-x64.node", "better-sqlite3 Windows binding")
    package_sqlite = package_modules / "better-sqlite3"
    package_sqlite.mkdir(parents=True)
    copy_file(sqlite_package, package_sqlite / "package.json")
    copy_file(sqlite_license, package_sqlite / "LICENSE")
    shutil.copytree(sqlite_library, package_sqlite / "lib")
    copy_file(sqlite_binding, package_sqlite / "prebuilds" / "win32-x64.node")
    run_capture([
        str(package_runtime / "node.exe"),
        "-e",
        "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('select 1').get();db.close();",
    ], cwd=package_sidecar)

    for name in ("README.md", "README-AIPOB.md"):
        source = ROOT / name
        if source.is_file():
            copy_file(source, output / name)
    write_runtime_manifest(release_manifest_path, output / "manifest.xml", update_branch)
    copy_file(manifest_config, output / "manifest.cfg")

    sqlite_metadata = json.loads(sqlite_package.read_text(encoding="utf-8"))
    metadata = {
        "formatVersion": 1,
        "product": "AIPathOfBuilding",
        "packageKind": "windows-portable",
        "platform": "win32",
        "arch": "x64",
        "update": {"branch": update_branch, "platform": "win32"},
        "node": {
            "version": node_info["version"],
            "major": 24,
            "modules": str(node_info["modules"]),
            "napi": str(node_info["napi"]),
            "platform": node_info["platform"],
            "arch": node_info["arch"],
            "sha256": sha256(package_runtime / "node.exe"),
        },
        "sidecar": {
            "bundle": "sidecar/dist/server.cjs",
            "sha256": sha256(package_dist / "server.cjs"),
            "protocolVersion": protocol_version,
            "schemaVersion": schema_version,
        },
        "native": {
            "credentialHelper": {
                "path": "sidecar/runtime/aipob-credential-helper.exe",
                "sha256": sha256(package_runtime / "aipob-credential-helper.exe"),
            },
            "packages": [{
                "name": "better-sqlite3",
                "version": str(sqlite_metadata["version"]),
                "nativeBinding": "sidecar/node_modules/better-sqlite3/prebuilds/win32-x64.node",
                "nativeSha256": sha256(package_sqlite / "prebuilds" / "win32-x64.node"),
            }],
        },
        "inputs": {
            "runtime": runtime_input,
            "manifestConfig": {"path": "manifest.cfg", "sha256": sha256(manifest_config)},
            "sourceManifestXml": {"path": "repository/manifest.xml", "sha256": sha256(release_manifest_path)},
            "manifestXml": {"path": "manifest.xml", "sha256": sha256(output / "manifest.xml")},
            "lockfile": {"path": "sidecar/pnpm-lock.yaml", "sha256": sha256(required_file(SIDECAR / "pnpm-lock.yaml", "sidecar lockfile"))},
        },
        "manifestSelectedFiles": sorted({relative for _, relative in selected}),
    }
    (output / "aipob-package.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    checksum_lines = []
    for file_path in sorted(path for path in output.rglob("*") if path.is_file() and path.name != "SHA256SUMS.txt"):
        checksum_lines.append(f"{sha256(file_path)}  {file_path.relative_to(output).as_posix()}")
    (output / "SHA256SUMS.txt").write_text("\n".join(checksum_lines) + "\n", encoding="utf-8")
    create_zip(output, zip_path)
    print(f"Packaged Node.js 24.20.0 and full PoB runtime: {zip_path}")


def verify_checksums(root: Path) -> None:
    checksum_path = root / "SHA256SUMS.txt"
    if not checksum_path.is_file():
        fail(f"Package checksum file missing: {checksum_path}")
    expected: dict[str, str] = {}
    for line in checksum_path.read_text(encoding="utf-8").splitlines():
        if "  " not in line:
            fail(f"Invalid checksum line: {line}")
        digest, relative = line.split("  ", 1)
        safe_member(relative)
        if len(digest) != 64 or any(char not in "0123456789abcdefABCDEF" for char in digest):
            fail(f"Invalid checksum line: {line}")
        if relative == "SHA256SUMS.txt" or relative in expected:
            fail(f"Duplicate or self checksum entry: {relative}")
        expected[relative] = digest.lower()
    actual = [path for path in root.rglob("*") if path.is_file() and path.name != "SHA256SUMS.txt"]
    for path in actual:
        relative = path.relative_to(root).as_posix()
        if relative not in expected:
            fail(f"File missing from SHA256SUMS.txt: {relative}")
        if sha256(path) != expected[relative]:
            fail(f"Checksum mismatch: {relative}")
    if len(expected) != len(actual):
        fail("SHA256SUMS.txt contains entries for missing files.")


def owner_timeout(node: Path, bundle: Path, working_directory: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="aipob-owner-timeout-") as temporary:
        root = Path(temporary)
        ready = root / "ready.json"
        token = ("verify-" + os.urandom(16).hex()).ljust(40, "x")
        command = windows_interop_arguments([
            str(node), str(bundle), "--host", "127.0.0.1", "--port", "0",
            "--session-token", token, "--data-dir", str(root), "--ready-file", str(ready),
            "--owner-connect-timeout-ms", "250",
        ])
        process = subprocess.Popen(
            command,
            cwd=working_directory,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 15
            while not ready.is_file() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            if not ready.is_file():
                _, stderr = process.communicate(timeout=5)
                fail(f"Packaged sidecar exited before ready: {stderr}")
            return_code = process.wait(timeout=15)
            if return_code != 1:
                fail(f"Packaged sidecar owner-timeout exit code was {return_code}, expected 1.")
            if ready.exists():
                fail("Packaged sidecar left its ready file after owner timeout.")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


def verify_package_root(root: Path, *, skip_launch: bool = False) -> dict[str, object]:
    root = root.resolve()
    verify_checksums(root)
    metadata_path = root / "aipob-package.json"
    if not metadata_path.is_file():
        fail(f"Package metadata missing: {metadata_path}")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata.get("formatVersion") != 1 or metadata.get("product") != "AIPathOfBuilding" or metadata.get("packageKind") != "windows-portable":
        fail("Unsupported or invalid AIPoB package metadata.")
    sidecar = metadata["sidecar"]
    if int(sidecar["protocolVersion"]) < 1 or int(sidecar["schemaVersion"]) < 1:
        fail("Package metadata contains invalid protocol/schema versions.")
    bundle = safe_package_path(root, str(sidecar["bundle"]))
    node = root / "sidecar" / "runtime" / "node.exe"
    credential = safe_package_path(root, str(metadata["native"]["credentialHelper"]["path"]))
    native = safe_package_path(root, str(metadata["native"]["packages"][0]["nativeBinding"]))
    required = [
        bundle,
        node,
        credential,
        native,
        root / "src" / "AIPoBWorker.lua",
        root / "src" / "UpdateCheck.lua",
        root / "src" / "_SimpleGraphic.def.lua",
        root / "src" / "Modules" / "AIPoB" / "UpdatePaths.lua",
        root / "manifest.cfg",
        root / "manifest.xml",
    ]
    for path in required:
        if not path.is_file():
            fail(f"Required packaged file missing: {path}")
    if not any((root / name).is_file() for name in POB_EXECUTABLE_NAMES):
        fail("No packaged Path of Building executable was found.")
    if len(list((root / "sidecar" / "dist").glob("server.cjs"))) != 1:
        fail("Expected exactly one sidecar/dist/server.cjs.")
    checks = [
        (bundle, sidecar["sha256"], "Sidecar bundle metadata hash mismatch."),
        (node, metadata["node"]["sha256"], "Node runtime metadata hash mismatch."),
        (native, metadata["native"]["packages"][0]["nativeSha256"], "Native binding metadata hash mismatch."),
        (credential, metadata["native"]["credentialHelper"]["sha256"], "WinCred helper metadata hash mismatch."),
        (root / "manifest.cfg", metadata["inputs"]["manifestConfig"]["sha256"], "Manifest configuration metadata hash mismatch."),
        (root / "manifest.xml", metadata["inputs"]["manifestXml"]["sha256"], "Release manifest metadata hash mismatch."),
    ]
    for path, expected, message in checks:
        if sha256(path) != expected:
            fail(message)
    validate_runtime_manifest(root / "manifest.xml", metadata)
    manifest = ET.parse(root / "manifest.xml").getroot()
    entries = [entry for entry in manifest.findall("File") if entry.get("part") == "sidecar" and entry.get("name") == "sidecar/dist/server.cjs"]
    if len(entries) != 1 or entries[0].get("sha1") != manifest_sha1(bundle):
        fail("Release manifest sidecar hash does not match the packaged bundle.")
    node_info = json.loads(run_capture([
        str(node), "-p", "JSON.stringify({version:process.version,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch})",
    ], cwd=node.parent))
    node_metadata = metadata["node"]
    if not (
        node_info["platform"] == "win32"
        and node_info["arch"] == "x64"
        and node_info["version"].removeprefix("v") == "24.20.0"
        and str(node_info["modules"]) == "137"
        and str(node_info["version"]) == str(node_metadata["version"])
        and str(node_info["modules"]) == str(node_metadata["modules"])
        and str(node_info["napi"]) == str(node_metadata["napi"])
    ):
        fail(f"Packaged Node runtime does not match metadata: {json.dumps(node_info)}")
    run_capture([
        str(node), "-e", "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('select 1').get();db.close();",
    ], cwd=root / "sidecar")
    if not skip_launch:
        owner_timeout(node, bundle, root / "sidecar")
    print(f"Verified full Windows package: {root}")
    return metadata


class PackageRoot:
    def __init__(self, package: Path, keep: bool = False):
        self.package = package.resolve()
        self.keep = keep
        self.temporary: Path | None = None

    def __enter__(self) -> Path:
        if self.package.is_dir():
            return self.package
        if not self.package.is_file() or self.package.suffix.lower() != ".zip":
            fail(f"Package must be a directory or .zip archive: {self.package}")
        self.temporary = Path(tempfile.mkdtemp(prefix="aipob-package-"))
        safe_extract(self.package, self.temporary)
        return self.temporary

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        if self.temporary is None:
            return
        if self.keep:
            print(f"Kept extracted package: {self.temporary}")
        else:
            try:
                remove_tree(self.temporary)
            except OSError as error:
                if exc_type is None:
                    raise
                print(f"warning: package cleanup failed after E2E error: {error}", file=sys.stderr)


def verify_package(args: argparse.Namespace) -> None:
    with PackageRoot(Path(args.package), args.keep_extracted) as root:
        verify_package_root(root, skip_launch=args.skip_launch)


def find_makensis(explicit: str | None) -> Path:
    if explicit:
        return required_file(Path(explicit), "makensis.exe")
    command = shutil.which("makensis.exe") or shutil.which("makensis")
    if command:
        return Path(command).resolve()
    candidates = []
    for variable in ("ProgramFiles(x86)", "ProgramFiles"):
        root = os.environ.get(variable)
        if root:
            candidates.append(Path(root) / "NSIS" / "makensis.exe")
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    fail("makensis.exe was not found on PATH or in a standard NSIS installation directory.")


def package_installer(args: argparse.Namespace) -> None:
    package = required_file(Path(args.package), "Canonical portable package")
    if package.suffix.lower() != ".zip":
        fail("Package must be the canonical portable .zip archive.")
    with PackageRoot(package) as verified_root:
        verify_package_root(verified_root)
    compiler = find_makensis(args.makensis)
    source = required_file(ROOT / "installer" / "aipob.nsi", "NSIS source")
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()
    with tempfile.TemporaryDirectory(prefix="aipob-installer-stage-") as temporary:
        staging = Path(temporary) / "staging"
        staging.mkdir()
        safe_extract(package, staging)
        if not any((staging / name).is_file() for name in POB_EXECUTABLE_NAMES):
            fail("Canonical staging does not contain a PoB executable.")
        subprocess.run([
            str(compiler), f"/DSTAGING_PATH={staging}", f"/DOUTPUT_PATH={output}", str(source),
        ], cwd=ROOT, check=True)
    if not output.is_file():
        fail(f"NSIS output not found: {output}")
    print(f"Built canonical AIPoB installer: {output}")


def verify_installer(args: argparse.Namespace) -> None:
    installer = required_file(Path(args.installer), "Installer")
    package = required_file(Path(args.package), "Canonical portable package")
    if installer.suffix.lower() != ".exe" or package.suffix.lower() != ".zip":
        fail("Installer must be .exe and package must be .zip.")
    with PackageRoot(package) as verified_root:
        verify_package_root(verified_root)
    with tempfile.TemporaryDirectory(prefix="aipob-installer-verify-") as temporary:
        root = Path(temporary)
        expected = root / "expected"
        installed = root / "installed"
        expected.mkdir()
        safe_extract(package, expected)
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.run([str(installer), "/S", f"/D={installed}"], check=True, creationflags=creation_flags)
        expected_files = [path for path in expected.rglob("*") if path.is_file()]
        allowed = {path.relative_to(expected).as_posix().lower() for path in expected_files}
        allowed.add("uninstall.exe")
        for source in expected_files:
            relative = source.relative_to(expected)
            target = installed / relative
            if not target.is_file():
                fail(f"Installer omitted canonical file: {relative.as_posix()}")
            if sha256(source) != sha256(target):
                fail(f"Installer changed canonical file: {relative.as_posix()}")
        for target in (path for path in installed.rglob("*") if path.is_file()):
            relative = target.relative_to(installed).as_posix().lower()
            if relative not in allowed:
                fail(f"Installer added an unexpected payload file: {relative}")
        version = run_capture([str(installed / "sidecar" / "runtime" / "node.exe"), "--version"], cwd=installed)
        if version.removeprefix("v") != "24.20.0":
            fail(f"Installed Node runtime mismatch: {version}")
    print(f"Installer verified against canonical staging: {installer}")


def add_package_parsers(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    package = subparsers.add_parser("package-windows")
    package.add_argument("--node-exe")
    package.add_argument("--output")
    package.add_argument("--sidecar-bundle")
    package.add_argument("--runtime-archive")
    package.add_argument("--manifest-config")
    package.add_argument("--update-branch")
    package.add_argument("--credential-helper")
    package.add_argument("--skip-build", action="store_true")
    package.set_defaults(handler=package_windows)

    verify = subparsers.add_parser("verify-package-windows")
    verify.add_argument("--package", required=True)
    verify.add_argument("--skip-launch", action="store_true")
    verify.add_argument("--keep-extracted", action="store_true")
    verify.set_defaults(handler=verify_package)

    installer = subparsers.add_parser("package-installer-windows")
    installer.add_argument("--package", required=True)
    installer.add_argument("--output", required=True)
    installer.add_argument("--makensis")
    installer.set_defaults(handler=package_installer)

    installer_verify = subparsers.add_parser("verify-installer-windows")
    installer_verify.add_argument("--installer", required=True)
    installer_verify.add_argument("--package", required=True)
    installer_verify.set_defaults(handler=verify_installer)
