"""Local Tesseract OCR with field-specific cleanup and consensus."""

from __future__ import annotations

import re
import time
import unicodedata
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from .contracts import FieldReading, ScoreboardResult, ScoreboardRow
from .image_processor import (
    FieldCrop,
    crop_scoreboard_fields,
    load_image,
    load_layout,
    normalize_image,
    preprocessing_variants,
    require_opencv,
)
from .scoring import score_result
from .team_manager import TeamRegistry, normalize_slot_letter

try:
    import pytesseract
    from pytesseract import Output
except ImportError:  # pragma: no cover - exercised by dependency diagnostics
    pytesseract = None
    Output = None


@dataclass(frozen=True)
class OcrAttempt:
    text: str
    confidence: float
    variant: str


class OcrEngine(Protocol):
    def recognize(self, image: np.ndarray, field: str, variant: str) -> OcrAttempt:
        """Read one preprocessed fixed-coordinate field."""


class TesseractDependencyError(RuntimeError):
    """Raised when pytesseract or the native executable is unavailable."""


class PytesseractEngine:
    """Thin, local-only wrapper around the native Tesseract executable."""

    def __init__(self, tesseract_cmd: str | None = None):
        if pytesseract is None or Output is None:
            raise TesseractDependencyError(
                "pytesseract is required. Install requirements-scoreboard.txt."
            )
        if tesseract_cmd:
            pytesseract.pytesseract.tesseract_cmd = tesseract_cmd

    @staticmethod
    def _config(field: str, *, batch: bool = False) -> str:
        page_segmentation_mode = (
            6 if batch else (10 if field in {"slot", "kills"} else 7)
        )
        whitelist = (
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ0"
            if field == "slot"
            else "0123456789GOSBDIlZzCcEe/"
        )
        return (
            f"--oem 1 --psm {page_segmentation_mode} "
            "-c preserve_interword_spaces=0 "
            f"-c tessedit_char_whitelist={whitelist}"
        )

    @staticmethod
    def _attempt(
        payload: dict[str, list[object]],
        variant: str,
        indexes: list[int] | None = None,
    ) -> OcrAttempt:
        selected = (
            indexes
            if indexes is not None
            else range(len(payload.get("text", [])))
        )
        tokens: list[str] = []
        confidences: list[float] = []
        texts = payload.get("text", [])
        confidence_values = payload.get("conf", [])
        for index in selected:
            if index >= len(texts) or index >= len(confidence_values):
                continue
            text = texts[index]
            confidence = confidence_values[index]
            clean_text = str(text or "").strip()
            try:
                numeric_confidence = float(confidence)
            except (TypeError, ValueError):
                numeric_confidence = -1
            if not clean_text or numeric_confidence < 0:
                continue
            tokens.append(clean_text)
            confidences.append(numeric_confidence / 100)
        return OcrAttempt(
            text="".join(tokens),
            confidence=(
                sum(confidences) / len(confidences) if confidences else 0.0
            ),
            variant=variant,
        )

    def _recognize_payload(
        self,
        image: np.ndarray,
        field: str,
        *,
        batch: bool = False,
    ) -> dict[str, list[object]]:
        try:
            return pytesseract.image_to_data(
                image,
                config=self._config(field, batch=batch),
                output_type=Output.DICT,
            )
        except (pytesseract.TesseractNotFoundError, OSError) as reason:
            raise TesseractDependencyError(
                "Native Tesseract was not found. Install tesseract-ocr and English trained data."
            ) from reason

    def recognize(self, image: np.ndarray, field: str, variant: str) -> OcrAttempt:
        return self._attempt(
            self._recognize_payload(image, field),
            variant,
        )

    def recognize_many(
        self,
        images: list[np.ndarray],
        field: str,
        variant: str,
    ) -> list[OcrAttempt]:
        """Read one fixed field variant for every row in one Tesseract process."""

        if not images:
            return []
        active_cv2 = require_opencv()
        grayscale_images = [
            active_cv2.cvtColor(image, active_cv2.COLOR_BGR2GRAY)
            if image.ndim == 3
            else image
            for image in images
        ]
        horizontal_padding = 24
        vertical_padding = 36
        width = max(image.shape[1] for image in grayscale_images) + horizontal_padding * 2
        height = (
            sum(image.shape[0] for image in grayscale_images)
            + vertical_padding * (len(grayscale_images) + 1)
        )
        sheet = np.full((height, width), 255, dtype=np.uint8)
        segments: list[tuple[int, int]] = []
        top = vertical_padding
        for image in grayscale_images:
            inner_width = width - horizontal_padding * 2
            left = horizontal_padding + max(
                0,
                (inner_width - image.shape[1]) // 2,
            )
            bottom = top + image.shape[0]
            sheet[top:bottom, left:left + image.shape[1]] = image
            segments.append((top, bottom))
            top = bottom + vertical_padding

        payload = self._recognize_payload(sheet, field, batch=True)
        token_indexes: list[list[int]] = [[] for _image in grayscale_images]
        tops = payload.get("top", [])
        heights = payload.get("height", [])
        texts = payload.get("text", [])
        for token_index, text in enumerate(texts):
            if not str(text or "").strip():
                continue
            try:
                center = float(tops[token_index]) + float(heights[token_index]) / 2
            except (IndexError, TypeError, ValueError):
                continue
            for image_index, (segment_top, segment_bottom) in enumerate(segments):
                if segment_top <= center <= segment_bottom:
                    token_indexes[image_index].append(token_index)
                    break
        return [
            self._attempt(payload, variant, indexes)
            for indexes in token_indexes
        ]


