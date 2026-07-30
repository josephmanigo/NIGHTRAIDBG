"""Registered slot-letter mapping for local scoreboard results."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Mapping


def normalize_slot_letter(value: object) -> str | None:
    text = str(value or "").strip().upper()
    if text == "0":
        text = "O"
    return text if len(text) == 1 and "A" <= text <= "Y" else None


def _clean_team_name(value: object) -> str:
    name = " ".join(str(value or "").replace("\x00", "").split()).strip()
    if not name or len(name) > 100:
        raise ValueError("team names must contain 1 to 100 printable characters")
    return name


class TeamRegistry:
    """Immutable mapping supplied by the existing Discord slot-list service."""

    def __init__(self, teams: Mapping[str, str] | None = None):
        normalized: dict[str, str] = {}
        for raw_slot, raw_name in (teams or {}).items():
            slot = normalize_slot_letter(raw_slot)
            if slot is None:
                raise ValueError(f"invalid team slot letter: {raw_slot!r}")
            if slot in normalized:
                raise ValueError(f"duplicate team slot letter: {slot}")
            normalized[slot] = _clean_team_name(raw_name)
        self._teams = normalized

    @classmethod
    def from_json_file(cls, filename: str | Path) -> "TeamRegistry":
        payload = json.loads(Path(filename).read_text(encoding="utf-8"))
        if isinstance(payload, dict) and isinstance(payload.get("teams"), list):
            teams = {
                item.get("slot_letter") or item.get("team_code"): (
                    item.get("official_team_name") or item.get("team_name")
                )
                for item in payload["teams"]
            }
            return cls(teams)
        if not isinstance(payload, dict):
            raise ValueError("team mapping JSON must be an object")
        return cls(payload)

    def resolve(self, slot: object) -> str | None:
        normalized = normalize_slot_letter(slot)
        return self._teams.get(normalized) if normalized else None

    def as_dict(self) -> dict[str, str]:
        return dict(self._teams)
