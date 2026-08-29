"""Synchronize the latest successful Windows portable artifact from GitHub Actions."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import NoReturn

from windows_package import POB_EXECUTABLE_NAMES, remove_tree, safe_extract, verify_package_root


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ARTIFACT = "AIPathOfBuilding-AIPoB-windows-x64"
DEFAULT_WORKFLOW = "aipob.yml"
MARKER_NAME = "ci-sync.json"


def fail(message: str) -> NoReturn:
    raise RuntimeError(message)


@dataclass(frozen=True)
class RunInfo:
    run_id: int
    branch: str
    head_sha: str
    url: str
    updated_at: str


def run_capture(arguments: list[str], *, cwd: Path = ROOT) -> str:
    result = subprocess.run(arguments, cwd=cwd, check=True, text=True, capture_output=True)
    return result.stdout.strip()


def command_path_argument(command: str, path: Path) -> str:
    command_path = Path(command)
    try:
        command_name = command_path.resolve().name.lower()
    except OSError:
        command_name = command_path.name.lower()
    if os.name == "nt" or not command_name.endswith(".exe"):
        return str(path)
    wslpath = find_command(None, "wslpath")
    return run_capture([wslpath, "-w", str(path)])


def find_command(explicit: str | None, *names: str) -> str:
    if explicit:
        path = Path(explicit)
        if path.is_file():
            return str(path.resolve())
        resolved = shutil.which(explicit)
        if resolved:
            return resolved
        fail(f"Command not found: {explicit}")
    for name in names:
        resolved = shutil.which(name)
        if resolved:
            return resolved
    fail(f"Required command not found: {' or '.join(names)}")


def resolve_branch(explicit: str | None, git: str) -> str:
    if explicit:
        return explicit
    branch = run_capture([git, "branch", "--show-current"])
    if not branch:
        fail("Cannot synchronize CI artifact from a detached HEAD; pass --branch.")
    return branch


def latest_successful_run(gh: str, workflow: str, branch: str) -> RunInfo:
    raw = run_capture([
        gh,
        "run",
        "list",
        "--workflow",
        workflow,
        "--branch",
        branch,
        "--status",
        "success",
        "--limit",
        "1",
        "--json",
        "databaseId,headBranch,headSha,status,conclusion,url,updatedAt",
    ])
    runs = json.loads(raw)
    if not isinstance(runs, list) or not runs:
        fail(f"No successful {workflow} run found for branch {branch}.")
    item = runs[0]
    if (
        item.get("status") != "completed"
        or item.get("conclusion") != "success"
        or item.get("headBranch") != branch
    ):
        fail("GitHub returned an invalid successful workflow run.")
    return RunInfo(
        run_id=int(item["databaseId"]),
        branch=str(item["headBranch"]),
        head_sha=str(item["headSha"]),
        url=str(item["url"]),
        updated_at=str(item["updatedAt"]),
    )


def read_marker(directory: Path) -> dict[str, object] | None:
    marker = directory / MARKER_NAME
    if not marker.is_file():
        return None
    try:
        value = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def synchronized(directory: Path, run_id: int) -> bool:
    marker = read_marker(directory)
    if marker is None or marker.get("runId") != run_id:
        return False
    app = directory / "app"
    package = directory / f"{DEFAULT_ARTIFACT}.zip"
    return (
        package.is_file()
        and (app / "aipob-package.json").is_file()
        and any((app / name).is_file() for name in POB_EXECUTABLE_NAMES)
    )


def remove_managed_directory(directory: Path) -> None:
    if directory.exists():
        remove_tree(directory)


def promote(pending: Path, destination: Path, old: Path) -> bool:
    if not pending.is_dir():
        return False
    try:
        remove_managed_directory(old)
        if destination.exists():
            destination.rename(old)
        pending.rename(destination)
    except OSError as error:
        if not destination.exists() and old.exists():
            try:
                old.rename(destination)
            except OSError as restore_error:
                fail(f"CI artifact replacement failed and rollback failed: {error}; {restore_error}")
        print(f"warning: verified CI artifact pending; close AIPoB before replacement: {error}")
        return False
    try:
        remove_managed_directory(old)
    except OSError as error:
        print(f"warning: latest CI artifact installed but old directory cleanup is pending: {error}")
    return True


def download_artifact(gh: str, run_info: RunInfo, artifact: str, destination: Path) -> Path:
    destination.mkdir(parents=True)
    output_argument = command_path_argument(gh, destination)
    subprocess.run([
        gh,
        "run",
        "download",
        str(run_info.run_id),
        "--name",
        artifact,
        "--dir",
        output_argument,
    ], cwd=ROOT, check=True)
    archives = sorted(destination.rglob("*.zip"))
    if len(archives) != 1:
        fail(f"Expected one portable ZIP in artifact {artifact}; found {len(archives)}.")
    return archives[0]


def stage_artifact(
    gh: str,
    run_info: RunInfo,
    workflow: str,
    artifact: str,
    parent: Path,
) -> Path:
    stage = Path(tempfile.mkdtemp(prefix=".ci-sync-", dir=parent))
    try:
        download = stage / "download"
        archive = download_artifact(gh, run_info, artifact, download)
        package = stage / f"{DEFAULT_ARTIFACT}.zip"
        shutil.move(str(archive), package)
        remove_managed_directory(download)
        app = stage / "app"
        app.mkdir()
        safe_extract(package, app)
        verify_package_root(app)
        marker = {
            "formatVersion": 1,
            "workflow": workflow,
            "artifact": artifact,
            "runId": run_info.run_id,
            "branch": run_info.branch,
            "headSha": run_info.head_sha,
            "runUrl": run_info.url,
            "runUpdatedAt": run_info.updated_at,
            "syncedAt": datetime.now(timezone.utc).isoformat(),
        }
        (stage / MARKER_NAME).write_text(json.dumps(marker, indent=2) + "\n", encoding="utf-8")
        return stage
    except BaseException:
        try:
            remove_managed_directory(stage)
        except OSError:
            pass
        raise


def sync_ci_windows(args: argparse.Namespace) -> None:
    gh = find_command(args.gh, "gh.exe", "gh")
    git = find_command(args.git, "git")
    branch = resolve_branch(args.branch, git)
    run_info = latest_successful_run(gh, args.workflow, branch)
    destination = Path(args.destination or ROOT / "artifacts" / "ci-latest").resolve()
    parent = destination.parent
    pending = destination.with_name("ci-pending")
    old = destination.with_name("ci-latest-old")
    parent.mkdir(parents=True, exist_ok=True)

    try:
        remove_managed_directory(old)
    except OSError as error:
        print(f"warning: old CI artifact cleanup remains pending: {error}")

    if synchronized(destination, run_info.run_id) and not args.force:
        if pending.exists():
            try:
                remove_managed_directory(pending)
            except OSError as error:
                print(f"warning: stale pending artifact cleanup failed: {error}")
        print(f"CI portable already current: run {run_info.run_id} ({run_info.head_sha[:12]}).")
        return

    if synchronized(pending, run_info.run_id) and not args.force:
        if promote(pending, destination, old):
            print(f"Installed latest CI portable: {destination}")
        return

    stage = stage_artifact(gh, run_info, args.workflow, args.artifact, parent)
    try:
        remove_managed_directory(pending)
        stage.rename(pending)
    except BaseException:
        if stage.exists():
            try:
                remove_managed_directory(stage)
            except OSError:
                pass
        raise
    if promote(pending, destination, old):
        print(f"Installed latest CI portable: {destination}")
        print(f"Launch: {destination / 'app' / 'Path of Building.exe'}")


def add_sync_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    parser = subparsers.add_parser(
        "sync-ci-windows",
        help="Download, verify, and retain the latest successful Windows portable CI artifact.",
    )
    parser.add_argument("--branch")
    parser.add_argument("--workflow", default=DEFAULT_WORKFLOW)
    parser.add_argument("--artifact", default=DEFAULT_ARTIFACT)
    parser.add_argument("--destination")
    parser.add_argument("--gh")
    parser.add_argument("--git")
    parser.add_argument("--force", action="store_true")
    parser.set_defaults(handler=sync_ci_windows)