@dataclass(frozen=True)
class _Normalized:
    value: int | str | None
    corrections: tuple[str, ...] = ()
    confidence_penalty: float = 0.0


_INTEGER_CONFUSABLES = str.maketrans(
    {
        "O": "0",
        "o": "0",
        "Q": "0",
        "D": "0",
        "G": "6",
        "S": "5",
        "B": "8",
        "I": "1",
        "l": "1",
        "|": "1",
        "]": "1",
        "Z": "2",
        "z": "2",
        "C": "2",
        "c": "2",
        "E": "2",
        "e": "2",
        "¢": "2",
        "/": "7",
        "b": "6",
    }
)


def normalize_slot_candidate(text: object) -> _Normalized:
    candidate = unicodedata.normalize("NFKC", str(text or "")).strip().upper()
    candidate = re.sub(r"[^A-Z0-9]", "", candidate)
    player_slot = re.fullmatch(r"([A-Y])[1-4]", candidate)
    if player_slot:
        return _Normalized(
            player_slot.group(1),
            ("player_slot_suffix_removed",),
            0.02,
        )
    if candidate == "0":
        return _Normalized("O", ("slot_0_to_O",), 0.08)
    slot = normalize_slot_letter(candidate)
    return _Normalized(slot)


def normalize_integer_candidate(
    text: object,
    *,
    minimum: int,
    maximum: int,
) -> _Normalized:
    candidate = unicodedata.normalize("NFKC", str(text or "")).strip()
    candidate = re.sub(r"[\s#,.:;_-]", "", candidate)
    if not candidate:
        return _Normalized(None)
    corrected = candidate.translate(_INTEGER_CONFUSABLES)
    corrections: tuple[str, ...] = ()
    penalty = 0.0
    if corrected != candidate:
        if (
            not any(character.isdigit() for character in candidate)
            and len(candidate) == 1
            and candidate.upper() in {"D", "G", "O", "Q", "S"}
        ):
            return _Normalized(None)
        corrections = (f"numeric_confusable:{candidate}->{corrected}",)
        penalty = 0.12
    if not corrected.isdigit() or len(corrected) > 3:
        return _Normalized(None)
    value = int(corrected)
    if value < minimum or value > maximum:
        return _Normalized(None)
    return _Normalized(value, corrections, penalty)


def _normalized_attempt(
    attempt: OcrAttempt,
    field: str,
    *,
    max_placement: int,
    max_kills: int,
) -> _Normalized:
    if field == "slot":
        return normalize_slot_candidate(attempt.text)
    if field == "placement":
        return normalize_integer_candidate(
            attempt.text, minimum=1, maximum=max_placement
        )
    return normalize_integer_candidate(attempt.text, minimum=0, maximum=max_kills)


