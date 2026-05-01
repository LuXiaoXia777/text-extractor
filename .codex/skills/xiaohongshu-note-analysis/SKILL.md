---
name: xiaohongshu-note-analysis
description: Analyze a Xiaohongshu note using title, body, transcript, engagement metrics, and optional comment samples. Use when the task is to diagnose note quality, interpret like/save/comment signals, summarize content strengths, or suggest concrete optimizations for a Xiaohongshu post.
---

# Xiaohongshu Note Analysis

Use this skill when the user wants a structured analysis of a Xiaohongshu note.

## Inputs

Prefer these fields when available:

- `title`
- `author`
- `noteText`
- `transcript`
- `likeCount`
- `collectCount`
- `commentCount`
- `shareCount`
- `viewCount` or `exposureCount`
- `commentSamples`

If engagement data is missing, still continue with content-only analysis and explicitly label the limitation.

## Workflow

1. Check data availability.
2. Compute core ratios:
   - `engagementCount = like + collect + comment`
   - `engagementRate = engagementCount / exposureCount`
   - `collectLikeRatio = collect / like`
   - `commentLikeRatio = comment / like`
3. Judge content type from title + body + transcript.
4. Output:
   - content type
   - title diagnosis
   - collect/save potential
   - comment potential
   - conversion potential
5. Give at most 3 actionable suggestions.

## Output Template

Use this structure:

### 总结

- 1-3 concise takeaways

### 核心数据

- 点赞 / 收藏 / 评论 / 分享 / 浏览或曝光
- 互动总量
- 互动率
- 赞藏比
- 赞评比

### 内容判断

- 笔记类型
- 标题亮点或短板
- 收藏倾向判断
- 评论倾向判断
- 转化倾向判断

### 评论判断

- 如果有评论样本：总结主要问题、需求、情绪或异议
- 如果没有评论样本：明确写“当前仅基于评论数判断，评论正文未提供”

### 风险与限制

- 明确哪些数据缺失
- 区分“真实表现层结论”与“内容结构层结论”

### 优化建议

- 最多 3 条
- 必须能直接执行
- 优先改标题、结构、提问设计、行动号召

## Heuristics

- 收藏偏高通常意味着教程性、资料性、清单性、可回看价值更强
- 评论偏高通常意味着争议点、提问点、情绪代入或观点表达更强
- 点赞高但收藏低：更可能是轻互动或情绪认同
- 收藏高于常规：更可能是干货、方法、步骤、攻略、总结
- 没有真实互动数据时，不要假装判断表现优劣，只能判断“潜力”
