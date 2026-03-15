import json
from functools import lru_cache
from pathlib import Path
import sys

import cv2
import numpy as np


TARGET_MARKER_DISTANCE_MM = 140.0
TEMPLATE_PATH = Path(__file__).resolve().parent / "templates" / "marker-template.png"
MAX_COARSE_IMAGE_DIMENSION = 4000
FACE_CASCADE_PATH = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
PROFILE_FACE_CASCADE_PATH = Path(cv2.data.haarcascades) / "haarcascade_profileface.xml"
EYE_CASCADE_PATH = Path(cv2.data.haarcascades) / "haarcascade_eye_tree_eyeglasses.xml"
DETECTION_CONFIDENCE_CUTOFF = 0.55


def build_error(
    message: str,
    face_bounds: dict | None = None,
    detection_confidence: float = 0.0,
    face_detection_source: str | None = None,
) -> dict:
    return {
        "success": False,
        "calibration_status": "failed",
        "detection_confidence": float(detection_confidence),
        "left_marker_center": None,
        "right_marker_center": None,
        "rotation_angle_deg": None,
        "marker_distance_px": None,
        "px_per_mm": None,
        "mm_per_px": None,
        "face_bounds": face_bounds,
        "face_detection_source": face_detection_source,
        "candidates": [],
        "error": message,
    }


def imread_unicode(path: str, flags: int) -> np.ndarray | None:
    try:
        data = np.fromfile(path, dtype=np.uint8)
    except OSError:
        return None
    if data.size == 0:
        return None
    return cv2.imdecode(data, flags)


def load_template() -> tuple[np.ndarray, np.ndarray]:
    template_rgba = imread_unicode(str(TEMPLATE_PATH), cv2.IMREAD_UNCHANGED)
    if template_rgba is None:
        raise FileNotFoundError(f"Template not found: {TEMPLATE_PATH}")
    if template_rgba.ndim != 3 or template_rgba.shape[2] < 4:
        raise ValueError("Template must contain an alpha channel.")
    template_bgr = template_rgba[:, :, :3]
    template_gray = cv2.cvtColor(template_bgr, cv2.COLOR_BGR2GRAY)
    template_mask = template_rgba[:, :, 3]
    return template_gray, template_mask


@lru_cache(maxsize=1)
def get_template_arrays() -> tuple[np.ndarray, np.ndarray]:
    return load_template()


@lru_cache(maxsize=512)
def get_rotated_template(size: int, angle_deg: float) -> tuple[np.ndarray, np.ndarray]:
    template_gray, template_mask = get_template_arrays()
    return build_rotated_template(template_gray, template_mask, size, angle_deg)