def choose_consensus(
    attempts: list[OcrAttempt],
    field: str,
    *,
    minimum_confidence: float,
    max_placement: int,
    max_kills: int,
    bbox: tuple[int, int, int, int] | None = None,
) -> FieldReading:
    accepted: list[tuple[OcrAttempt, _Normalized]] = []
    for attempt in attempts:
        normalized = _normalized_attempt(
            attempt,
            field,
            max_placement=max_placement,
            max_kills=max_kills,
        )
        if normalized.value is not None:
            accepted.append((attempt, normalized))
    raw_text = " | ".join(
        f"{attempt.variant}:{attempt.text}" for attempt in attempts if attempt.text
    )
    if not accepted:
        return FieldReading(
            value=None,
            confidence=0.0,
            raw_text=raw_text,
            review_required=True,
            bbox=bbox,
        )

    grouped: dict[int | str, list[tuple[OcrAttempt, _Normalized]]] = defaultdict(list)
    for item in accepted:
        grouped[item[1].value].append(item)
    def group_score(
        items: list[tuple[OcrAttempt, _Normalized]],
    ) -> float:
        return sum(
            max(0.0, attempt.confidence - normalized.confidence_penalty)
            * (0.55 if normalized.corrections else 1.0)
            for attempt, normalized in items
        )

    ranked = sorted(
        grouped.items(),
        key=lambda item: (group_score(item[1]), len(item[1])),
        reverse=True,
    )
    selected_value, selected = ranked[0]
    adjusted = [
        max(0.0, min(1.0, attempt.confidence - normalized.confidence_penalty))
        for attempt, normalized in selected
    ]
    confidence = max(adjusted)
    if len(selected) >= 2:
        confidence = min(1.0, confidence + min(0.2, 0.18 * (len(selected) - 1)))
    selected_score = group_score(selected)
    competing_score = group_score(ranked[1][1]) if len(ranked) > 1 else 0.0
    conflict = (
        len(ranked) > 1
        and competing_score >= max(0.2, selected_score * 0.8)
    )
    if conflict:
        confidence = min(confidence, 0.6)
    corrections = tuple(
        dict.fromkeys(
            correction
            for _attempt, normalized in selected
            for correction in normalized.corrections
        )
    )
    confidence = round(confidence, 3)
    return FieldReading(
        value=selected_value,
        confidence=confidence,
        raw_text=raw_text,
        corrections=corrections,
        review_required=conflict or confidence < minimum_confidence,
        bbox=bbox,
    )


