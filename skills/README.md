# Skills for external agents

Agent skills for using Edda from outside the app — Claude Code, Codex,
Antigravity, Cursor or any agent that supports skills and HTTP MCP. They teach
the agent how to use the tools of Edda's local MCP server.

| Skill | Use |
|---|---|
| [`edda-mcp-library`](edda-mcp-library/SKILL.md) | Find, read and manage papers in the Edda library |
| [`edda-mcp-reviewer`](edda-mcp-reviewer/SKILL.md) | Review and revise manuscripts in Edda's review workspace, alongside other agents |

## Setup

1. In Edda, open a local vault and switch on **Settings → Network → Edda MCP
   server** (设置 → 网络与集成 → Edda MCP 服务). The server listens on
   `http://127.0.0.1:8765/mcp`.
2. Add that address to your agent as an HTTP MCP server, with the agent's
   name in it: `?agent=<Name>`. Edda signs every comment, reply and revision
   from this connection with that name, so each agent keeps one fixed name
   whatever its MCP client reports. For example in Claude Code:

   ```bash
   claude mcp add --transport http edda "http://127.0.0.1:8765/mcp?agent=Claude%20Code"
   ```

   Codex (`~/.codex/config.toml`): `url = "http://127.0.0.1:8765/mcp?agent=Codex"`;
   Gemini CLI (`settings.json`): `"httpUrl": "http://127.0.0.1:8765/mcp?agent=Gemini"`.
   Without `?agent=`, Edda falls back to the client's self-reported name.

3. Copy the skill folders into your agent's skills directory, for example
   `~/.claude/skills/` for Claude Code.

Agents running inside Edda do not need these: Edda gives them the MCP tools
automatically and seeds its own versions of the skills into each vault
(`templates/vault/.agents/skills/edda-workspace` and `edda-paper-reviewer`).
Keep both sets in step when the MCP tools change.
