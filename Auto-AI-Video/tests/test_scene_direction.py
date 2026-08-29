from pixelle_video.utils.scene_direction import (
    DEFAULT_MOTION_POOL,
    DEFAULT_TRANSITION_POOL,
    direct_storyboard_scenes,
    normalize_motion_pool,
    normalize_transition_pool,
)


def test_auto_direction_is_deterministic_and_semantic():
    scenes = [
        {"narration": "观察人物的面部表情", "visual_prompt": "人物肖像近景"},
        {"narration": "然而答案正在揭示", "visual_prompt": "关键证据出现"},
        {"narration": "最后总结整段历史", "visual_prompt": "远景全貌"},
    ]

    first = direct_storyboard_scenes(scenes)
    second = direct_storyboard_scenes(scenes)

    assert first == second
    assert first[0]["image_motion"] == "push_in"
    assert first[0]["transition"] == "none"
    assert first[0]["transition_duration"] == 0
    assert first[1]["transition"] in DEFAULT_TRANSITION_POOL
    assert first[2]["image_motion"] == "pull_out"
    assert all(scene["direction_reason"] for scene in first)


def test_auto_direction_honors_candidate_pools():
    result = direct_storyboard_scenes(
        [{"narration": "山河全景"}, {"narration": "然而发生转折"}],
        motion_pool=["pan_down"],
        transition_pool=["wipe_down"],
    )

    assert [scene["image_motion"] for scene in result] == ["pan_down", "pan_down"]
    assert result[1]["transition"] == "wipe_down"
    assert normalize_motion_pool(["bad", "none"]) == list(DEFAULT_MOTION_POOL)
    assert normalize_transition_pool(["bad", "none"]) == list(DEFAULT_TRANSITION_POOL)


def test_fixed_direction_uses_fallbacks_for_every_scene():
    result = direct_storyboard_scenes(
        [{"narration": "一"}, {"narration": "二"}],
        strategy="fixed",
        default_motion="pan_up",
        default_transition="circle_open",
        default_transition_duration=0.8,
    )

    assert result[0]["transition"] == "none"
    assert result[1]["transition"] == "circle_open"
    assert result[1]["transition_duration"] == 0.8
    assert all(scene["image_motion"] == "pan_up" for scene in result)