def _infer_placement_sequence(
    placements: list[FieldReading],
    active_rows: set[int],
    *,
    max_placement: int,
    anchor_confidence: float,
    minimum_confidence: float,
) -> list[FieldReading]:
    offsets = [
        placement.value - row_index
        for row_index, placement in enumerate(placements)
        if (
            row_index in active_rows
            and isinstance(placement.value, int)
            and placement.confidence >= anchor_confidence
        )
    ]
    if not offsets:
        return placements
    counts = Counter(offsets)
    offset, count = counts.most_common(1)[0]
    if count < 2 or list(counts.values()).count(count) > 1:
        return placements
    anchor_values = [
        placement.confidence
        for row_index, placement in enumerate(placements)
        if (
            row_index in active_rows
            and isinstance(placement.value, int)
            and placement.value - row_index == offset
        )
    ]
    inferred_confidence = round(
        sorted(anchor_values)[len(anchor_values) // 2] * 0.98,
        3,
    )
    output = list(placements)
    for row_index in active_rows:
        existing = output[row_index]
        predicted = offset + row_index
        if existing.source == "fixed_layout_hint":
            continue
        if not 1 <= predicted <= max_placement:
            continue
        if (
            existing.value == predicted
            and existing.confidence >= minimum_confidence
        ):
            continue
        correction = (
            "placement_sequence_confidence_promoted"
            if existing.value == predicted
            else "placement_inferred_from_two_or_more_numeric_rows"
        )
        output[row_index] = FieldReading(
            value=predicted,
            confidence=inferred_confidence,
            raw_text=existing.raw_text,
            source="sequence_inferred",
            corrections=(correction,),
            review_required=inferred_confidence < minimum_confidence,
            bbox=existing.bbox,
        )
    return output


def _slot_marker_candidates(
    crop: FieldCrop,
    layout: dict[str, Any],
) -> list[tuple[str, float]]:
    palette = layout.get("slot_color_palette", {})
    if not palette:
        return []
    active_cv2 = require_opencv()
    hsv = active_cv2.cvtColor(crop.pixels, active_cv2.COLOR_BGR2HSV)
    pixels = hsv.reshape(-1, 3)
    colored = pixels[(pixels[:, 1] > 100) & (pixels[:, 2] > 55)]
    if not len(colored):
        return []
    hue, saturation, value = (
        float(component) for component in np.median(colored, axis=0)
    )

    def distance(reference: list[int]) -> float:
        hue_delta = abs(hue - float(reference[0]))
        hue_delta = min(hue_delta, 180 - hue_delta)
        return (
            (hue_delta * 2) ** 2
            + ((saturation - float(reference[1])) / 4) ** 2
            + ((value - float(reference[2])) / 4) ** 2
        ) ** 0.5

    return sorted(
        (
            (slot, round(distance(reference), 3))
            for slot, reference in palette.items()
        ),
        key=lambda item: item[1],
    )


def _reconcile_slot_marker(
    reading: FieldReading,
    marker_crop: FieldCrop | None,
    layout: dict[str, Any],
) -> FieldReading:
    if marker_crop is None:
        return reading
    candidates = _slot_marker_candidates(marker_crop, layout)
    if not candidates:
        return reading
    maximum_distance = float(layout.get("slot_color_max_distance", 18))
    ambiguity_margin = float(layout.get("slot_color_ambiguity_margin", 5))
    best_slot, best_distance = candidates[0]
    runner_up_distance = candidates[1][1] if len(candidates) > 1 else float("inf")
    if best_distance > maximum_distance:
        return reading
    if runner_up_distance - best_distance < ambiguity_margin:
        tied_slots = {
            slot
            for slot, distance in candidates
            if distance - best_distance < ambiguity_margin
        }
        marker_confidence = max(
            0.86,
            min(0.96, 0.96 - (best_distance / max(maximum_distance, 1)) * 0.1),
        )
        if reading.value == best_slot:
            return replace(
                reading,
                confidence=round(max(reading.confidence, marker_confidence), 3),
                source="ocr+fixed_color_marker",
                review_required=False,
            )
        if reading.value in tied_slots:
            return replace(
                reading,
                confidence=round(max(reading.confidence, 0.86), 3),
                source="ocr+fixed_color_marker",
                review_required=False,
            )
        if tied_slots == {"D", "F"} and reading.value in {"B", "O"}:
            return FieldReading(
                value="D",
                confidence=0.86,
                raw_text=reading.raw_text,
                source="ocr+fixed_color_marker",
                corrections=tuple(
                    dict.fromkeys(
                        (
                            *reading.corrections,
                            "closed_glyph_disambiguated_as_D",
                        )
                    )
                ),
                review_required=False,
                bbox=reading.bbox,
            )
        return replace(
            reading,
            value=None,
            confidence=0.0,
            source="ocr+fixed_color_marker",
            corrections=tuple(
                dict.fromkeys(
                    (*reading.corrections, "ambiguous_fixed_color_marker")
                )
            ),
            review_required=True,
        )
    marker_confidence = max(
        0.82,
        min(0.98, 0.98 - (best_distance / max(maximum_distance, 1)) * 0.16),
    )
    if reading.value == best_slot:
        return replace(
            reading,
            confidence=round(max(reading.confidence, marker_confidence), 3),
            source="ocr+fixed_color_marker",
            review_required=marker_confidence
            < float(layout["ocr"]["minimum_confidence"]),
        )
    return FieldReading(
        value=best_slot,
        confidence=round(marker_confidence, 3),
        raw_text=reading.raw_text,
        source="ocr+fixed_color_marker",
        corrections=tuple(
            dict.fromkeys(
                (*reading.corrections, "slot_corrected_from_fixed_color_marker")
            )
        ),
        review_required=marker_confidence
        < float(layout["ocr"]["minimum_confidence"]),
        bbox=reading.bbox,
    )


def _reconcile_repeated_one(
    reading: FieldReading,
    crop: FieldCrop,
) -> FieldReading:
    if crop.field != "kills" or reading.value != 1:
        return reading
    active_cv2 = require_opencv()
    hsv = active_cv2.cvtColor(crop.pixels, active_cv2.COLOR_BGR2HSV)
    mask = np.where(
        (hsv[:, :, 1] < 100) & (hsv[:, :, 2] > 120),
        255,
        0,
    ).astype(np.uint8)
    component_count, _labels, stats, _centroids = (
        active_cv2.connectedComponentsWithStats(mask)
    )
    glyphs = [
        tuple(int(item) for item in stats[index])
        for index in range(1, component_count)
        if (
            int(stats[index][active_cv2.CC_STAT_AREA]) >= 8
            and int(stats[index][active_cv2.CC_STAT_HEIGHT])
            >= max(5, crop.pixels.shape[0] // 3)
            and int(stats[index][active_cv2.CC_STAT_WIDTH])
            <= max(5, crop.pixels.shape[1] // 3)
        )
    ]
    if len(glyphs) != 2:
        return reading
    glyphs.sort(key=lambda item: item[active_cv2.CC_STAT_LEFT])
    first, second = glyphs
    height_difference = abs(
        first[active_cv2.CC_STAT_HEIGHT] - second[active_cv2.CC_STAT_HEIGHT]
    )
    horizontal_gap = (
        second[active_cv2.CC_STAT_LEFT]
        - first[active_cv2.CC_STAT_LEFT]
        - first[active_cv2.CC_STAT_WIDTH]
    )
    if height_difference > 2 or not 0 <= horizontal_gap <= 5:
        return reading
    return FieldReading(
        value=11,
        confidence=max(0.9, reading.confidence),
        raw_text=reading.raw_text,
        source="ocr+opencv_components",
        corrections=tuple(
            dict.fromkeys((*reading.corrections, "two_one_glyphs_verified"))
        ),
        review_required=False,
        bbox=reading.bbox,
    )


class LocalScoreboardReader:
    """Read fixed scoreboard rows without any network or AI service."""

    def __init__(
        self,
        *,
        layout_path: str | Path,
        engine: OcrEngine | None = None,
        team_registry: TeamRegistry | None = None,
        tesseract_cmd: str | None = None,
    ):
        self.layout_path = Path(layout_path)
        self.engine = engine or PytesseractEngine(tesseract_cmd=tesseract_cmd)
        self.team_registry = team_registry

    def _read_crop(
        self,
        crop: FieldCrop,
        layout: dict[str, Any],
    ) -> FieldReading:
        attempts = [
            self.engine.recognize(image, crop.field, variant)
            for variant, image in preprocessing_variants(
                crop.pixels,
                upscale=int(layout["ocr"]["upscale"]),
                field=crop.field,
            ).items()
        ]
        return choose_consensus(
            attempts,
            crop.field,
            minimum_confidence=float(layout["ocr"]["minimum_confidence"]),
            max_placement=int(layout["ocr"]["max_placement"]),
            max_kills=int(layout["ocr"]["max_kills"]),
            bbox=crop.bbox,
        )

    def _read_crops_batched(
        self,
        crops: list[FieldCrop],
        layout: dict[str, Any],
    ) -> list[FieldReading]:
        attempts_by_crop: list[list[OcrAttempt]] = [[] for _crop in crops]
        groups: dict[tuple[str, str], list[tuple[int, np.ndarray]]] = defaultdict(list)
        placement_hints = {
            int(row_index)
            for row_index in layout.get("placement_hints", {})
        }
        for crop_index, crop in enumerate(crops):
            variants = preprocessing_variants(
                crop.pixels,
                upscale=int(layout["ocr"]["upscale"]),
                field=crop.field,
            )
            if crop.field == "placement":
                if crop.row_index in placement_hints:
                    continue
                variant = (
                    "inverted_otsu"
                    if "inverted_otsu" in variants
                    else next(iter(variants))
                )
                attempts_by_crop[crop_index].append(
                    self.engine.recognize(variants[variant], crop.field, variant)
                )
                continue
            for variant, image in variants.items():
                groups[(crop.field, variant)].append((crop_index, image))

        for (field, variant), entries in groups.items():
            attempts = self.engine.recognize_many(
                [image for _crop_index, image in entries],
                field,
                variant,
            )
            if len(attempts) != len(entries):
                raise RuntimeError(
                    "The batched Tesseract reader returned an unexpected row count."
                )
            for (crop_index, _image), attempt in zip(entries, attempts):
                attempts_by_crop[crop_index].append(attempt)

        readings = [
            choose_consensus(
                attempts,
                crop.field,
                minimum_confidence=float(layout["ocr"]["minimum_confidence"]),
                max_placement=int(layout["ocr"]["max_placement"]),
                max_kills=int(layout["ocr"]["max_kills"]),
                bbox=crop.bbox,
            )
            for crop, attempts in zip(crops, attempts_by_crop)
        ]
        for crop_index, (crop, reading) in enumerate(zip(crops, readings)):
            if crop.row_index in placement_hints and crop.field == "placement":
                continue
            if reading.review_required:
                readings[crop_index] = self._read_crop(crop, layout)
        return readings

    def read(self, image_path: str | Path) -> ScoreboardResult:
        started = time.perf_counter()
        layout = load_layout(self.layout_path)
        loaded = load_image(image_path)
        normalized = normalize_image(loaded.pixels, layout)
        crops = crop_scoreboard_fields(normalized, layout)
        marker_crops = {
            crop.row_index: crop for crop in crops if crop.field == "slot_color"
        }
        crops = [crop for crop in crops if crop.field != "slot_color"]
        fields: dict[int, dict[str, FieldReading]] = defaultdict(dict)
        parallel_workers = int(layout["ocr"].get("parallel_workers", 1))
        if callable(getattr(self.engine, "recognize_many", None)):
            readings = self._read_crops_batched(crops, layout)
        elif parallel_workers == 1:
            readings = [self._read_crop(crop, layout) for crop in crops]
        else:
            with ThreadPoolExecutor(max_workers=parallel_workers) as executor:
                readings = list(
                    executor.map(
                        lambda crop: self._read_crop(crop, layout),
                        crops,
                    )
                )
        for crop, reading in zip(crops, readings):
            reading = _reconcile_repeated_one(reading, crop)
            fields[crop.row_index][crop.field] = reading
        for row_index, row_fields in fields.items():
            row_fields["slot"] = _reconcile_slot_marker(
                row_fields["slot"],
                marker_crops.get(row_index),
                layout,
            )

        active_rows = {
            row_index
            for row_index, row_fields in fields.items()
            if row_fields["slot"].value is not None or row_fields["kills"].value is not None
        }
        placements = [fields[index]["placement"] for index in range(len(layout["rows"]))]
        hint_confidence = float(layout["ocr"].get("placement_hint_confidence", 0.95))
        for raw_row_index, raw_placement in layout.get("placement_hints", {}).items():
            row_index = int(raw_row_index)
            if row_index not in active_rows:
                continue
            existing = placements[row_index]
            placements[row_index] = FieldReading(
                value=int(raw_placement),
                confidence=hint_confidence,
                raw_text=existing.raw_text,
                source="fixed_layout_hint",
                corrections=("placement_from_fixed_pinned_row",),
                review_required=hint_confidence
                < float(layout["ocr"]["minimum_confidence"]),
                bbox=existing.bbox,
            )
        placements = _infer_placement_sequence(
            placements,
            active_rows,
            max_placement=int(layout["ocr"]["max_placement"]),
            anchor_confidence=float(layout["ocr"]["sequence_anchor_confidence"]),
            minimum_confidence=float(layout["ocr"]["minimum_confidence"]),
        )
        for row_index, placement in enumerate(placements):
            fields[row_index]["placement"] = placement

        rows: list[ScoreboardRow] = []
        for row_index in sorted(active_rows):
            placement = fields[row_index]["placement"]
            slot = fields[row_index]["slot"]
            kills = fields[row_index]["kills"]
            team_name = (
                self.team_registry.resolve(slot.value)
                if self.team_registry is not None and slot.value is not None
                else None
            )
            warnings: list[str] = []
            if slot.value is not None and self.team_registry is not None and team_name is None:
                warnings.append("slot_not_registered")
            preview = None
            if isinstance(placement.value, int) and isinstance(kills.value, int):
                preview = score_result(placement.value, kills.value)
            rows.append(
                ScoreboardRow(
                    row_index=row_index,
                    placement=placement,
                    slot=slot,
                    kills=kills,
                    team_name=team_name,
                    placement_points=preview["placement_points"] if preview else None,
                    kill_points=preview["kill_points"] if preview else None,
                    total_score=preview["total_score"] if preview else None,
                    warnings=tuple(warnings),
                )
            )

        placement_counts = Counter(
            row.placement.value for row in rows if isinstance(row.placement.value, int)
        )
        slot_counts = Counter(
            row.slot.value for row in rows if isinstance(row.slot.value, str)
        )
        validated_rows: list[ScoreboardRow] = []
        for row in rows:
            warnings = list(row.warnings)
            if (
                isinstance(row.placement.value, int)
                and placement_counts[row.placement.value] > 1
            ):
                warnings.append("duplicate_placement")
            if isinstance(row.slot.value, str) and slot_counts[row.slot.value] > 1:
                warnings.append("duplicate_slot")
            validated_rows.append(replace(row, warnings=tuple(dict.fromkeys(warnings))))

        return ScoreboardResult(
            source_path=str(loaded.path),
            source_sha256=loaded.original_sha256,
            layout_id=str(layout["id"]),
            layout_version=int(layout["version"]),
            image_width=int(loaded.pixels.shape[1]),
            image_height=int(loaded.pixels.shape[0]),
            rows=tuple(validated_rows),
            processing_ms=round((time.perf_counter() - started) * 1000),
        )
