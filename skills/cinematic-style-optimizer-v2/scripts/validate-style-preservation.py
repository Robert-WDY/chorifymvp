import re
from collections import Counter


def _ordered_tokens(text, patterns):
    found = []
    for pattern_name, pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.IGNORECASE):
            token = re.sub(r"\s+", "", match.group(0))
            found.append((match.start(), pattern_name, token))
    found.sort(key=lambda item: item[0])
    return [(name, token) for _, name, token in found]


def _counter_difference(original, optimized):
    original_counter = Counter(original)
    optimized_counter = Counter(optimized)
    missing = []
    added = []
    for token, count in (original_counter - optimized_counter).items():
        missing.extend([token] * count)
    for token, count in (optimized_counter - original_counter).items():
        added.extend([token] * count)
    return missing, added


def main(input: dict):
    if not isinstance(input, dict):
        raise ValueError("input must be an object")

    original_text = input.get("originalText")
    optimized_text = input.get("optimizedText")
    locked_literals = input.get("lockedLiterals", [])
    check_conflicts = input.get("checkTechnicalConflicts", True)

    if not isinstance(original_text, str) or not original_text.strip():
        raise ValueError("originalText must be a non-empty string")
    if not isinstance(optimized_text, str) or not optimized_text.strip():
        raise ValueError("optimizedText must be a non-empty string")
    if not isinstance(locked_literals, list):
        raise ValueError("lockedLiterals must be an array")
    if not isinstance(check_conflicts, bool):
        raise ValueError("checkTechnicalConflicts must be a boolean")

    normalized_locks = []
    for value in locked_literals:
        if not isinstance(value, str) or not value:
            raise ValueError("lockedLiterals must contain non-empty strings")
        normalized_locks.append(value)

    protected_patterns = [
        ("timecode", r"(?<!\d)(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?(?!\d)"),
        ("time_range", r"(?<!\d)\d+(?:\.\d+)?\s*(?:-|–|—|~|～|至)\s*\d+(?:\.\d+)?\s*(?:s|sec|秒)(?!\w)"),
        ("shot_id", r"(?:镜头|镜号|shot)\s*[#：:]?\s*[A-Za-z]?\d{1,4}"),
        ("aspect_ratio", r"(?<![\d:])(?:1\s*:\s*1|3\s*:\s*2|2\s*:\s*3|4\s*:\s*3|3\s*:\s*4|4\s*:\s*5|5\s*:\s*4|16\s*:\s*9|9\s*:\s*16|21\s*:\s*9|2\.35\s*:\s*1|2\.39\s*:\s*1)(?![\d:])"),
        ("cli_parameter", r"--[A-Za-z][\w-]*(?:\s+[^\s,;，；]+)?"),
        ("resolution", r"(?<!\d)(?:480|720|1080|1440|2160)p(?!\w)"),
    ]

    original_tokens = _ordered_tokens(original_text, protected_patterns)
    optimized_tokens = _ordered_tokens(optimized_text, protected_patterns)
    missing_tokens, added_tokens = _counter_difference(original_tokens, optimized_tokens)

    missing_literals = [value for value in normalized_locks if value not in optimized_text]
    conflict_codes = []
    conflict_messages = []

    if check_conflicts:
        lower = optimized_text.lower()
        conflict_rules = [
            (
                "mixed_capture_systems",
                ("arri" in lower or "logc" in lower) and ("s-log" in lower or "slog" in lower or "sony cinealta" in lower),
                "同时出现 ARRI/LogC 与 Sony S-Log/CineAlta 采集语言",
            ),
            (
                "mixed_lens_systems",
                ("球面" in optimized_text or "spherical" in lower) and ("变形宽银幕" in optimized_text or "anamorphic" in lower),
                "同时出现球面与变形宽银幕镜头语言",
            ),
            (
                "black_level_conflict",
                ("压死黑位" in optimized_text or "crushed blacks" in lower) and ("暗部细节完整" in optimized_text or "full shadow detail" in lower),
                "同时要求压死黑位与完整暗部细节",
            ),
            (
                "clean_vs_raw_texture",
                ("绝对干净无噪点" in optimized_text or "noise-free" in lower) and ("粗粝16mm" in optimized_text.replace(" ", "") or "raw 16mm" in lower),
                "同时要求绝对干净无噪点与粗粝 16mm 质感",
            ),
        ]
        for code, triggered, message in conflict_rules:
            if triggered:
                conflict_codes.append(code)
                conflict_messages.append(message)

    warnings = []
    if not normalized_locks:
        warnings.append("未提供 lockedLiterals；脚本只核对自动识别的结构标记")
    if len(optimized_text) > len(original_text) * 2.5 and len(original_text) > 200:
        warnings.append("优化后文本长度超过原文的 2.5 倍，请检查是否越界扩写")

    valid = not missing_literals and not missing_tokens and not added_tokens and not conflict_codes
    return {
        "valid": valid,
        "readyToDeliver": valid,
        "missingLockedLiterals": missing_literals,
        "protectedTokenDifferences": {
            "missing": [name + ":" + token for name, token in missing_tokens],
            "added": [name + ":" + token for name, token in added_tokens],
        },
        "conflicts": [
            {"code": code, "message": message}
            for code, message in zip(conflict_codes, conflict_messages)
        ],
        "warnings": warnings,
        "summary": {
            "lockedLiteralCount": len(normalized_locks),
            "protectedTokenCountOriginal": len(original_tokens),
            "protectedTokenCountOptimized": len(optimized_tokens),
        },
    }
