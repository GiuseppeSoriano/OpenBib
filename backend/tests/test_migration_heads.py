"""The Alembic history must stay linear: CI and deploys run ``upgrade head``."""

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

BACKEND = Path(__file__).resolve().parents[1]


def test_single_migration_head():
    config = Config(str(BACKEND / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND / "alembic"))
    assert ScriptDirectory.from_config(config).get_heads() == ["1d2e3f4a5b6c"]
