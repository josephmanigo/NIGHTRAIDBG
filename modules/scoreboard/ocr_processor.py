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
    isolate_kill_digits,
    load_image,
    normalize_image,
    preprocessing_variants,
    require_opencv,
    select_layout_for_image,
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
            (4 if field == "placement" else 6)
            if batch
            else (10 if field in {"slot", "kills"} else 7)
        )
        if field == "slot":
            whitelist = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0"
        elif field == "placement":
            whitelist = "#0123456789GOSBDIlZzCcEe/"
        else:
            whitelist = "0123456789GOSBDIlZzCcEe/"
        numeric_mode = (
            " -c classify_bln_numeric_mode=1"
            if field in {"placement", "kills"}
            else ""
        )
        return (
            f"--oem 1 --psm {page_segmentation_mode} "
            "-c preserve_interword_spaces=0 "
            "-c user_defined_dpi=300 "
            f"-c tessedit_char_whitelist={whitelist}"
            f"{numeric_mode}"
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
    glyph_crop: FieldCrop | None = None,
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
    near_slots = {
        slot
        for slot, distance in candidates
        if distance - best_distance < max(5, ambiguity_margin)
    }
    if {"D", "F", "P"}.issubset(near_slots) and glyph_crop is not None:
        classified = _classify_d_f_p_glyph(glyph_crop)
        if classified is not None:
            return FieldReading(
                value=classified,
                confidence=0.92,
                raw_text=reading.raw_text,
                source="ocr+fixed_color_marker+opencv_topology",
                corrections=tuple(
                    dict.fromkeys(
                        (
                            *reading.corrections,
                            "D_F_P_disambiguated_from_fixed_glyph_topology",
                        )
                    )
                ),
                review_required=False,
                bbox=reading.bbox,
            )
    if {"H", "R"}.issubset(near_slots) and glyph_crop is not None:
        classified = _classify_h_r_glyph(glyph_crop)
        if classified is not None:
            return FieldReading(
                value=classified,
                confidence=0.92,
                raw_text=reading.raw_text,
                source="ocr+fixed_color_marker+opencv_topology",
                corrections=tuple(
                    dict.fromkeys(
                        (
                            *reading.corrections,
                            "H_R_disambiguated_from_fixed_glyph_topology",
                        )
                    )
                ),
                review_required=False,
                bbox=reading.bbox,
            )
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
        if tied_slots == {"D", "F"} and glyph_crop is not None:
            closed_glyph = _slot_glyph_has_hole(glyph_crop)
            return FieldReading(
                value="D" if closed_glyph else "F",
                confidence=0.9,
                raw_text=reading.raw_text,
                source="ocr+fixed_color_marker+opencv_topology",
                corrections=tuple(
                    dict.fromkeys(
                        (
                            *reading.corrections,
                            "D_F_disambiguated_from_fixed_glyph_topology",
                        )
                    )
                ),
                review_required=False,
                bbox=reading.bbox,
            )
        if tied_slots == {"D", "F", "P"} and glyph_crop is not None:
            classified = _classify_d_f_p_glyph(glyph_crop)
            if classified is not None:
                return FieldReading(
                    value=classified,
                    confidence=0.92,
                    raw_text=reading.raw_text,
                    source="ocr+fixed_color_marker+opencv_topology",
                    corrections=tuple(
                        dict.fromkeys(
                            (
                                *reading.corrections,
                                "D_F_P_disambiguated_from_fixed_glyph_topology",
                            )
                        )
                    ),
                    review_required=False,
                    bbox=reading.bbox,
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


def _slot_glyph_has_hole(crop: FieldCrop) -> bool:
    active_cv2 = require_opencv()
    hsv = active_cv2.cvtColor(crop.pixels, active_cv2.COLOR_BGR2HSV)
    mask = np.where(
        (hsv[:, :, 1] > 100) & (hsv[:, :, 2] > 55),
        255,
        0,
    ).astype(np.uint8)
    contours, hierarchy = active_cv2.findContours(
        mask,
        active_cv2.RETR_CCOMP,
        active_cv2.CHAIN_APPROX_SIMPLE,
    )
    if hierarchy is None:
        return False
    return any(
        item[3] >= 0 and active_cv2.contourArea(contours[index]) >= 10
        for index, item in enumerate(hierarchy[0])
    )


def _tight_colored_glyph(
    crop: FieldCrop,
    *,
    hue_hint: int,
) -> np.ndarray | None:
    active_cv2 = require_opencv()
    hsv = active_cv2.cvtColor(crop.pixels, active_cv2.COLOR_BGR2HSV)
    hue_delta = np.abs(hsv[:, :, 0].astype(np.int16) - hue_hint)
    hue_delta = np.minimum(hue_delta, 180 - hue_delta)
    mask = np.where(
        (hue_delta <= 10)
        & (hsv[:, :, 1] > 100)
        & (hsv[:, :, 2] > 55),
        255,
        0,
    ).astype(np.uint8)
    y_points, x_points = np.where(mask > 0)
    if not len(x_points):
        return None
    tight = mask[
        int(y_points.min()) : int(y_points.max()) + 1,
        int(x_points.min()) : int(x_points.max()) + 1,
    ]
    if tight.shape[0] >= crop.pixels.shape[0] * 0.75:
        return None
    return tight


def _classify_d_f_p_glyph(crop: FieldCrop) -> str | None:
    active_cv2 = require_opencv()
    tight = _tight_colored_glyph(crop, hue_hint=24)
    if tight is None:
        return None
    contours, hierarchy = active_cv2.findContours(
        tight,
        active_cv2.RETR_CCOMP,
        active_cv2.CHAIN_APPROX_SIMPLE,
    )
    has_hole = hierarchy is not None and any(
        item[3] >= 0 and active_cv2.contourArea(contours[index]) >= 3
        for index, item in enumerate(hierarchy[0])
    )
    height, width = tight.shape
    bottom_right = tight[
        round(height * 0.62) :,
        round(width * 0.55) :,
    ]
    bottom_right_density = float((bottom_right > 0).mean())
    if not has_hole:
        return "D" if bottom_right_density >= 0.45 else "F"
    return "D" if bottom_right_density >= 0.4 else "P"


def _classify_h_r_glyph(crop: FieldCrop) -> str | None:
    tight = _tight_colored_glyph(crop, hue_hint=40)
    if tight is None:
        return None
    height, width = tight.shape
    top_center = tight[
        : max(1, round(height * 0.3)),
        round(width * 0.25) : max(round(width * 0.75), round(width * 0.25) + 1),
    ]
    return "R" if float((top_center > 0).mean()) >= 0.4 else "H"


def _kill_glyph_components(
    crop: FieldCrop,
) -> list[tuple[np.ndarray, tuple[int, int, int, int, int]]]:
    """Return fixed-font kill glyphs after removing the skull and tiny noise."""

    if crop.field != "kills":
        return []
    active_cv2 = require_opencv()
    grayscale = active_cv2.cvtColor(crop.pixels, active_cv2.COLOR_BGR2GRAY)
    hsv = active_cv2.cvtColor(crop.pixels, active_cv2.COLOR_BGR2HSV)
    grayscale = np.where(
        hsv[:, :, 1] > 100,
        0,
        grayscale,
    ).astype(np.uint8)
    mask = isolate_kill_digits(
        np.where(grayscale > 160, 255, 0).astype(np.uint8)
    )
    component_count, labels, stats, _centroids = (
        active_cv2.connectedComponentsWithStats(mask)
    )
    output: list[tuple[np.ndarray, tuple[int, int, int, int, int]]] = []
    for index in range(1, component_count):
        component = tuple(int(item) for item in stats[index])
        left, top, width, height, area = component
        if area < 8 or height < max(5, round(crop.pixels.shape[0] * 0.2)):
            continue
        glyph = np.where(
            labels[top : top + height, left : left + width] == index,
            255,
            0,
        ).astype(np.uint8)
        output.append((glyph, component))
    return sorted(
        output,
        key=lambda item: item[1][active_cv2.CC_STAT_LEFT],
    )


def _glyph_hole_count(glyph: np.ndarray) -> int:
    active_cv2 = require_opencv()
    contours, hierarchy = active_cv2.findContours(
        glyph,
        active_cv2.RETR_CCOMP,
        active_cv2.CHAIN_APPROX_SIMPLE,
    )
    if hierarchy is None:
        return 0
    return sum(
        1
        for index, item in enumerate(hierarchy[0])
        if item[3] >= 0 and active_cv2.contourArea(contours[index]) >= 2
    )


def _reconcile_missing_leading_one(
    reading: FieldReading,
    crop: FieldCrop,
) -> FieldReading:
    """Recover a leading 1 that batched Tesseract occasionally drops."""

    if (
        crop.field != "kills"
        or not isinstance(reading.value, int)
        or not 0 <= reading.value <= 9
    ):
        return reading
    glyphs = _kill_glyph_components(crop)
    if len(glyphs) != 2:
        return reading
    first_glyph, first = glyphs[0]
    _second_glyph, second = glyphs[1]
    first_width = first[2]
    first_height = first[3]
    second_width = second[2]
    second_height = second[3]
    gap = second[0] - first[0] - first_width
    occupied_rows = np.count_nonzero(np.any(first_glyph > 0, axis=1))
    if (
        abs(first_height - second_height) > 2
        or first_width > first_height * 0.55
        or first_width > second_width * 0.85
        or not 0 <= gap <= 4
        or occupied_rows < first_height * 0.75
    ):
        return reading
    return FieldReading(
        value=10 + reading.value,
        confidence=max(0.93, reading.confidence),
        raw_text=reading.raw_text,
        source="ocr+opencv_digit_topology",
        corrections=tuple(
            dict.fromkeys(
                (*reading.corrections, "missing_leading_one_recovered")
            )
        ),
        review_required=False,
        bbox=reading.bbox,
    )


def _reconcile_three_misread_as_four(
    reading: FieldReading,
    crop: FieldCrop,
) -> FieldReading:
    """Resolve the fixed-font 30/40 conflict using the 4 crossbar."""

    if (
        crop.field != "kills"
        or reading.value != 40
        or not reading.review_required
        or not re.search(r":[#]?3(?:0)?(?:\s*(?:\||$))", reading.raw_text)
    ):
        return reading
    glyphs = _kill_glyph_components(crop)
    if len(glyphs) != 2:
        return reading
    leading = glyphs[0][0]
    height = leading.shape[0]
    middle_lower = leading[
        max(0, round(height * 0.45)) : max(1, round(height * 0.82))
    ]
    has_four_crossbar = bool(
        len(middle_lower)
        and np.max(np.mean(middle_lower > 0, axis=1)) >= 0.85
    )
    if has_four_crossbar:
        return reading
    return FieldReading(
        value=30,
        confidence=max(0.93, reading.confidence),
        raw_text=reading.raw_text,
        source="ocr+opencv_digit_topology",
        corrections=tuple(
            dict.fromkeys(
                (*reading.corrections, "leading_three_verified_without_four_crossbar")
            )
        ),
        review_required=False,
        bbox=reading.bbox,
    )


def _reconcile_terminal_six(
    reading: FieldReading,
    crop: FieldCrop,
) -> FieldReading:
    """Promote a conflicted terminal 6 only when its closed loop is visible."""

    if (
        crop.field != "kills"
        or not isinstance(reading.value, int)
        or reading.value % 10 != 6
        or not reading.review_required
    ):
        return reading
    glyphs = _kill_glyph_components(crop)
    if not glyphs or _glyph_hole_count(glyphs[-1][0]) < 1:
        return reading
    return FieldReading(
        value=reading.value,
        confidence=max(0.93, reading.confidence),
        raw_text=reading.raw_text,
        source="ocr+opencv_digit_topology",
        corrections=tuple(
            dict.fromkeys((*reading.corrections, "terminal_six_loop_verified"))
        ),
        review_required=False,
        bbox=reading.bbox,
    )


def _reconcile_uncontested_three(
    reading: FieldReading,
    crop: FieldCrop,
) -> FieldReading:
    """Accept a visible 3 only when OCR agrees and fixed-font topology matches."""

    if (
        crop.field != "kills"
        or not isinstance(reading.value, int)
        or reading.value != 3
        or not reading.review_required
    ):
        return reading
    candidate_values = {
        normalized.value
        for part in reading.raw_text.split("|")
        if ":" in part
        for normalized in [
            normalize_integer_candidate(
                part.split(":", 1)[1].strip(),
                minimum=0,
                maximum=999,
            )
        ]
        if normalized.value is not None
    }
    if candidate_values != {reading.value}:
        return reading
    glyphs = _kill_glyph_components(crop)
    if len(glyphs) != 1:
        return reading
    glyph = glyphs[0][0]
    if _glyph_hole_count(glyph) != 0 or glyph.shape[1] < 4:
        return reading
    height, width = glyph.shape
    row_density = np.mean(glyph > 0, axis=1)
    thirds = (
        row_density[: max(1, height // 3)],
        row_density[height // 3 : max(height // 3 + 1, 2 * height // 3)],
        row_density[2 * height // 3 :],
    )
    right_density = float(
        np.mean(glyph[:, max(0, round(width * 0.6)) :] > 0)
    )
    if (
        any(len(section) == 0 for section in thirds)
        or float(np.max(thirds[0])) < 0.7
        or float(np.max(thirds[1])) < 0.6
        or float(np.max(thirds[2])) < 0.7
        or right_density < 0.45
    ):
        return reading
    return FieldReading(
        value=reading.value,
        confidence=max(0.86, reading.confidence),
        raw_text=reading.raw_text,
        source="ocr+opencv_digit_topology",
        corrections=tuple(
            dict.fromkeys(
                (*reading.corrections, "uncontested_three_glyph_verified")
            )
        ),
        review_required=False,
        bbox=reading.bbox,
    )


def _reconcile_supported_numeric(
    reading: FieldReading,
    crop: FieldCrop,
) -> FieldReading:
    """Promote a multi-digit value supported by a strict OCR majority and glyph count."""

    if (
        crop.field != "kills"
        or not isinstance(reading.value, int)
        or reading.value < 10
        or not reading.review_required
    ):
        return reading
    candidate_observations: set[tuple[str, int]] = set()
    for part in reading.raw_text.split("|"):
        if ":" not in part:
            continue
        variant, text = part.split(":", 1)
        normalized = normalize_integer_candidate(
            text.strip(),
            minimum=0,
            maximum=999,
        )
        if isinstance(normalized.value, int):
            candidate_observations.add((variant.strip(), normalized.value))
    counts = Counter(value for _variant, value in candidate_observations)
    selected_count = counts.get(reading.value, 0)
    competing_count = max(
        (count for value, count in counts.items() if value != reading.value),
        default=0,
    )
    glyphs = _kill_glyph_components(crop)
    if (
        selected_count < 2
        or selected_count <= competing_count
        or len(glyphs) != len(str(reading.value))
    ):
        return reading
    glyph_heights = [component[3] for _glyph, component in glyphs]
    if max(glyph_heights) - min(glyph_heights) > 2:
        return reading
    return FieldReading(
        value=reading.value,
        confidence=max(0.86, reading.confidence),
        raw_text=reading.raw_text,
        source="ocr+opencv_digit_topology",
        corrections=tuple(
            dict.fromkeys(
                (*reading.corrections, "numeric_majority_and_glyph_count_verified")
            )
        ),
        review_required=False,
        bbox=reading.bbox,
    )


def _reconcile_repeated_one(
    reading: FieldReading,
    crop: FieldCrop,
) -> FieldReading:
    if crop.field != "kills" or reading.value != 1:
        return reading
    active_cv2 = require_opencv()
    glyphs = [
        component
        for _glyph, component in _kill_glyph_components(crop)
        if component[active_cv2.CC_STAT_WIDTH]
        <= max(5, crop.pixels.shape[1] // 3)
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
    if (
        height_difference > 2
        or second[active_cv2.CC_STAT_WIDTH]
        > first[active_cv2.CC_STAT_WIDTH] * 1.25
        or not 0 <= horizontal_gap <= 5
    ):
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


def _reconcile_fixed_eighteen(
    reading: FieldReading,
    crop: FieldCrop,
) -> FieldReading:
    """Recover fixed-font 18 when OCR variants disagree on the final digit."""

    if crop.field != "kills" or not reading.review_required:
        return reading
    glyphs = _kill_glyph_components(crop)
    if len(glyphs) != 2:
        return reading
    first_glyph, first = glyphs[0]
    second_glyph, second = glyphs[1]
    first_width = first[2]
    first_height = first[3]
    second_width = second[2]
    second_height = second[3]
    gap = second[0] - first[0] - first_width
    occupied_rows = np.count_nonzero(np.any(first_glyph > 0, axis=1))
    if (
        abs(first_height - second_height) > 2
        or first_width > first_height * 0.55
        or first_width > second_width * 0.85
        or not 0 <= gap <= 4
        or occupied_rows < first_height * 0.75
        or _glyph_hole_count(first_glyph) != 0
        or _glyph_hole_count(second_glyph) < 2
    ):
        return reading
    return FieldReading(
        value=18,
        confidence=max(0.93, reading.confidence),
        raw_text=reading.raw_text,
        source="ocr+opencv_digit_topology",
        corrections=tuple(
            dict.fromkeys(
                (*reading.corrections, "fixed_18_verified_from_digit_topology")
            )
        ),
        review_required=False,
        bbox=reading.bbox,
    )


def _reconcile_unreadable_seventeen(
    reading: FieldReading,
    crop: FieldCrop,
) -> FieldReading:
    if crop.field != "kills" or reading.value not in {None, 1, 11}:
        return reading
    active_cv2 = require_opencv()
    grayscale = active_cv2.cvtColor(crop.pixels, active_cv2.COLOR_BGR2GRAY)
    mask = isolate_kill_digits(
        np.where(grayscale > 160, 255, 0).astype(np.uint8)
    )
    component_count, labels, stats, _centroids = (
        active_cv2.connectedComponentsWithStats(mask)
    )
    components = sorted(
        [
            (index, tuple(int(item) for item in stats[index]))
            for index in range(1, component_count)
            if (
                int(stats[index][active_cv2.CC_STAT_AREA]) >= 8
                and int(stats[index][active_cv2.CC_STAT_HEIGHT]) >= 5
            )
        ],
        key=lambda item: item[1][active_cv2.CC_STAT_LEFT],
    )
    if len(components) != 2:
        return reading
    (_first_index, first), (second_index, second) = components
    first_width = first[active_cv2.CC_STAT_WIDTH]
    first_height = first[active_cv2.CC_STAT_HEIGHT]
    second_width = second[active_cv2.CC_STAT_WIDTH]
    second_height = second[active_cv2.CC_STAT_HEIGHT]
    if (
        abs(first_height - second_height) > 2
        or first_width > first_height * 0.5
        or second_width < first_width * 1.3
        or second_width < second_height * 0.45
    ):
        return reading
    left = second[active_cv2.CC_STAT_LEFT]
    top = second[active_cv2.CC_STAT_TOP]
    glyph = np.where(
        labels[
            top : top + second_height,
            left : left + second_width,
        ] == second_index,
        255,
        0,
    ).astype(np.uint8)
    if float((glyph[: max(1, round(second_height * 0.3))] > 0).mean()) < 0.3:
        return reading
    return FieldReading(
        value=17,
        confidence=0.9,
        raw_text=reading.raw_text,
        source="ocr+opencv_digit_topology",
        corrections=tuple(
            dict.fromkeys(
                (*reading.corrections, "unreadable_17_verified_from_fixed_glyphs")
            )
        ),
        review_required=False,
        bbox=reading.bbox,
    )


def _reconcile_zero_kill(
    reading: FieldReading,
    crop: FieldCrop,
    layout: dict[str, Any],
) -> FieldReading:
    if (
        crop.field != "kills"
        or reading.value not in {None, 0}
        or (reading.value == 0 and not reading.review_required)
    ):
        return reading
    active_cv2 = require_opencv()
    variants = preprocessing_variants(
        crop.pixels,
        upscale=int(layout["ocr"]["upscale"]),
        field="kills",
    )
    image = variants.get("gray_160")
    if image is None:
        return reading
    mask = np.where(image < 128, 255, 0).astype(np.uint8)
    component_count, _labels, stats, _centroids = (
        active_cv2.connectedComponentsWithStats(mask)
    )
    components = [
        index
        for index in range(1, component_count)
        if int(stats[index][active_cv2.CC_STAT_AREA]) >= 20
    ]
    if len(components) != 1:
        return reading
    component_area = int(stats[components[0]][active_cv2.CC_STAT_AREA])
    contours, hierarchy = active_cv2.findContours(
        mask,
        active_cv2.RETR_CCOMP,
        active_cv2.CHAIN_APPROX_SIMPLE,
    )
    if hierarchy is None:
        return reading
    hole_areas = [
        active_cv2.contourArea(contours[index])
        for index, item in enumerate(hierarchy[0])
        if item[3] >= 0
    ]
    if not hole_areas or max(hole_areas) < component_area * 0.65:
        return reading
    return FieldReading(
        value=0,
        confidence=0.93,
        raw_text=reading.raw_text,
        source="ocr+opencv_closed_zero",
        corrections=tuple(
            dict.fromkeys((*reading.corrections, "zero_verified_from_fixed_glyph"))
        ),
        review_required=False,
        bbox=reading.bbox,
    )


def _reconcile_eight_nine(
    reading: FieldReading,
    crop: FieldCrop,
) -> FieldReading:
    if (
        crop.field != "kills"
        or not isinstance(reading.value, int)
        or reading.value % 10 != 9
    ):
        return reading
    active_cv2 = require_opencv()
    grayscale = active_cv2.cvtColor(crop.pixels, active_cv2.COLOR_BGR2GRAY)
    mask = isolate_kill_digits(
        np.where(grayscale > 160, 255, 0).astype(np.uint8)
    )
    component_count, labels, stats, _centroids = (
        active_cv2.connectedComponentsWithStats(mask)
    )
    components = [
        (index, tuple(int(item) for item in stats[index]))
        for index in range(1, component_count)
        if (
            int(stats[index][active_cv2.CC_STAT_AREA]) >= 8
            and int(stats[index][active_cv2.CC_STAT_HEIGHT]) >= 5
        )
    ]
    if not components:
        return reading
    index, component = max(
        components,
        key=lambda item: item[1][active_cv2.CC_STAT_LEFT],
    )
    left = component[active_cv2.CC_STAT_LEFT]
    top = component[active_cv2.CC_STAT_TOP]
    width = component[active_cv2.CC_STAT_WIDTH]
    height = component[active_cv2.CC_STAT_HEIGHT]
    glyph = np.where(
        labels[top : top + height, left : left + width] == index,
        255,
        0,
    ).astype(np.uint8)
    contours, hierarchy = active_cv2.findContours(
        glyph,
        active_cv2.RETR_CCOMP,
        active_cv2.CHAIN_APPROX_SIMPLE,
    )
    holes = 0 if hierarchy is None else sum(
        1
        for contour_index, item in enumerate(hierarchy[0])
        if item[3] >= 0 and active_cv2.contourArea(contours[contour_index]) >= 1
    )
    if holes < 2:
        return reading
    return FieldReading(
        value=reading.value - 1,
        confidence=max(0.93, reading.confidence),
        raw_text=reading.raw_text,
        source="ocr+opencv_digit_topology",
        corrections=tuple(
            dict.fromkeys(
                (*reading.corrections, "terminal_9_corrected_to_8_from_two_holes")
            )
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

    @staticmethod
    def _preprocessing_variants(
        crop: FieldCrop,
        layout: dict[str, Any],
    ) -> dict[str, np.ndarray]:
        variants = preprocessing_variants(
            crop.pixels,
            upscale=int(layout["ocr"]["upscale"]),
            field=crop.field,
        )
        if not layout["ocr"].get("fast_mode", False):
            return variants
        preferred = {
            "placement": ("inverted_otsu",),
            "slot": ("raw", "inner"),
            "kills": ("gray_160", "gray_200", "otsu"),
        }[crop.field]
        return {
            variant: variants[variant]
            for variant in preferred
            if variant in variants
        }

    def _read_crop(
        self,
        crop: FieldCrop,
        layout: dict[str, Any],
    ) -> FieldReading:
        attempts = [
            self.engine.recognize(image, crop.field, variant)
            for variant, image in self._preprocessing_variants(crop, layout).items()
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
            variants = self._preprocessing_variants(crop, layout)
            if crop.field == "placement" and crop.row_index in placement_hints:
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
        fallback_fields = set(
            layout["ocr"].get("individual_fallback_fields", [])
        )
        if layout["ocr"].get("fast_mode", False) and not fallback_fields:
            return readings
        for crop_index, (crop, reading) in enumerate(zip(crops, readings)):
            if (
                layout["ocr"].get("fast_mode", False)
                and crop.field not in fallback_fields
            ):
                continue
            if crop.row_index in placement_hints and crop.field == "placement":
                continue
            if reading.review_required:
                variants = self._preprocessing_variants(crop, layout)
                preferred = {
                    "placement": "inverted_otsu",
                    "slot": "inner",
                    "kills": "gray_160",
                }[crop.field]
                variant = preferred if preferred in variants else next(iter(variants))
                fallback = self.engine.recognize(
                    variants[variant],
                    crop.field,
                    variant,
                )
                readings[crop_index] = choose_consensus(
                    [*attempts_by_crop[crop_index], fallback],
                    crop.field,
                    minimum_confidence=float(layout["ocr"]["minimum_confidence"]),
                    max_placement=int(layout["ocr"]["max_placement"]),
                    max_kills=int(layout["ocr"]["max_kills"]),
                    bbox=crop.bbox,
                )
        return readings

    def read(self, image_path: str | Path) -> ScoreboardResult:
        started = time.perf_counter()
        loaded = load_image(image_path)
        layout = select_layout_for_image(self.layout_path, loaded.pixels)
        normalized = normalize_image(loaded.pixels, layout)
        crops = crop_scoreboard_fields(normalized, layout)
        marker_crops = {
            crop.row_index: crop for crop in crops if crop.field == "slot_color"
        }
        slot_crops = {
            crop.row_index: crop for crop in crops if crop.field == "slot"
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
            reading = _reconcile_missing_leading_one(reading, crop)
            reading = _reconcile_repeated_one(reading, crop)
            reading = _reconcile_fixed_eighteen(reading, crop)
            reading = _reconcile_unreadable_seventeen(reading, crop)
            reading = _reconcile_three_misread_as_four(reading, crop)
            reading = _reconcile_terminal_six(reading, crop)
            reading = _reconcile_supported_numeric(reading, crop)
            reading = _reconcile_uncontested_three(reading, crop)
            reading = _reconcile_zero_kill(reading, crop, layout)
            reading = _reconcile_eight_nine(reading, crop)
            fields[crop.row_index][crop.field] = reading
        for row_index, row_fields in fields.items():
            row_fields["slot"] = _reconcile_slot_marker(
                row_fields["slot"],
                marker_crops.get(row_index),
                layout,
                slot_crops.get(row_index),
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
