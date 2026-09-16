INTERACTION_PANELS = {
    "none": 0,
    "single": 3,
    "two-step": 4,
    "complex": 5,
}


def main(input: dict):
    asset_type = input.get("assetType", "")
    stable_state_count = input.get("stableStateCount", 0)
    interaction_kind = input.get("interactionKind", "none")
    interaction_evidenced = input.get("interactionEvidenced", False)
    errors = []
    warnings = []
    phases = []
    pause_after_call = []
    panel_plan = {
        "baseViewPanels": 0,
        "stableStatePanels": 0,
        "interactionPanels": 0,
        "totalFinalPanels": 0,
    }

    if asset_type == "person":
        normal_calls = 2
        phases = [
            {"index": 1, "name": "person-anchor", "purpose": "正面全身身份锚点", "usesPreviousOutput": False},
            {"index": 2, "name": "person-lock", "purpose": "同图四格人物锁", "usesPreviousOutput": True},
        ]
        pause_after_call = [1]
        panel_plan = {"baseViewPanels": 4, "stableStatePanels": 0, "interactionPanels": 0, "totalFinalPanels": 4}
        if stable_state_count or interaction_kind != "none":
            warnings.append("人物轻量流程忽略产品状态与交互参数")
    elif asset_type == "environment":
        normal_calls = 2
        phases = [
            {"index": 1, "name": "environment-plan", "purpose": "顶视正交平面图", "usesPreviousOutput": False},
            {"index": 2, "name": "environment-lock", "purpose": "同图 2×2 C1–C4", "usesPreviousOutput": True},
        ]
        panel_plan = {"baseViewPanels": 4, "stableStatePanels": 0, "interactionPanels": 0, "totalFinalPanels": 4}
        if stable_state_count or interaction_kind != "none":
            warnings.append("环境轻量流程忽略产品状态与交互参数")
    elif asset_type == "product":
        normal_calls = 1
        if not isinstance(stable_state_count, int) or isinstance(stable_state_count, bool) or stable_state_count < 0:
            errors.append("stableStateCount 必须是非负整数")
            stable_state_count = 0
        interaction_panels = 0
        if interaction_kind not in INTERACTION_PANELS:
            errors.append("interactionKind 无效")
        elif interaction_kind != "none" and interaction_evidenced:
            interaction_panels = INTERACTION_PANELS[interaction_kind]
        elif interaction_kind != "none" and not interaction_evidenced:
            warnings.append("交互缺少证据，已省略交互格")
        phases = [
            {"index": 1, "name": "product-lock", "purpose": "同图三视图及有证据状态/交互格", "usesPreviousOutput": False},
        ]
        total = 3 + stable_state_count + interaction_panels
        panel_plan = {
            "baseViewPanels": 3,
            "stableStatePanels": stable_state_count,
            "interactionPanels": interaction_panels,
            "totalFinalPanels": total,
        }
        if stable_state_count > 4:
            warnings.append("稳定状态格较多，请确认每个状态都外观不同且有证据")
        if total > 12:
            warnings.append("同一母图画格过多，可能影响产品结构和印刷可读性")
    else:
        normal_calls = 0
        errors.append("assetType 必须是 person、environment 或 product")

    return {
        "valid": len(errors) == 0,
        "assetType": asset_type,
        "normalCallCount": normal_calls,
        "phases": phases,
        "pauseAfterCall": pause_after_call,
        "panelPlan": panel_plan,
        "warnings": warnings,
        "errors": errors,
    }

