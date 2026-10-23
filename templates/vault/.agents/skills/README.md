# Skills

Create Vault seeds these when missing. Pick with `$` in Composer.

| Skill | Role |
| --- | --- |
| `paper-reader` | 显式精读任务 → `{paper}/NOTES.md`；普通问答不触发，短段落 / 紧凑结果表 / 行内引用 |
| `paper-qa` | 引用式论文问答；按需读已有正文 / 版面，默认只读，不生成笔记或标记已读 |
| `author-lookup` | 一作 / 通讯 email·主页·GitHub·ORCID·OpenReview → `NOTES.md`，作者信息报告 → `attachments/` |
| `edda-workspace` | 通过 MCP 查找、阅读与管理文献库：检索、元数据与源码路径、标记、标签、笔记、导入、移动 / 回收、推荐、诊断；批量与破坏性操作先列清单；跨平台使用同一工具契约 |
| `edda-paper-reviewer` | 审阅与修改 `reviews/` 下的稿件：`review_*` 工具，默认只加批注，明确要求才改写正文（AI 修订），不确认基线；多个 Agent 同审时按名字区分、互相回复 |
| `site-import` | 从「浏览」中的网页把论文（含需机构登录的 PDF）加入论文库；`browse_*` 工具 |
| `site-layout` | 用网页适配器的 CSS 让「浏览」中的网站在面板宽度下可读；`browse_check` 前后测量 |
| `vault-normalizer` | 整理现有研究目录并对比迁移前后的双链诊断 |
| `idea-evaluator` | 研究 idea 评审 |
| `deep-research` | 综述级文献调研 |

## Versioning & upgrades

First-party (and vendored) bundled skills carry an integer frontmatter field:

```yaml
version: 1
```

On vault open, Edda compares this to the app template:

- **lower version** → auto-upgrade to the template, then toast the skill id
- **same / higher version** → leave the on-disk file alone (including same-version edits)
- **no `version`** → leave alone (user-owned or unversioned install)

To customize a bundled skill and keep your edits across app updates, either
remove `version` or set it higher than the template after editing.

## Third-party source & license

`idea-evaluator` / `deep-research` are vendored from
[HKUSTDial/Supervisor-Skills](https://github.com/HKUSTDial/Supervisor-Skills)
(Yuyu Luo et al.).

**License: [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**  
Full text: [`LICENSE-Supervisor-Skills.txt`](LICENSE-Supervisor-Skills.txt)

`paper-reader` / `paper-qa` / `author-lookup` / `edda-workspace` / `edda-paper-reviewer` / `site-import` / `site-layout` / `vault-normalizer` are first-party (Edda license).
