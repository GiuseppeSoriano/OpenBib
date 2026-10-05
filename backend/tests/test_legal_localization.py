"""Localized legal fields stay backward compatible with single-language files."""

import copy
import json
import logging

import pytest
from pydantic import ValidationError

from app.config import settings
from app.legal import LegalConfig, LocalizedText, _development_config, get_legal_config

LOCALIZED = {
    "data_location": {"en": "European Union", "it": "Unione europea"},
    "country": {"en": "Italy", "it": "Italia"},
    "purpose": {
        "en": "Hosting of your account and library data",
        "it": "Hosting dei dati del tuo account e della tua libreria",
    },
    "role": {"en": "processor", "it": "responsabile del trattamento"},
    "region": {"en": "European Union", "it": "Unione europea"},
    "transfer_safeguard": {
        "en": "Standard contractual clauses for your transfers",
        "it": "Clausole contrattuali standard per i tuoi trasferimenti",
    },
}


def _party(name, **fields):
    return {
        "name": name,
        "purpose": "Service operation",
        "role": "processor",
        "region": "European Union",
        "privacy_url": "https://acme.org/privacy",
    } | fields


def _localized_raw():
    raw = _development_config().model_dump(mode="json")
    raw.update(public_url="https://library.acme.org", data_location=LOCALIZED["data_location"])
    raw["operator"].update(
        country=LOCALIZED["country"],
        privacy_email="privacy@acme.org",
        support_email="support@acme.org",
    )
    raw["third_parties"] = [
        _party(
            name,
            purpose=LOCALIZED["purpose"],
            role=LOCALIZED["role"],
            region=LOCALIZED["region"],
            transfer_safeguard=LOCALIZED["transfer_safeguard"],
        )
        for name in ("Host", "Mail", "Catalog")
    ]
    return copy.deepcopy(raw)


@pytest.fixture
def production_legal(tmp_path, monkeypatch):
    path = tmp_path / "legal.json"
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "app_public_url", "https://library.acme.org")
    monkeypatch.setattr(settings, "backups_enabled", False)
    monkeypatch.setattr(settings, "deletion_journal_enabled", False)
    monkeypatch.setattr(settings, "legal_config_path", str(path))
    get_legal_config.cache_clear()

    def load(raw):
        path.write_text(json.dumps(raw))
        get_legal_config.cache_clear()
        return get_legal_config()

    yield load
    get_legal_config.cache_clear()


def test_legacy_plain_strings_remain_valid():
    raw = _development_config().model_dump(mode="json")
    raw["third_parties"] = [_party("Host", transfer_safeguard="Adequacy decision")]
    config = LegalConfig.model_validate(raw)
    assert config.data_location == "Local development machine"
    assert config.operator.country == "Local"
    party = config.third_parties[0]
    assert (party.purpose, party.role, party.region, party.transfer_safeguard) == (
        "Service operation",
        "processor",
        "European Union",
        "Adequacy decision",
    )


def test_every_user_visible_field_accepts_localized_text():
    config = LegalConfig.model_validate(_localized_raw())
    assert config.data_location == LocalizedText(**LOCALIZED["data_location"])
    assert config.operator.country == LocalizedText(**LOCALIZED["country"])
    party = config.third_parties[0]
    for field in ("purpose", "role", "region", "transfer_safeguard"):
        assert getattr(party, field) == LocalizedText(**LOCALIZED[field])


@pytest.mark.parametrize(
    "value",
    [
        {"en": "European Union"},
        {"it": "Unione europea"},
        {"en": "European Union", "it": "Unione europea", "fr": "Union européenne"},
        {"en": "", "it": "Unione europea"},
        {},
    ],
)
@pytest.mark.parametrize("field", ["data_location", "country", "purpose", "region"])
def test_incomplete_or_unknown_translations_are_rejected(field, value):
    raw = _localized_raw()
    if field == "data_location":
        raw["data_location"] = value
    elif field == "country":
        raw["operator"]["country"] = value
    else:
        raw["third_parties"][0][field] = value
    with pytest.raises(ValidationError):
        LegalConfig.model_validate(raw)


def test_plain_country_keeps_its_minimum_length():
    raw = _localized_raw()
    raw["operator"]["country"] = "I"
    with pytest.raises(ValidationError):
        LegalConfig.model_validate(raw)


def test_production_accepts_complete_localized_file_with_ordinary_english(production_legal, caplog):
    raw = _localized_raw()
    with caplog.at_level(logging.WARNING, logger="openbib.legal"):
        config = production_legal(raw)
    assert config.third_parties[0].purpose.en == "Hosting of your account and library data"
    assert not caplog.records


@pytest.mark.parametrize("language", ["en", "it"])
def test_production_rejects_blank_localized_values(production_legal, language):
    raw = _localized_raw()
    raw["third_parties"][1]["region"][language] = "   "
    with pytest.raises(RuntimeError, match="incomplete"):
        production_legal(raw)


@pytest.mark.parametrize(
    "placeholder",
    [
        "<your hosting provider>",
        "https://your-company.org",
        "TODO: describe the purpose",
        "Replace me",
        "replace-me",
        "https://example.com/privacy",
    ],
)
def test_production_still_rejects_real_placeholders(production_legal, placeholder):
    raw = _localized_raw()
    raw["third_parties"][2]["purpose"]["en"] = placeholder
    with pytest.raises(RuntimeError, match="placeholder"):
        production_legal(raw)


def test_production_warns_about_plain_strings_but_keeps_loading(production_legal, caplog):
    raw = _localized_raw()
    raw["data_location"] = "Unione europea"
    raw["third_parties"][0].update(purpose="Hosting dell'applicazione", role="processor")
    raw["third_parties"][1]["role"] = "Responsabile del trattamento"
    with caplog.at_level(logging.WARNING, logger="openbib.legal"):
        config = production_legal(raw)
    assert config.data_location == "Unione europea"
    [record] = caplog.records
    message = record.getMessage()
    assert "data_location" in message
    assert "third_parties[0].purpose" in message
    assert "third_parties[1].role" in message
    # Known role identifiers are translated by the frontend and need no localization.
    assert "third_parties[0].role" not in message
