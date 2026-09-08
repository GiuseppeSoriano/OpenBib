"""Optional postal address without relaxing any other production legal fields."""

import json

import pytest
from pydantic import ValidationError

from app.config import settings
from app.legal import OperatorConfig, _development_config, get_legal_config


@pytest.fixture
def legal_file(tmp_path, monkeypatch):
    raw = _development_config().model_dump(mode="json")
    raw.update(public_url="https://library.example.org", data_location="European Union")
    raw["operator"].update(
        address="",
        privacy_email="privacy@example.org",
        support_email="support@example.org",
    )
    raw["third_parties"] = [
        {
            "name": name,
            "purpose": "Service operation",
            "role": "processor",
            "region": "European Union",
            "privacy_url": "https://example.org/privacy",
        }
        for name in ("Host", "Email", "Catalog")
    ]
    path = tmp_path / "legal.json"
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "app_public_url", raw["public_url"])
    monkeypatch.setattr(settings, "backups_enabled", False)
    monkeypatch.setattr(settings, "deletion_journal_enabled", False)
    monkeypatch.setattr(settings, "legal_config_path", str(path))
    get_legal_config.cache_clear()
    yield raw, path
    get_legal_config.cache_clear()


@pytest.mark.parametrize("address", [None, "", "   ", "A valid postal address"])
def test_production_accepts_optional_address(legal_file, address):
    raw, path = legal_file
    if address is None:
        raw["operator"].pop("address")
    else:
        raw["operator"]["address"] = address
    path.write_text(json.dumps(raw))
    assert get_legal_config().operator.address == (address or "").strip()


@pytest.mark.parametrize("field", ["name", "country", "privacy_email", "support_email"])
def test_operator_identity_and_contacts_remain_required(legal_file, field):
    raw, path = legal_file
    raw["operator"][field] = ""
    path.write_text(json.dumps(raw))
    with pytest.raises(RuntimeError):
        get_legal_config()


@pytest.mark.parametrize(
    "change",
    ["data_location", "supplier_purpose", "supplier_address", "placeholder_address"],
)
def test_only_the_operator_postal_address_can_be_blank(legal_file, change):
    raw, path = legal_file
    if change == "data_location":
        raw["data_location"] = ""
    elif change == "supplier_purpose":
        raw["third_parties"][0]["purpose"] = ""
    elif change == "supplier_address":
        raw["third_parties"][0]["address"] = ""
    else:
        raw["operator"]["address"] = "Replace me"
    path.write_text(json.dumps(raw))
    with pytest.raises(RuntimeError):
        get_legal_config()


def test_supplied_incomplete_address_is_still_rejected():
    raw = _development_config().operator.model_dump()
    raw["address"] = "x"
    with pytest.raises(ValidationError):
        OperatorConfig.model_validate(raw)
