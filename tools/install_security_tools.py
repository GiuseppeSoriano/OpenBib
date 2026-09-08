#!/usr/bin/env python3
"""Install CI scanners only after verifying repository-pinned SHA-256 hashes."""

import argparse
import hashlib
import http.client
import io
import platform
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ASSETS = {
    ("gitleaks", "Darwin"): (
        "gitleaks/gitleaks",
        "v8.30.1",
        "gitleaks_8.30.1_darwin_arm64.tar.gz",
        "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
    ),
    ("gitleaks", "Linux"): (
        "gitleaks/gitleaks",
        "v8.30.1",
        "gitleaks_8.30.1_linux_x64.tar.gz",
        "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    ),
    ("trivy", "Darwin"): (
        "aquasecurity/trivy",
        "v0.74.0",
        "trivy_0.74.0_macOS-ARM64.tar.gz",
        "1caada5e0e2091909357c7525d3aa76f4b660b13821bc143b190c7483e31cc11",
    ),
    ("trivy", "Linux"): (
        "aquasecurity/trivy",
        "v0.74.0",
        "trivy_0.74.0_Linux-64bit.tar.gz",
        "2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a",
    ),
}


def download(url):
    """Retry transient release-host failures; integrity checks remain mandatory."""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code not in {408, 429, 500, 502, 503, 504} or attempt == 2:
                raise
        except (urllib.error.URLError, TimeoutError, http.client.IncompleteRead):
            if attempt == 2:
                raise
        time.sleep(2**attempt)
    raise RuntimeError("Scanner download failed")


def install(tool, directory):
    system = platform.system()
    if (system, platform.machine()) not in (("Darwin", "arm64"), ("Linux", "x86_64")):
        raise SystemExit("Unsupported platform; add a verified release checksum first")
    repository, version, filename, digest = ASSETS[(tool, system)]
    archive = download(f"https://github.com/{repository}/releases/download/{version}/{filename}")
    if hashlib.sha256(archive).hexdigest() != digest:
        raise SystemExit("Scanner checksum mismatch; refusing to execute")
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / tool
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
        member = bundle.extractfile(tool)
        if member is None:
            raise SystemExit("Scanner binary missing from archive")
        target.write_bytes(member.read())
    target.chmod(0o755)
    print(f"Verified {tool} {version}: {target}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("tool", choices=("gitleaks", "trivy"))
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    install(args.tool, args.directory.resolve())
