from __future__ import annotations

import sys
import tempfile
from pathlib import Path
import struct
import unittest
import xml.etree.ElementTree as ET


SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

from windows_package import (  # noqa: E402
    validate_runtime_manifest,
    validate_update_branch,
    verify_gui_subsystem,
    write_runtime_manifest,
)


class RuntimeManifestTests(unittest.TestCase):
    def test_adds_runtime_branch_and_platform_without_changing_source(self) -> None:
        source_text = """<?xml version='1.0' encoding='UTF-8'?>
<PoBVersion><Version number="2.67.2"/><File name="sidecar/dist/server.cjs" part="sidecar" sha1="abc"/></PoBVersion>
"""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "manifest.xml"
            destination = root / "package" / "manifest.xml"
            source.write_text(source_text, encoding="utf-8")

            write_runtime_manifest(source, destination, "codex/provider-test")

            version = ET.parse(destination).getroot().find("Version")
            self.assertIsNotNone(version)
            assert version is not None
            self.assertEqual(version.get("branch"), "codex/provider-test")
            self.assertEqual(version.get("platform"), "win32")
            self.assertEqual(source.read_text(encoding="utf-8"), source_text)

    def test_rejects_unsafe_update_branches(self) -> None:
        for value in ("", "/dev", "dev/", "dev//test", "dev/../main", "bad branch"):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                validate_update_branch(value)

    def test_verifier_rejects_manifest_that_would_trigger_dev_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            manifest = Path(temporary) / "manifest.xml"
            manifest.write_text(
                '<PoBVersion><Version number="2.67.2"/></PoBVersion>',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "exact update branch and win32 platform"):
                validate_runtime_manifest(manifest, {
                    "update": {"branch": "codex/provider-test", "platform": "win32"},
                })

    def test_sidecar_launcher_requires_windows_gui_subsystem(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "launcher.exe"
            image = bytearray(256)
            image[:2] = b"MZ"
            struct.pack_into("<I", image, 0x3C, 0x80)
            image[0x80:0x84] = b"PE\0\0"
            struct.pack_into("<H", image, 0x80 + 24 + 68, 2)
            executable.write_bytes(image)
            verify_gui_subsystem(executable)

            struct.pack_into("<H", image, 0x80 + 24 + 68, 3)
            executable.write_bytes(image)
            with self.assertRaisesRegex(RuntimeError, "GUI subsystem"):
                verify_gui_subsystem(executable)


if __name__ == "__main__":
    unittest.main()
