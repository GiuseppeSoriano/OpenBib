"""Keep automated updates compatible without suppressing security upgrade proposals."""

import fnmatch
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


def updates():
    data = yaml.safe_load((ROOT / ".github/dependabot.yml").read_text())
    return {item["package-ecosystem"]: item for item in data["updates"]}


def group_for(groups, dependency):
    return next(
        name
        for name, group in groups.items()
        if any(fnmatch.fnmatchcase(dependency, pattern) for pattern in group["patterns"])
    )


def test_routine_updates_are_grouped_without_ignoring_security_updates():
    for ecosystem, item in updates().items():
        assert "ignore" not in item
        assert 0 < item["open-pull-requests-limit"] <= 3
        assert item["groups"]
        if ecosystem != "github-actions":
            types = item["allow"][0]["update-types"]
            assert "version-update:semver-major" not in types
            assert "version-update:semver-patch" in types
    assert updates()["docker"]["allow"][0]["update-types"] == ["version-update:semver-patch"]


def test_react_runtime_and_types_are_updated_together():
    groups = updates()["npm"]["groups"]
    assert {
        group_for(groups, dependency)
        for dependency in ("react", "react-dom", "@types/react", "@types/react-dom")
    } == {"react-family"}


def test_build_and_lint_peer_dependencies_are_updated_together():
    groups = updates()["npm"]["groups"]
    dependencies = (
        "vite",
        "vitest",
        "@vitejs/plugin-react",
        "eslint",
        "@eslint/js",
        "eslint-plugin-react-hooks",
        "typescript-eslint",
    )
    assert {group_for(groups, dependency) for dependency in dependencies} == {"frontend-tooling"}


def test_ci_matches_reviewed_image_runtime_and_uv_versions():
    workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
    python = next(
        step["with"]
        for step in workflow["jobs"]["backend"]["steps"]
        if step.get("uses", "").startswith("astral-sh/setup-uv@")
    )
    node = next(
        step["with"]
        for step in workflow["jobs"]["frontend"]["steps"]
        if step.get("uses", "").startswith("actions/setup-node@")
    )
    backend = (ROOT / "backend/Dockerfile").read_text()
    frontend = (ROOT / "frontend/Dockerfile").read_text()
    assert (
        re.findall(r"FROM python:([\d.]+)-alpine@sha256:", backend)
        == [python["python-version"]] * 2
    )
    assert f"FROM ghcr.io/astral-sh/uv:{python['version']}@sha256:" in backend
    assert f"FROM node:{node['node-version']}-alpine@sha256:" in frontend
