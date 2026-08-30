#!/usr/bin/env python3
"""Cross-platform AIPoB development, release, and Windows package commands."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent.parent
SIDECAR = ROOT / "sidecar"


def fail(message: str) -> "NoReturn":
    raise RuntimeError(message)


def command_path(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        fail(f"Required command not found: {name}")
    return path


def run(
    arguments: list[str],
    *,
    cwd: Path = ROOT,
    capture: bool = False,
    timeout: float | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        cwd=cwd,
        check=True,
        text=True,
        capture_output=capture,
        timeout=timeout,
        env=env,
    )


def node_version() -> tuple[int, int, int]:
    result = run([command_path("node"), "--version"], capture=True)
    raw = result.stdout.strip().removeprefix("v")
    try:
        major, minor, patch = (int(part) for part in raw.split(".", 2))
    except ValueError as error:
        raise RuntimeError(f"Unable to parse Node.js version: {raw}") from error
    return major, minor, patch


def install_sidecar(_: argparse.Namespace) -> None:
    package = SIDECAR / "package.json"
    if not package.is_file():
        fail(f"Sidecar package not found: {package}")
    version = node_version()
    if version < (22, 13, 0):
        fail(f"Node.js 22.13.0 or newer is required; found {'.'.join(map(str, version))}.")
    run([command_path("pnpm"), "install", "--frozen-lockfile"], cwd=SIDECAR)


def check_sidecar(args: argparse.Namespace) -> None:
    if getattr(args, "install", False):
        install_sidecar(args)
    package_path = SIDECAR / "package.json"
    if not package_path.is_file():
        fail(f"Sidecar package not found: {package_path}")
    package = json.loads(package_path.read_text(encoding="utf-8"))
    scripts = package.get("scripts", {})
    pnpm = command_path("pnpm")
    if "lint" in scripts:
        run([pnpm, "run", "lint"], cwd=SIDECAR)
    else:
        print("No lint script is defined; skipping lint.")
    if "typecheck" in scripts:
        run([pnpm, "run", "typecheck"], cwd=SIDECAR)
    elif "check" in scripts:
        run([pnpm, "run", "check"], cwd=SIDECAR)
    else:
        fail("Neither a typecheck nor check script is defined.")
    run([pnpm, "run", "test"], cwd=SIDECAR)


def build_sidecar(args: argparse.Namespace) -> None:
    if not getattr(args, "skip_checks", False):
        check_sidecar(argparse.Namespace(install=False))
    run([command_path("pnpm"), "run", "build"], cwd=SIDECAR)
    release_entry = SIDECAR / "dist" / "server.cjs"
    if not release_entry.is_file():
        fail(f"Release build did not produce {release_entry}.")
    print(f"Built release entry: {release_entry}")


def check_manifest(_: argparse.Namespace) -> None:
    updater = ROOT / "update_manifest.py"
    release_entry = SIDECAR / "dist" / "server.cjs"
    for required in (updater, release_entry):
        if not required.is_file():
            fail(f"Required manifest input not found: {required}")
    run([sys.executable, str(updater), "--quiet"])
    generated = ROOT / "manifest-updated.xml"
    if not generated.is_file():
        fail(f"Generated manifest not found: {generated}")
    root = ET.parse(generated).getroot()
    sources = [entry for entry in root.findall("Source") if entry.get("part") == "sidecar"]
    if len(sources) != 1:
        fail(f"Expected one sidecar manifest source; found {len(sources)}.")
    expected_url = "https://raw.githubusercontent.com/Ziliang-dev/AIPathOfBuilding/{branch}/"
    if sources[0].get("url") != expected_url:
        fail(f"Unexpected sidecar manifest URL: {sources[0].get('url')}")
    files = [entry for entry in root.findall("File") if entry.get("part") == "sidecar"]
    names = [entry.get("name") for entry in files]
    if names != ["sidecar/dist/server.cjs"]:
        fail(f"Manifest must contain only sidecar/dist/server.cjs for sidecar; found: {', '.join(names)}")
    print("Manifest sidecar source and release entry are valid.")


def release_gate(args: argparse.Namespace) -> None:
    if args.install:
        install_sidecar(args)
    build_sidecar(argparse.Namespace(skip_checks=True))
    check_sidecar(argparse.Namespace(install=False))
    check_manifest(args)
    pnpm = command_path("pnpm")
    run([pnpm, "--dir", "sidecar", "exec", "vitest", "run", "tests/release-gate.test.ts"])
    specs = [
        "../spec/System/TestAIPoBCore_spec.lua",
        "../spec/System/TestAIPoBRpc_spec.lua",
        "../spec/System/TestAIPoBTradeBroker_spec.lua",
        "../spec/System/TestAIPoBNativeProbe_spec.lua",
        "../spec/System/TestAIPoBActorSeason_spec.lua",
        "../spec/System/TestAIPoBGolden_spec.lua",
        "../spec/System/TestAIPoBMechanicUnderstanding_spec.lua",
        "../spec/System/TestAIPoBUpdateCheck_spec.lua",
        "../spec/System/TestAIPlannerTab_spec.lua",
    ]
    busted = shutil.which("busted")
    if busted is not None:
        run([busted, "--lua=luajit", *specs])
    else:
        docker = shutil.which("docker")
        if docker is None:
            fail("Golden Lua gate requires busted or Docker.")
        run([docker, "compose", "run", "--rm", "--no-deps", "busted-tests", "busted", "--lua=luajit", *specs])
    print("Release gate passed: sidecar, manifest, Golden corpus, and all AIPoB Lua checks.")


def build_wincred(_: argparse.Namespace) -> None:
    compiler = command_path("cl.exe")
    native = ROOT / "native" / "wincred-helper"
    source = native / "wincred_helper.cpp"
    output = native / "wincred-helper.exe"
    run([
        compiler,
        "/nologo",
        "/O2",
        "/EHsc",
        "/W4",
        "/std:c++17",
        "/DUNICODE",
        "/D_UNICODE",
        f"/Fe:{output}",
        str(source),
        "advapi32.lib",
    ])
    print(output)


def build_sidecar_launcher(_: argparse.Namespace) -> None:
    compiler = command_path("cl.exe")
    native = ROOT / "native" / "sidecar-launcher"
    source = native / "sidecar_launcher.cpp"
    output = native / "sidecar-launcher.exe"
    run([
        compiler,
        "/nologo",
        "/O2",
        "/EHsc",
        "/W4",
        "/std:c++17",
        "/DUNICODE",
        "/D_UNICODE",
        f"/Fe:{output}",
        str(source),
        "shell32.lib",
        "/link",
        "/SUBSYSTEM:WINDOWS",
    ])
    print(output)


def add_windows_commands(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    from ci_sync import add_sync_parser
    from windows_e2e import add_e2e_parser
    from windows_package import add_package_parsers

    add_sync_parser(subparsers)
    add_package_parsers(subparsers)
    add_e2e_parser(subparsers)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)

    install = commands.add_parser("install-sidecar")
    install.set_defaults(handler=install_sidecar)

    check = commands.add_parser("check-sidecar")
    check.add_argument("--install", action="store_true")
    check.set_defaults(handler=check_sidecar)

    build = commands.add_parser("build-sidecar")
    build.add_argument("--skip-checks", action="store_true")
    build.set_defaults(handler=build_sidecar)

    manifest = commands.add_parser("check-manifest")
    manifest.set_defaults(handler=check_manifest)

    release = commands.add_parser("release-gate")
    release.add_argument("--install", action="store_true")
    release.set_defaults(handler=release_gate)

    wincred = commands.add_parser("build-wincred")
    wincred.set_defaults(handler=build_wincred)

    launcher = commands.add_parser("build-sidecar-launcher")
    launcher.set_defaults(handler=build_sidecar_launcher)

    add_windows_commands(commands)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args)
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
