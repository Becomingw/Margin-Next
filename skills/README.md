# Margin MCP skill

[`margin-mcp-reviewer`](margin-mcp-reviewer/SKILL.md) teaches an external AI to
review the one manuscript shared through Margin's seven review-only tools.
It defaults to comments, submits edits as pending proposals, preserves author
ownership, retries idempotently, and reads back human decisions.

## Setup

1. In Margin, open a manuscript → **AI reviewer → Enable access**.
2. Copy the configuration into a client supporting Streamable HTTP MCP with
   an `Authorization` header. Keep Margin open. Ports and credentials are
   session-specific; there is no fixed URL or name query parameter.
3. Copy the whole `margin-mcp-reviewer/` directory to your client's skill
   directory (for example `~/.claude/skills/`). Alternatively, use the skill
   ZIP attached to the matching Margin preview release.
4. Ask the client to review the shared manuscript with the skill. Installation
   is optional: the MCP tools can be used directly without a skill.

The Windows package also includes `skills/margin-mcp-reviewer/` beside the app.
Never publish connection credentials, and do not reuse the old workbench
skills: their tool names, permissions and storage assumptions do not apply.

The skill does not run a model or automatically deliver new comments to it.
After replying or deciding in Margin, ask your client to read updates and
continue. Disconnecting or switching manuscripts revokes the old connection.

工具、安全边界与中文使用说明：[单 AI checkpoint](../docs/margin-single-ai.md)。
