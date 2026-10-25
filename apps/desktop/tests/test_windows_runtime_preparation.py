import hashlib
import importlib.util
import io
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
from xml.dom import minidom


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/prepare-windows-release.py"
SPEC = importlib.util.spec_from_file_location("windows_runtime_preparation", SCRIPT)
preparation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preparation)


class WindowsRuntimePreparationTest(unittest.TestCase):
    def test_java_utf8_manifest_preserves_existing_windows_settings(self):
        original = b'''<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"
            xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
          <asmv3:trustInfo><asmv3:security><asmv3:requestedPrivileges>
            <asmv3:requestedExecutionLevel level="asInvoker" uiAccess="false"/>
          </asmv3:requestedPrivileges></asmv3:security></asmv3:trustInfo>
          <asmv3:application><asmv3:windowsSettings>
            <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware>
            <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">Legacy</activeCodePage>
          </asmv3:windowsSettings></asmv3:application>
          <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
            <application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/></application>
          </compatibility>
        </assembly>'''
        manifest = preparation.utf8_application_manifest(original)
        document = minidom.parseString(preparation.utf8_application_manifest(manifest))
        code_pages = document.getElementsByTagNameNS(preparation.CODE_PAGE_NS, "activeCodePage")
        self.assertEqual(len(code_pages), 1)
        self.assertEqual(code_pages[0].firstChild.data, "UTF-8")
        privilege = document.getElementsByTagNameNS(preparation.WINDOWS_SETTINGS_NS, "requestedExecutionLevel")[0]
        self.assertEqual(privilege.getAttribute("level"), "asInvoker")
        self.assertEqual(privilege.getAttribute("uiAccess"), "false")
        self.assertEqual(document.getElementsByTagName("dpiAware")[0].firstChild.data, "true")
        self.assertEqual(document.getElementsByTagName("supportedOS")[0].getAttribute("Id"),
                         "{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}")

    def test_java_utf8_manifest_adds_missing_application_settings(self):
        manifest = preparation.utf8_application_manifest(
            b'<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"/>'
        )
        document = minidom.parseString(manifest)
        application = document.getElementsByTagNameNS(preparation.WINDOWS_SETTINGS_NS, "application")[0]
        settings = application.getElementsByTagNameNS(preparation.WINDOWS_SETTINGS_NS, "windowsSettings")[0]
        self.assertEqual(settings.getElementsByTagNameNS(preparation.CODE_PAGE_NS, "activeCodePage")[0].firstChild.data,
                         "UTF-8")

    def test_only_x64_pe_files_are_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "service.exe"
            data = bytearray(134)
            data[:2] = b"MZ"
            struct.pack_into("<I", data, 0x3C, 128)
            data[128:132] = b"PE\0\0"
            struct.pack_into("<H", data, 132, 0x8664)
            executable.write_bytes(data)
            preparation.require_x64_pe(executable)
            for machine in (0xAA64, 0x014C):
                struct.pack_into("<H", data, 132, machine)
                executable.write_bytes(data)
                with self.assertRaisesRegex(RuntimeError, "Windows x64"):
                    preparation.require_x64_pe(executable)
            executable.write_bytes(b"foreign Mach-O executable")
            with self.assertRaisesRegex(RuntimeError, "Windows PE"):
                preparation.require_x64_pe(executable)
            with self.assertRaises(FileNotFoundError):
                preparation.require_x64_pe(Path(directory) / "missing.exe")

    def test_download_verifies_hash_before_replacing_cache(self):
        payload = b"verified upstream archive"
        expected = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "runtime.zip"
            with patch.object(preparation.urllib.request, "urlopen", return_value=io.BytesIO(payload)):
                self.assertEqual(preparation.download("https://example.test/archive.zip", archive, expected), archive)
            self.assertEqual(archive.read_bytes(), payload)
            archive.write_bytes(b"corrupt cached archive")
            with patch.object(preparation.urllib.request, "urlopen") as request:
                with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                    preparation.download("https://example.test/archive.zip", archive, expected)
                request.assert_not_called()

    def test_failed_hash_does_not_commit_download(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "runtime.zip"
            with patch.object(preparation.urllib.request, "urlopen", return_value=io.BytesIO(b"wrong archive")):
                with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                    preparation.download("https://example.test/archive.zip", archive, "0" * 64)
            self.assertFalse(archive.exists())
            self.assertFalse(archive.with_suffix(".zip.download").exists())


if __name__ == "__main__":
    unittest.main()
