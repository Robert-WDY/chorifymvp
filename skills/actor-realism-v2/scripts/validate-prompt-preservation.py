import re
from collections import Counter


def _extract_tokens(text):
    patterns = [
        ("timecode", r"(?<!\d)(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?(?!\d)"),
        ("time_range", r"(?<!\d)\d+(?:\.\d+)?\s*(?:-|–|—|~|～|至)\s*\d+(?:\.\d+)?\s*(?:s|sec|秒)(?!\w)"),
        ("shot_id", r"(?:镜头|镜号|shot)\s*[#：:]?\s*[A-Za-z]?\d{1,4}"),
        ("aspect_ratio", r"(?<![\d:])(?:1\s*:\s*1|3\s*:\s*2|2\s*:\s*3|4\s*:\s*3|3\s*:\s*4|4\s*:\s*5|5\s*:\s*4|16\s*:\s*9|9\s*:\s*16|21\s*:\s*9|2\.35\s*:\s*1|2\.39\s*:\s*1)(?![\d:])"),
        ("resolution", r"(?<!\d)(?:480|720|1080|1440|2160)p(?!\w)"),
        ("cli_parameter", r"--[A-Za-z][\w-]*(?:\s+[^\s,;，；]+)?"),
    ]
    found = []
    for name, pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.IGNORECASE):
            token = re.sub(r"\s+", "", match.group(0))
            found.append((match.start(), name, token))
    found.sort(key=lambda value: value[0])
    return [(name, token) for _, name, token in found]


def _difference(before, after):
    before_counter = Counter(before)
    after_counter = Counter(after)
    missing = []
    added = []
    for token, count in (before_counter - after_counter).items():
        missing.extend([token] * count)
    for token, count in (after_counter - before_counter).items():
        added.extend([token] * count)
    return missing, added


def main(input: dict):
    if not isinstance(input, dict):
        raise ValueError("input must be an object")

    original_text = input.get("originalText")
    optimized_text = input.get("optimizedText")
    locked_literals = input.get("lockedLiterals", [])

    if not isinstance(original_text, str) or not original_text.strip():
        raise ValueError("originalText must be a non-empty string")
    if not isinstance(optimized_text, str) or not optimized_text.strip():
        raise ValueError("optimizedText must be a non-empty string")
    if not isinstance(locked_literals, list):
        raise ValueError("lockedLiterals must be an array")

    normalized_locks = []
    for value in locked_literals:
        if not isinstance(value, str) or not value:
            raise ValueError("lockedLiterals must contain non-empty strings")
        normalized_locks.append(value)

    original_tokens = _extract_tokens(original_text)
    optimized_tokens = _extract_tokens(optimized_text)
    missing_tokens, added_tokens = _difference(original_tokens, optimized_tokens)
    missing_literals = [value for value in normalized_locks if value not in optimized_text]

    warnings = []
    if not normalized_locks:
        warnings.append("未提供 lockedLiterals；固定台词和自定义字段需要人工复核")
    if len(original_text) > 200 and len(optimized_text) > len(original_text) * 2.5:
        warnings.append("优化后文本长度超过原文 2.5 倍，请检查是否越界扩写")

    valid = not missing_literals and not missing_tokens and not added_tokens
    return {
        "valid": valid,
        "readyToDeliver": valid,
        "missingLockedLiterals": missing_literals,
        "protectedTokenDifferences": {
            "missing": [name + ":" + token for name, token in missing_tokens],
            "added": [name + ":" + token for name, token in added_tokens],
        },
        "warnings": warnings,
        "summary": {
            "lockedLiteralCount": len(normalized_locks),
            "protectedTokenCountOriginal": len(original_tokens),
            "protectedTokenCountOptimized": len(optimized_tokens),
        },
    }