def build_rotated_template(
    template_gray: np.ndarray,
    template_mask: np.ndarray,
    size: int,
    angle_deg: float,
) -> tuple[np.ndarray, np.ndarray]:
    resized_gray = cv2.resize(template_gray, (size, size), interpolation=cv2.INTER_AREA)
    resized_mask = cv2.resize(template_mask, (size, size), interpolation=cv2.INTER_NEAREST)
    center = (size / 2.0, size / 2.0)
    matrix = cv2.getRotationMatrix2D(center, angle_deg, 1.0)
    rotated_gray = cv2.warpAffine(
        resized_gray,
        matrix,
        (size, size),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=127,
    )
    rotated_mask = cv2.warpAffine(
        resized_mask,
        matrix,
        (size, size),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    return rotated_gray, rotated_mask


def preprocess_zone(zone_bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(zone_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 5)
    return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)


def compute_work_scale(width: int, height: int) -> float:
    longest_side = max(width, height)
    if longest_side <= MAX_COARSE_IMAGE_DIMENSION:
        return 1.0
    return MAX_COARSE_IMAGE_DIMENSION / float(longest_side)


def build_zone_bounds(width: int, height: int) -> dict[str, dict[str, int]]:
    return {
        "left": {
            "x0": int(round(width * 0.22)),
            "x1": int(round(width * 0.50)),
            "y0": int(round(height * 0.18)),
            "y1": int(round(height * 0.50)),
        },
        "right": {
            "x0": int(round(width * 0.50)),
            "x1": int(round(width * 0.78)),
            "y0": int(round(height * 0.18)),
            "y1": int(round(height * 0.50)),
        },
    }


@lru_cache(maxsize=1)
def get_face_cascade() -> cv2.CascadeClassifier | None:
    cascade = cv2.CascadeClassifier(str(FACE_CASCADE_PATH))
    if cascade.empty():
        return None
    return cascade


@lru_cache(maxsize=1)
def get_profile_face_cascade() -> cv2.CascadeClassifier | None:
    cascade = cv2.CascadeClassifier(str(PROFILE_FACE_CASCADE_PATH))
    if cascade.empty():
        return None
    return cascade


@lru_cache(maxsize=1)
def get_eye_cascade() -> cv2.CascadeClassifier | None:
    cascade = cv2.CascadeClassifier(str(EYE_CASCADE_PATH))
    if cascade.empty():
        return None
    return cascade


def is_reasonable_face_bounds(image_shape: tuple[int, int], face_bounds: tuple[int, int, int, int] | None) -> bool:
    if face_bounds is None:
        return False
    image_height, image_width = image_shape[:2]
    x, y, w, h = face_bounds
    if w <= 0 or h <= 0:
        return False
    min_dim = min(image_width, image_height)
    area_ratio = (w * h) / max(float(image_width * image_height), 1.0)
    size_ok = w >= min_dim * 0.12 and h >= min_dim * 0.12
    aspect_ok = 0.6 <= (w / max(h, 1.0)) <= 1.45
    area_ok = area_ratio >= 0.02
    top_ok = y <= image_height * 0.7
    return bool(size_ok and aspect_ok and area_ok and top_ok)


def has_eye_features(image_bgr: np.ndarray, face_bounds: tuple[int, int, int, int]) -> bool:
    eye_cascade = get_eye_cascade()
    if eye_cascade is None:
        return True
    x, y, w, h = face_bounds
    x0 = max(0, int(x))
    y0 = max(0, int(y))
    x1 = min(image_bgr.shape[1], int(x + w))
    y1 = min(image_bgr.shape[0], int(y + max(1, int(round(h * 0.62)))))
    if x1 <= x0 or y1 <= y0:
        return False
    roi = image_bgr[y0:y1, x0:x1]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    eyes = eye_cascade.detectMultiScale(
        gray,
        scaleFactor=1.08,
        minNeighbors=4,
        minSize=(max(18, int(round(w * 0.08))), max(12, int(round(h * 0.05)))),
    )
    return eyes is not None and len(eyes) >= 1


def compute_skin_ratio(image_bgr: np.ndarray, bounds: tuple[int, int, int, int]) -> float:
    x, y, w, h = bounds
    x0 = max(0, int(x))
    y0 = max(0, int(y))
    x1 = min(image_bgr.shape[1], int(x + w))
    y1 = min(image_bgr.shape[0], int(y + h))
    if x1 <= x0 or y1 <= y0:
        return 0.0
    roi = image_bgr[y0:y1, x0:x1]
    ycrcb = cv2.cvtColor(roi, cv2.COLOR_BGR2YCrCb)
    skin = cv2.inRange(ycrcb, (0, 133, 77), (255, 173, 127))
    return float(np.count_nonzero(skin)) / max(1.0, float((x1 - x0) * (y1 - y0)))


def compute_region_structure(image_bgr: np.ndarray, bounds: tuple[int, int, int, int]) -> tuple[float, float]:
    x, y, w, h = bounds
    x0 = max(0, int(x))
    y0 = max(0, int(y))
    x1 = min(image_bgr.shape[1], int(x + w))
    y1 = min(image_bgr.shape[0], int(y + h))
    if x1 <= x0 or y1 <= y0:
        return 0.0, 0.0
    gray = cv2.cvtColor(image_bgr[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    gy, gx = np.gradient(gray.astype(np.float32))
    return float(gray.std()), float(np.hypot(gx, gy).mean())


def compute_upper_face_structure(image_bgr: np.ndarray, bounds: tuple[int, int, int, int]) -> tuple[float, float]:
    x, y, w, h = bounds
    x0 = max(0, int(x))
    y0 = max(0, int(y))
    x1 = min(image_bgr.shape[1], int(x + w))
    y1 = min(image_bgr.shape[0], int(y + h))
    if x1 <= x0 or y1 <= y0:
        return 0.0, 0.0
    gray = cv2.cvtColor(image_bgr[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    upper = gray[: max(1, gray.shape[0] // 3), :]
    gy, gx = np.gradient(upper.astype(np.float32))
    return float(upper.std()), float(np.hypot(gx, gy).mean())


def has_face_like_structure(image_bgr: np.ndarray, bounds: tuple[int, int, int, int]) -> bool:
    std_value, edge_mean = compute_region_structure(image_bgr, bounds)
    return std_value >= 35.0 and edge_mean >= 2.2


def is_strong_loose_face_candidate(image_bgr: np.ndarray, image_shape: tuple[int, int], face_bounds: tuple[int, int, int, int]) -> bool:
    if not is_reasonable_face_bounds(image_shape, face_bounds):
        return False
    image_height, image_width = image_shape[:2]
    x, y, w, h = face_bounds
    skin_ratio = compute_skin_ratio(image_bgr, face_bounds)
    std_value, edge_mean = compute_region_structure(image_bgr, face_bounds)
    upper_std, upper_edge = compute_upper_face_structure(image_bgr, face_bounds)
    center_x = x + (w * 0.5)
    center_offset = abs(center_x - (image_width * 0.5)) / max(image_width, 1.0)
    return bool(
        0.30 <= skin_ratio <= 0.90
        and std_value >= 50.0
        and edge_mean >= 4.5
        and upper_std >= 35.0
        and upper_edge >= 4.5
        and y <= image_height * 0.50
        and center_offset <= 0.16
    )


def is_soft_upper_face_candidate(
    image_bgr: np.ndarray,
    image_shape: tuple[int, int],
    face_bounds: tuple[int, int, int, int],
) -> bool:
    if not is_reasonable_face_bounds(image_shape, face_bounds):
        return False
    image_height, image_width = image_shape[:2]
    x, y, w, h = face_bounds
    skin_ratio = compute_skin_ratio(image_bgr, face_bounds)
    std_value, edge_mean = compute_region_structure(image_bgr, face_bounds)
    upper_std, upper_edge = compute_upper_face_structure(image_bgr, face_bounds)
    center_x = x + (w * 0.5)
    center_offset = abs(center_x - (image_width * 0.5)) / max(image_width, 1.0)
    area_ratio = (w * h) / max(float(image_width * image_height), 1.0)
    return bool(
        0.22 <= skin_ratio <= 0.90
        and 0.028 <= area_ratio <= 0.22
        and std_value >= 38.0
        and edge_mean >= 5.0
        and upper_std >= 32.0
        and upper_edge >= 4.6
        and y <= image_height * 0.52
        and center_offset <= 0.14
    )


def is_far_portrait_face_candidate(
    image_bgr: np.ndarray,
    image_shape: tuple[int, int],
    face_bounds: tuple[int, int, int, int],
) -> bool:
    if not is_reasonable_face_bounds(image_shape, face_bounds):
        return False
    image_height, image_width = image_shape[:2]
    x, y, w, h = face_bounds
    skin_ratio = compute_skin_ratio(image_bgr, face_bounds)
    std_value, edge_mean = compute_region_structure(image_bgr, face_bounds)
    upper_std, upper_edge = compute_upper_face_structure(image_bgr, face_bounds)
    center_x = x + (w * 0.5)
    center_offset = abs(center_x - (image_width * 0.5)) / max(image_width, 1.0)
    area_ratio = (w * h) / max(float(image_width * image_height), 1.0)
    return bool(
        0.80 <= skin_ratio <= 0.96
        and 0.018 <= area_ratio <= 0.05
        and std_value >= 30.0
        and edge_mean >= 4.6
        and upper_std >= 28.0
        and upper_edge >= 4.4
        and y <= image_height * 0.40
        and center_offset <= 0.09
    )


def select_best_face_candidate(
    image_shape: tuple[int, int],
    candidates: list[tuple[int, int, int, int]],
) -> tuple[int, int, int, int] | None:
    if not candidates:
        return None
    image_height, image_width = image_shape[:2]

    def score(face: tuple[int, int, int, int]) -> float:
        x, y, w, h = face
        area = float(w * h)
        center_x = x + (w * 0.5)
        center_offset = abs(center_x - (image_width * 0.5)) / max(image_width, 1.0)
        top_ratio = y / max(image_height, 1.0)
        upper_bonus = max(0.0, 1.0 - (top_ratio / 0.38))
        center_bonus = max(0.0, 1.0 - (center_offset / 0.18))
        return area * (1.0 + (upper_bonus * 0.35) + (center_bonus * 0.15))

    return max(candidates, key=score)


def is_reasonable_portrait_face_candidate(
    image_shape: tuple[int, int],
    face_bounds: tuple[int, int, int, int] | None,
) -> bool:
    if face_bounds is None:
        return False
    image_height, image_width = image_shape[:2]
    x, y, w, h = face_bounds
    if w <= 0 or h <= 0:
        return False
    area_ratio = (w * h) / max(float(image_width * image_height), 1.0)
    aspect = w / max(h, 1.0)
    center_x = x + (w * 0.5)
    center_offset = abs(center_x - (image_width * 0.5)) / max(image_width, 1.0)
    return bool(
        0.035 <= area_ratio <= 0.22
        and 0.7 <= aspect <= 1.3
        and y <= image_height * 0.38
        and center_offset <= 0.16
    )


def detect_portrait_face_bounds(image_bgr: np.ndarray) -> tuple[int, int, int, int] | None:
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    frontal = get_face_cascade()
    if frontal is None:
        return None
    faces = frontal.detectMultiScale(
        gray,
        scaleFactor=1.04,
        minNeighbors=3,
        minSize=(80, 80),
    )
    candidates = []
    if faces is not None:
        for face in faces:
            face_tuple = tuple(int(v) for v in face)
            skin_ratio = compute_skin_ratio(image_bgr, face_tuple)
            if (
                is_reasonable_portrait_face_candidate(gray.shape, face_tuple)
                and 0.10 <= skin_ratio <= 0.90
                and has_face_like_structure(image_bgr, face_tuple)
            ):
                candidates.append(face_tuple)
    return select_best_face_candidate(gray.shape, candidates)


def detect_loose_upper_face_bounds(image_bgr: np.ndarray) -> tuple[int, int, int, int] | None:
    frontal = get_face_cascade()
    if frontal is None:
        return None
    image_height, image_width = image_bgr.shape[:2]
    x0 = max(0, int(round(image_width * 0.22)))
    x1 = min(image_width, int(round(image_width * 0.78)))
    y0 = max(0, int(round(image_height * 0.05)))
    y1 = min(image_height, int(round(image_height * 0.58)))
    if x1 <= x0 or y1 <= y0:
        return None
    roi = image_bgr[y0:y1, x0:x1]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    faces = frontal.detectMultiScale(
        gray,
        scaleFactor=1.02,
        minNeighbors=1,
        minSize=(80, 80),
    )
    candidates: list[tuple[int, int, int, int]] = []
    if faces is not None:
        for face in faces:
            fx, fy, fw, fh = (int(v) for v in face)
            face_tuple = (x0 + fx, y0 + fy, fw, fh)
            if is_strong_loose_face_candidate(image_bgr, image_bgr.shape[:2], face_tuple):
                candidates.append(face_tuple)
    return select_best_face_candidate(image_bgr.shape[:2], candidates)


def detect_soft_upper_face_bounds(image_bgr: np.ndarray) -> tuple[int, int, int, int] | None:
    frontal = get_face_cascade()
    if frontal is None:
        return None
    image_height, image_width = image_bgr.shape[:2]
    x0 = max(0, int(round(image_width * 0.20)))
    x1 = min(image_width, int(round(image_width * 0.80)))
    y0 = max(0, int(round(image_height * 0.04)))
    y1 = min(image_height, int(round(image_height * 0.62)))
    if x1 <= x0 or y1 <= y0:
        return None
    roi = image_bgr[y0:y1, x0:x1]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    faces = frontal.detectMultiScale(
        gray,
        scaleFactor=1.03,
        minNeighbors=1,
        minSize=(96, 96),
    )
    candidates: list[tuple[int, int, int, int]] = []
    if faces is not None:
        for face in faces:
            fx, fy, fw, fh = (int(v) for v in face)
            face_tuple = (x0 + fx, y0 + fy, fw, fh)
            if is_soft_upper_face_candidate(image_bgr, image_bgr.shape[:2], face_tuple):
                candidates.append(face_tuple)
    return select_best_face_candidate(image_bgr.shape[:2], candidates)


def detect_far_portrait_face_bounds(image_bgr: np.ndarray) -> tuple[int, int, int, int] | None:
    frontal = get_face_cascade()
    if frontal is None:
        return None
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    faces = frontal.detectMultiScale(
        gray,
        scaleFactor=1.02,
        minNeighbors=1,
        minSize=(64, 64),
    )
    candidates: list[tuple[int, int, int, int]] = []
    if faces is not None:
        for face in faces:
            face_tuple = tuple(int(v) for v in face)
            if is_far_portrait_face_candidate(image_bgr, image_bgr.shape[:2], face_tuple):
                candidates.append(face_tuple)
    return select_best_face_candidate(image_bgr.shape[:2], candidates)


def detect_face_bounds(image_bgr: np.ndarray) -> tuple[int, int, int, int] | None:
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    detection_passes = (
        {"scaleFactor": 1.08, "minNeighbors": 5, "minSize": (120, 120)},
        {"scaleFactor": 1.06, "minNeighbors": 4, "minSize": (96, 96)},
        {"scaleFactor": 1.04, "minNeighbors": 3, "minSize": (80, 80)},
    )
    candidates: list[tuple[int, int, int, int]] = []
    soft_candidates: list[tuple[int, int, int, int]] = []

    frontal = get_face_cascade()
    if frontal is not None:
        for params in detection_passes:
            faces = frontal.detectMultiScale(gray, **params)
            if faces is None:
                continue
            for face in faces:
                face_tuple = tuple(int(v) for v in face)
                skin_ratio = compute_skin_ratio(image_bgr, face_tuple)
                if (
                    is_reasonable_face_bounds(gray.shape, face_tuple)
                    and 0.05 <= skin_ratio <= 0.90
                    and has_eye_features(image_bgr, face_tuple)
                    and has_face_like_structure(image_bgr, face_tuple)
                ):
                    candidates.append(face_tuple)
                elif is_soft_upper_face_candidate(image_bgr, gray.shape, face_tuple):
                    soft_candidates.append(face_tuple)
            if candidates:
                break

    profile = get_profile_face_cascade()
    if profile is not None and not candidates:
        flips = (gray, cv2.flip(gray, 1))
        for flipped_index, gray_variant in enumerate(flips):
            for params in detection_passes:
                faces = profile.detectMultiScale(gray_variant, **params)
                if faces is None:
                    continue
                for face in faces:
                    x, y, w, h = (int(v) for v in face)
                    if flipped_index == 1:
                        x = gray.shape[1] - x - w
                    face_tuple = (x, y, w, h)
                    skin_ratio = compute_skin_ratio(image_bgr, face_tuple)
                    if (
                        is_reasonable_face_bounds(gray.shape, face_tuple)
                        and 0.05 <= skin_ratio <= 0.90
                        and has_eye_features(image_bgr, face_tuple)
                        and has_face_like_structure(image_bgr, face_tuple)
                    ):
                        candidates.append(face_tuple)
                    elif is_soft_upper_face_candidate(image_bgr, gray.shape, face_tuple):
                        soft_candidates.append(face_tuple)
                if candidates:
                    break
            if candidates:
                break

    if not candidates:
        loose_face = detect_loose_upper_face_bounds(image_bgr)
        if loose_face is not None:
            candidates.append(loose_face)

    if not candidates:
        soft_face = detect_soft_upper_face_bounds(image_bgr)
        if soft_face is not None:
            candidates.append(soft_face)

    if not candidates and not soft_candidates and frontal is not None:
        permissive_faces = frontal.detectMultiScale(
            gray,
            scaleFactor=1.02,
            minNeighbors=1,
            minSize=(64, 64),
        )
        if permissive_faces is not None:
            for face in permissive_faces:
                face_tuple = tuple(int(v) for v in face)
                if is_soft_upper_face_candidate(image_bgr, gray.shape, face_tuple):
                    soft_candidates.append(face_tuple)

    if not candidates and not soft_candidates:
        far_portrait_face = detect_far_portrait_face_bounds(image_bgr)
        if far_portrait_face is not None:
            soft_candidates.append(far_portrait_face)

    if not candidates and soft_candidates:
        candidates.extend(soft_candidates)

    return select_best_face_candidate(gray.shape, candidates)


def detect_head_bounds(image_bgr: np.ndarray) -> tuple[int, int, int, int] | None:
    image_height, image_width = image_bgr.shape[:2]
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (9, 9), 0)
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if np.mean(thresh) > 127:
        thresh = cv2.bitwise_not(thresh)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21))
    mask = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    best = None
    image_center_x = image_width * 0.5
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = w * h
        if area < image_width * image_height * 0.05:
            continue
        if y > image_height * 0.55:
            continue
        aspect = w / max(h, 1.0)
        if aspect < 0.45 or aspect > 1.6:
            continue
        center_x = x + (w * 0.5)
        center_penalty = abs(center_x - image_center_x) / max(image_width, 1.0)
        score = area - (center_penalty * area * 0.6)
        if best is None or score > best[0]:
            best = (score, (x, y, w, h))
    if best is None:
        return None
    x, y, w, h = best[1]
    area_ratio = (w * h) / max(float(image_width * image_height), 1.0)
    if area_ratio < 0.08 or area_ratio > 0.42:
        return None
    if w >= image_width * 0.78 or h >= image_height * 0.88:
        return None
    touches_edges = int(x <= image_width * 0.02) + int(y <= image_height * 0.02) + int((x + w) >= image_width * 0.98) + int((y + h) >= image_height * 0.98)
    if touches_edges >= 2:
        return None
    pad_x = int(round(w * 0.08))
    pad_y = int(round(h * 0.08))
    x0 = max(0, x - pad_x)
    y0 = max(0, y - pad_y)
    x1 = min(image_width, x + w + pad_x)
    y1 = min(image_height, y + h + pad_y)
    candidate = (x0, y0, max(0, x1 - x0), max(0, y1 - y0))
    cx, cy, cw, ch = candidate
    if cw >= image_width * 0.78 or ch >= image_height * 0.88:
        return None
    candidate_touches_edges = int(cx <= image_width * 0.02) + int(cy <= image_height * 0.02) + int((cx + cw) >= image_width * 0.98) + int((cy + ch) >= image_height * 0.98)
    if candidate_touches_edges >= 2:
        return None
    skin_ratio = compute_skin_ratio(image_bgr, candidate)
    if skin_ratio < 0.08 or skin_ratio > 0.75:
        return None
    return candidate


def detect_face_bounds_in_roi(
    image_bgr: np.ndarray,
    roi_bounds: tuple[int, int, int, int] | None,
) -> tuple[int, int, int, int] | None:
    if roi_bounds is None:
        return None
    x, y, w, h = roi_bounds
    if w <= 0 or h <= 0:
        return None
    x0 = max(0, int(x))
    y0 = max(0, int(y))
    x1 = min(image_bgr.shape[1], int(x + w))
    y1 = min(image_bgr.shape[0], int(y + h))
    if x1 <= x0 or y1 <= y0:
        return None
    roi = image_bgr[y0:y1, x0:x1]
    local_face = detect_face_bounds(roi)
    if local_face is None:
        return None
    return (
        x0 + int(local_face[0]),
        y0 + int(local_face[1]),
        int(local_face[2]),
        int(local_face[3]),
    )


def build_marker_guided_face_roi(
    image_width: int,
    image_height: int,
    left_x: float,
    left_y: float,
    right_x: float,
    right_y: float,
) -> tuple[int, int, int, int]:
    marker_distance = max(1.0, float(np.hypot(right_x - left_x, right_y - left_y)))
    center_x = (left_x + right_x) * 0.5
    center_y = (left_y + right_y) * 0.5
    roi_width = marker_distance * 1.45
    roi_height = marker_distance * 1.55
    x0 = max(0, int(round(center_x - (roi_width * 0.5))))
    y0 = max(0, int(round(center_y - (roi_height * 0.9))))
    x1 = min(image_width, int(round(center_x + (roi_width * 0.5))))
    y1 = min(image_height, int(round(center_y + (roi_height * 0.65))))
    return (x0, y0, max(0, x1 - x0), max(0, y1 - y0))


def is_face_consistent_with_markers(
    face_bounds: tuple[int, int, int, int] | None,
    left_x: float,
    left_y: float,
    right_x: float,
    right_y: float,
) -> bool:
    if face_bounds is None:
        return False
    x, y, w, h = face_bounds
    if w <= 0 or h <= 0:
        return False
    marker_distance = max(1.0, float(np.hypot(right_x - left_x, right_y - left_y)))
    marker_avg_y = (left_y + right_y) * 0.5
    face_center_x = x + (w * 0.5)
    face_center_y = y + (h * 0.5)
    horizontal_ok = (left_x - (w * 0.22)) <= face_center_x <= (right_x + (w * 0.22))
    marker_band_ok = (y + (h * 0.08)) <= marker_avg_y <= (y + (h * 0.62))
    center_y_ok = abs(face_center_y - marker_avg_y) <= max(h * 0.42, marker_distance * 0.42)
    width_ok = abs(w - marker_distance) <= marker_distance * 0.65
    return bool(horizontal_ok and marker_band_ok and center_y_ok and width_ok)


def normalize_face_bounds_from_markers(
    image_width: int,
    image_height: int,
    face_bounds: tuple[int, int, int, int] | None,
    left_x: float,
    left_y: float,
    right_x: float,
    right_y: float,
) -> tuple[int, int, int, int]:
    marker_distance = max(1.0, float(np.hypot(right_x - left_x, right_y - left_y)))
    marker_center_x = (left_x + right_x) * 0.5
    marker_center_y = (left_y + right_y) * 0.5

    min_width = marker_distance * 0.80
    max_width = marker_distance * 1.20
    width = max_width
    height = marker_distance * 1.35

    if face_bounds is not None:
        _, _, w, h = face_bounds
        width = float(np.clip(float(w), min_width, max_width))
        height = max(height, float(h), width)
    else:
        width = max_width

    width = min(width, image_width * 0.92)
    height = min(max(height, width), min(image_height * 0.92, width * 1.5))
    x0 = max(0, int(round(marker_center_x - (width * 0.5))))
    y0 = max(0, int(round(marker_center_y - (height * 0.5))))
    x1 = min(image_width, int(round(marker_center_x + (width * 0.5))))
    y1 = min(image_height, int(round(y0 + height)))
    if y1 <= y0:
        y1 = min(image_height, y0 + int(round(height)))
    return (x0, y0, max(0, x1 - x0), max(0, y1 - y0))


def derive_display_face_bounds_from_head(
    image_width: int,
    image_height: int,
    head_bounds: tuple[int, int, int, int] | None,
) -> tuple[int, int, int, int] | None:
    if head_bounds is None:
        return None
    x, y, w, h = head_bounds
    if w <= 0 or h <= 0:
        return None
    face_width = min(w * 0.46, h * 0.56)
    face_height = min(face_width * 1.18, h * 0.72)
    center_x = x + (w * 0.5)
    center_y = y + (h * 0.28)
    x0 = max(0, int(round(center_x - (face_width * 0.5))))
    y0 = max(0, int(round(center_y - (face_height * 0.42))))
    x1 = min(image_width, int(round(x0 + face_width)))
    y1 = min(image_height, int(round(y0 + face_height)))
    return (x0, y0, max(0, x1 - x0), max(0, y1 - y0))


def correct_face_bounds_with_head(
    image_width: int,
    image_height: int,
    face_bounds: tuple[int, int, int, int] | None,
    head_bounds: tuple[int, int, int, int] | None,
) -> tuple[int, int, int, int] | None:
    if face_bounds is None:
        return None
    if head_bounds is None:
        return face_bounds
    head_display = derive_display_face_bounds_from_head(image_width, image_height, head_bounds)
    if head_display is None:
        return face_bounds
    fx, fy, fw, fh = face_bounds
    _, hy, _, hh = head_display
    face_top_ratio = fy / max(float(image_height), 1.0)
    face_bottom = fy + fh
    head_display_bottom = hy + hh
    face_is_too_low = (
        face_top_ratio >= 0.34
        and fy > hy + (hh * 0.16)
        and face_bottom > head_display_bottom + (hh * 0.08)
    )
    if face_is_too_low:
        return head_display
    return face_bounds


def build_face_guided_zone_bounds(width: int, height: int, face_bounds: tuple[int, int, int, int] | None) -> dict[str, dict[str, int]] | None:
    if face_bounds is None:
        return None
    x, y, w, h = face_bounds
    center_x = x + (w * 0.5)
    eye_y = y + (h * 0.43)
    band_half_height = h * 0.18
    marker_half_width = w * 0.42
    horizontal_gap = w * 0.10
    y0 = max(0, int(round(eye_y - band_half_height)))
    y1 = min(height, int(round(eye_y + band_half_height)))
    left_x0 = max(0, int(round(center_x - horizontal_gap - (marker_half_width * 2.0))))
    left_x1 = min(width, int(round(center_x - horizontal_gap)))
    right_x0 = max(0, int(round(center_x + horizontal_gap)))
    right_x1 = min(width, int(round(center_x + horizontal_gap + (marker_half_width * 2.0))))
    if left_x1 <= left_x0 or right_x1 <= right_x0 or y1 <= y0:
        return None
    return {
        "left": {"x0": left_x0, "x1": left_x1, "y0": y0, "y1": y1},
        "right": {"x0": right_x0, "x1": right_x1, "y0": y0, "y1": y1},
    }


def match_marker_in_roi(
    roi_gray: np.ndarray,
    size_options: tuple[int, ...],
    angle_options: tuple[int, ...],
) -> tuple[float, float, float, float, int, float] | None:
    candidates = match_marker_candidates_in_roi(roi_gray, size_options, angle_options, 2)
    if not candidates:
        return None
    best_match = candidates[0]
    second_best_score = candidates[1][0] if len(candidates) > 1 else -1.0
    return (*best_match, max(0.0, float(best_match[0] - second_best_score)))


def match_marker_candidates_in_roi(
    roi_gray: np.ndarray,
    size_options: tuple[int, ...],
    angle_options: tuple[int, ...],
    limit: int = 3,
) -> list[tuple[float, float, float, float, int]]:
    raw_candidates: list[tuple[float, float, float, float, int]] = []
    for size in size_options:
        if roi_gray.shape[0] < size or roi_gray.shape[1] < size:
            continue
        for angle in angle_options:
            template, mask = get_rotated_template(size, angle)
            result = cv2.matchTemplate(roi_gray, template, cv2.TM_CCORR_NORMED, mask=mask)
            _, max_value, _, max_location = cv2.minMaxLoc(result)
            raw_candidates.append(
                (
                    float(max_value),
                    float(max_location[0] + size / 2.0),
                    float(max_location[1] + size / 2.0),
                    float(size / 2.0),
                    int(angle),
                )
            )
    raw_candidates.sort(key=lambda item: item[0], reverse=True)
    selected: list[tuple[float, float, float, float, int]] = []
    for candidate in raw_candidates:
        _, cand_x, cand_y, cand_radius, _ = candidate
        too_close = False
        for existing in selected:
            _, exist_x, exist_y, exist_radius, _ = existing
            distance = float(np.hypot(cand_x - exist_x, cand_y - exist_y))
            if distance < max(cand_radius, exist_radius) * 1.1:
                too_close = True
                break
        if too_close:
            continue
        selected.append(candidate)
        if len(selected) >= limit:
            break
    return selected


def detect_markers(image_path: str) -> dict:
    get_template_arrays()
    image = imread_unicode(image_path, cv2.IMREAD_COLOR)
    if image is None:
        return build_error("Could not load image.")

    source_height, source_width = image.shape[:2]
    work_scale = compute_work_scale(source_width, source_height)
    if work_scale < 1.0:
        work_width = max(1, int(round(source_width * work_scale)))
        work_height = max(1, int(round(source_height * work_scale)))
        work_image = cv2.resize(image, (work_width, work_height), interpolation=cv2.INTER_AREA)
    else:
        work_image = image
        work_height, work_width = source_height, source_width

    def detect_from_zones(work_zones: dict[str, dict[str, int]], source_zones: dict[str, dict[str, int]]) -> tuple[dict[str, np.ndarray], dict[str, dict[str, float]]] | None:
        selected_local = {}
        scores_local = {}
        coarse_candidates_by_side = {}
        for side, work_zone in work_zones.items():
            source_zone = source_zones[side]
            zone_bgr = work_image[work_zone["y0"]:work_zone["y1"], work_zone["x0"]:work_zone["x1"]]
            if zone_bgr.size == 0 or source_zone["x1"] <= source_zone["x0"] or source_zone["y1"] <= source_zone["y0"]:
                return None
            zone_gray = preprocess_zone(zone_bgr)
            coarse_candidates = match_marker_candidates_in_roi(zone_gray, (46, 52, 58, 64, 70), tuple(range(0, 180, 15)), 5)
            if not coarse_candidates:
                return None
            coarse_candidates_by_side[side] = [
                (
                    score,
                    (center_x + work_zone["x0"]) / work_scale,
                    (center_y + work_zone["y0"]) / work_scale,
                    radius / work_scale,
                    angle,
                )
                for score, center_x, center_y, radius, angle in coarse_candidates
            ]

        best_coarse_pair = None
        for left_candidate in coarse_candidates_by_side["left"]:
            for right_candidate in coarse_candidates_by_side["right"]:
                left_score, left_x, left_y, left_radius, left_angle = left_candidate
                right_score, right_x, right_y, right_radius, right_angle = right_candidate
                dx = right_x - left_x
                dy = right_y - left_y
                horizontal_span = abs(dx) / max(source_width, 1.0)
                vertical_offset = abs(dy) / max((left_radius + right_radius) * 0.5, 1.0)
                radius_similarity = 1.0 - abs(left_radius - right_radius) / max(max(left_radius, right_radius), 1.0)
                pair_span_confidence = float(np.clip((horizontal_span - 0.08) / 0.10, 0.0, 1.0))
                pair_level_confidence = float(np.clip(1.0 - (vertical_offset / 1.8), 0.0, 1.0))
                pair_score = (
                    min(left_score, right_score) * 0.55
                    + radius_similarity * 0.20
                    + pair_span_confidence * 0.15
                    + pair_level_confidence * 0.10
                )
                if best_coarse_pair is None or pair_score > best_coarse_pair[0]:
                    best_coarse_pair = (
                        pair_score,
                        {"score": left_score, "x": left_x, "y": left_y, "radius": left_radius, "angle": left_angle},
                        {"score": right_score, "x": right_x, "y": right_y, "radius": right_radius, "angle": right_angle},
                    )

        if best_coarse_pair is None:
            return None

        _, chosen_left, chosen_right = best_coarse_pair

        for side, coarse_data in (("left", chosen_left), ("right", chosen_right)):
            coarse_score = float(coarse_data["score"])
            center_x_source = float(coarse_data["x"])
            center_y_source = float(coarse_data["y"])
            radius_source = float(coarse_data["radius"])
            coarse_angle = int(coarse_data["angle"])
            source_zone = source_zones[side]
            refine_half = int(max(150.0, radius_source * 2.0))
            rx0 = max(source_zone["x0"], int(round(center_x_source - refine_half)))
            ry0 = max(source_zone["y0"], int(round(center_y_source - refine_half)))
            rx1 = min(source_zone["x1"], int(round(center_x_source + refine_half)))
            ry1 = min(source_zone["y1"], int(round(center_y_source + refine_half)))
            refine_bgr = image[ry0:ry1, rx0:rx1]
            if refine_bgr.size == 0:
                return None
            refine_gray = preprocess_zone(refine_bgr)
            angle_candidates = tuple(sorted({(coarse_angle + delta) % 180 for delta in (-10, -5, 0, 5, 10)}))
            refine_sizes = tuple(
                sorted(
                    {
                        max(84, int(round(radius_source * scale)))
                        for scale in (1.8, 1.9, 2.0, 2.1)
                    }
                )
            )
            refine_match = match_marker_in_roi(refine_gray, refine_sizes, angle_candidates)
            if refine_match is None:
                return None
            match_score, center_x, center_y, radius, _, score_margin = refine_match
            selected_local[side] = np.array(
                [center_x + rx0, center_y + ry0, radius],
                dtype=np.float32,
            )
            scores_local[side] = {
                "match": max(match_score, coarse_score),
                "margin": score_margin,
            }
        return selected_local, scores_local

    def summarize_detection(selected: dict[str, np.ndarray], scores: dict[str, dict[str, float]]) -> dict:
        left = selected["left"]
        right = selected["right"]
        left_x = float(left[0])
        left_y = float(left[1])
        right_x = float(right[0])
        right_y = float(right[1])
        left_radius = float(left[2])
        right_radius = float(right[2])
        dx = right_x - left_x
        dy = right_y - left_y
        marker_distance_px = float(np.hypot(dx, dy))
        radius_similarity = 1.0 - abs(left_radius - right_radius) / max(max(left_radius, right_radius), 1.0)
        template_confidence = min(scores["left"]["match"], scores["right"]["match"])
        margin_confidence = min(scores["left"]["margin"], scores["right"]["margin"])
        horizontal_span = abs(dx) / max(source_width, 1.0)
        vertical_offset = abs(dy) / max((left_radius + right_radius) * 0.5, 1.0)
        pair_span_confidence = float(np.clip((horizontal_span - 0.08) / 0.10, 0.0, 1.0))
        pair_level_confidence = float(np.clip(1.0 - (vertical_offset / 1.5), 0.0, 1.0))
        required_margin = 0.010
        if (
            template_confidence >= 0.94
            and radius_similarity >= 0.95
            and pair_span_confidence >= 0.45
            and pair_level_confidence >= 0.70
        ):
            required_margin = 0.0023
        detection_confidence = float(
            np.clip(
                template_confidence * 0.55
                + radius_similarity * 0.20
                + min(margin_confidence, 0.02) * 3.0
                + pair_span_confidence * 0.10
                + pair_level_confidence * 0.15,
                0.0,
                1.0,
            )
        )
        strong_pair_override = (
            template_confidence >= 0.75
            and radius_similarity >= 0.82
            and pair_span_confidence >= 0.60
            and pair_level_confidence >= 0.50
            and margin_confidence >= 0.004
            and detection_confidence >= 0.81
        )
        rejected = bool(
            (template_confidence < 0.90 and not strong_pair_override)
            or radius_similarity < 0.80
            or pair_span_confidence < 0.20
            or pair_level_confidence < 0.10
            or detection_confidence < 0.80
            or (margin_confidence < required_margin and detection_confidence < 0.84 and not strong_pair_override)
        )
        return {
            "selected": selected,
            "scores": scores,
            "left_x": left_x,
            "left_y": left_y,
            "right_x": right_x,
            "right_y": right_y,
            "left_radius": left_radius,
            "right_radius": right_radius,
            "dx": dx,
            "dy": dy,
            "marker_distance_px": marker_distance_px,
            "radius_similarity": radius_similarity,
            "template_confidence": template_confidence,
            "margin_confidence": margin_confidence,
            "pair_span_confidence": pair_span_confidence,
            "pair_level_confidence": pair_level_confidence,
            "detection_confidence": detection_confidence,
            "rejected": rejected,
        }

    work_zones = build_zone_bounds(work_width, work_height)
    source_zones = build_zone_bounds(source_width, source_height)
    face_bounds = detect_face_bounds(work_image)
    face_detection_source = "face" if face_bounds is not None else None
    display_face_bounds = face_bounds
    head_bounds = None
    if face_bounds is None:
        face_bounds = detect_portrait_face_bounds(work_image)
        if face_bounds is not None:
            face_detection_source = "portrait"
            display_face_bounds = face_bounds
    had_initial_face_context = face_bounds is not None
    if face_bounds is None:
        head_bounds = detect_head_bounds(work_image)
        face_bounds = head_bounds
        if head_bounds is not None:
            face_detection_source = "head"
            display_face_bounds = derive_display_face_bounds_from_head(work_width, work_height, head_bounds)
        had_initial_face_context = face_bounds is not None
    else:
        head_bounds = detect_head_bounds(work_image)
        corrected_face_bounds = correct_face_bounds_with_head(work_width, work_height, face_bounds, head_bounds)
        if corrected_face_bounds is not None:
            was_adjusted = corrected_face_bounds != face_bounds
            face_bounds = corrected_face_bounds
            display_face_bounds = corrected_face_bounds
            if face_detection_source == "face" and was_adjusted:
                face_detection_source = "portrait"
    detection = detect_from_zones(work_zones, source_zones)
    face_work_zones = build_face_guided_zone_bounds(work_width, work_height, face_bounds)
    face_source_zones = None
    if face_work_zones and face_bounds is not None:
        face_source_bounds = (
            int(round(face_bounds[0] / work_scale)),
            int(round(face_bounds[1] / work_scale)),
            int(round(face_bounds[2] / work_scale)),
            int(round(face_bounds[3] / work_scale)),
        )
        face_source_zones = build_face_guided_zone_bounds(source_width, source_height, face_source_bounds)
    generic_summary = summarize_detection(*detection) if detection is not None else None
    face_guided_detection = None
    face_guided_summary = None
    if face_work_zones and face_source_zones:
        should_try_face_guided = detection is None
        if generic_summary is not None:
            generic_face_ok = is_face_consistent_with_markers(
                face_bounds,
                generic_summary["left_x"] * work_scale,
                generic_summary["left_y"] * work_scale,
                generic_summary["right_x"] * work_scale,
                generic_summary["right_y"] * work_scale,
            )
            should_try_face_guided = should_try_face_guided or generic_summary["rejected"] or not generic_face_ok
        if should_try_face_guided:
            face_guided_detection = detect_from_zones(face_work_zones, face_source_zones)
            if face_guided_detection is not None:
                face_guided_summary = summarize_detection(*face_guided_detection)
                if (
                    generic_summary is None
                    or generic_summary["rejected"]
                    or face_guided_summary["detection_confidence"] > generic_summary["detection_confidence"]
                ):
                    detection = face_guided_detection
                    generic_summary = face_guided_summary
    normalized_face_bounds = None
    output_face_bounds = display_face_bounds if face_detection_source == "head" else face_bounds
    if output_face_bounds is not None:
        normalized_face_bounds = {
            "x": float(output_face_bounds[0] / work_scale),
            "y": float(output_face_bounds[1] / work_scale),
            "width": float(output_face_bounds[2] / work_scale),
            "height": float(output_face_bounds[3] / work_scale),
        }
    if detection is None:
        if normalized_face_bounds is None:
            return build_error("No face detected.")
        return build_error("OpenCV marker matching was too uncertain.", normalized_face_bounds, 0.0, face_detection_source)

    selected, scores = detection
    final_summary = summarize_detection(selected, scores)

    left = selected["left"]
    right = selected["right"]
    left_x = final_summary["left_x"]
    left_y = final_summary["left_y"]
    right_x = final_summary["right_x"]
    right_y = final_summary["right_y"]

    dx = final_summary["dx"]
    dy = final_summary["dy"]
    marker_distance_px = final_summary["marker_distance_px"]
    detection_confidence = final_summary["detection_confidence"]

    if normalized_face_bounds is None:
        return build_error("No face detected.")

    if final_summary["rejected"]:
        return build_error("OpenCV marker matching was too uncertain.", normalized_face_bounds, detection_confidence, face_detection_source)

    if had_initial_face_context and not is_face_consistent_with_markers(face_bounds, left_x * work_scale, left_y * work_scale, right_x * work_scale, right_y * work_scale):
        marker_guided_face = detect_face_bounds_in_roi(
            work_image,
            build_marker_guided_face_roi(
                work_width,
                work_height,
                left_x * work_scale,
                left_y * work_scale,
                right_x * work_scale,
                right_y * work_scale,
            ),
        )
        if is_face_consistent_with_markers(marker_guided_face, left_x * work_scale, left_y * work_scale, right_x * work_scale, right_y * work_scale):
            face_bounds = marker_guided_face

    face_bounds = normalize_face_bounds_from_markers(
        work_width,
        work_height,
        face_bounds,
        left_x * work_scale,
        left_y * work_scale,
        right_x * work_scale,
        right_y * work_scale,
    )

    normalized_face_bounds = None
    if face_bounds is not None:
        normalized_face_bounds = {
            "x": float(face_bounds[0] / work_scale),
            "y": float(face_bounds[1] / work_scale),
            "width": float(face_bounds[2] / work_scale),
            "height": float(face_bounds[3] / work_scale),
        }

    return {
        "success": True,
        "calibration_status": "success",
        "detection_confidence": detection_confidence,
        "left_marker_center": {"x": left_x, "y": left_y},
        "right_marker_center": {"x": right_x, "y": right_y},
        "rotation_angle_deg": float(-np.degrees(np.arctan2(dy, dx))),
        "marker_distance_px": marker_distance_px,
        "px_per_mm": marker_distance_px / TARGET_MARKER_DISTANCE_MM,
        "mm_per_px": TARGET_MARKER_DISTANCE_MM / max(marker_distance_px, 1e-6),
        "face_bounds": normalized_face_bounds,
        "face_detection_source": face_detection_source,
        "candidates": [
            {
                "center": {"x": float(circle[0]), "y": float(circle[1])},
                "radius": float(circle[2]),
                "score": float(score["match"]),
            }
            for circle, score in ((left, scores["left"]), (right, scores["right"]))
        ],
        "error": None,
    }


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps(build_error("Image path argument missing.")))
        return 1
    try:
        result = detect_markers(sys.argv[1])
    except Exception as exc:
        result = build_error(f"OpenCV marker detection failed: {exc}")
        print(json.dumps(result))
        return 1
    print(json.dumps(result))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
