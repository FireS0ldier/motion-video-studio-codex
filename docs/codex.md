# Using the studio with OpenAI Codex

This is the Codex edition of Motion Video Studio. Nothing in the engine or the CLI calls an LLM; the guide ([AGENTS.md](../AGENTS.md)) and the skills are plain Markdown that Codex loads by itself. This page covers what Codex needs on top: sandbox settings, caches, long-running commands, images, Codex Cloud and the model choice.

> Checked against Codex's documentation ([learn.chatgpt.com/docs](https://learn.chatgpt.com/docs)) and source ([openai/codex](https://github.com/openai/codex), CLI 0.160.1) on 6 October 2026. The video workflow has **not been run end to end inside Codex** yet. What depends on Codex's sandbox is described from its documentation and code; the Python cache fallback and rendering with a read-only home folder were tested outside Codex (Linux, read-only bind mounts).

## What works without setup

| | |
| --- | --- |
| **Instructions** | Codex loads `AGENTS.md` automatically. It is the full guide and stays well below the 32 KiB Codex reads from a project's `AGENTS.md` files (`npm test` checks the size). |
| **Skills** | `create-video`, `add-scene` and `review-video` are in `.agents/skills/`, where Codex looks for project skills. They follow the open Agent Skills format (`npm test` checks it). |
| **Project settings** | [`.codex/config.toml`](../.codex/config.toml) turns on network for the sandbox and picks the model. Codex uses it once you trust the folder (it asks when you open the project the first time). |
| **Looking at stills** | Codex's built-in `view_image` tool opens the PNGs from `mvs review` and `mvs still`. The model must accept image input (all models recommended below do). |
| **Long commands** | Codex gets control back after at most 30 s while a command keeps running as a background terminal, and checks on it; there is no time limit. A draft render of the 50 s demo takes about 3 min, the final about 37 min on 4 CPU cores. In the CLI, `/ps` lists running commands and `/stop` ends them. |

## Sandbox and network

By default Codex runs commands in the `workspace-write` sandbox with **network off** and asks before running anything outside it (`on-request`). The project settings turn network on:

```toml
# .codex/config.toml
[sandbox_workspace_write]
network_access = true
```

If you use permission profiles (`default_permissions`), Codex ignores `[sandbox_workspace_write]`; turn network on in your profile instead (`[permissions.<name>.network] enabled = true`).

Network is needed for `npm install`, `npm run setup`, `mvs voice` and `mvs align` (models come from Hugging Face and GitHub, Python packages from PyPI through `uv`). On Linux it is also needed for every command that renders (`still`, `review`, `check`, `render`, `dev`): they start a local server, and with network off the sandbox blocks sockets. If you do not trust the project, put the same lines into your own `~/.codex/config.toml`, or run Codex with `-c 'sandbox_workspace_write.network_access=true'`.

**Writes outside the repository.** The sandbox lets commands write only inside the repository and the temp folder; inside the repository `.git`, `.agents` and `.codex` stay read-only (commits and changes to skills or settings need your approval).

- The Python tools (`voice`, `align`) notice when the user cache folder (`~/.cache`) is read-only and keep uv's environments and the Hugging Face/PyTorch caches in `.cache/python/` instead (about 200 MB for Piper, several GB with WhisperX). Folders you set yourself (`UV_CACHE_DIR`, `HF_HOME`, `TORCH_HOME`) are kept. `npx mvs clean <id> --all` deletes them (with all of `.cache/`, models included, and that project's `build/` and `out/`).
- The one-time setup writes to your home folder: `npm install` (npm cache) and `npm run setup` (Chromium in `~/.cache/ms-playwright`, on macOS `~/Library/Caches/ms-playwright`). Run both in a terminal before the first Codex session, approve them when Codex asks, or create the folders (`mkdir -p ~/.npm ~/.cache/ms-playwright`; Codex skips writable roots that do not exist yet) and allow them in your own `~/.codex/config.toml`:

  ```toml
  [sandbox_workspace_write]
  writable_roots = ["~/.npm", "~/.cache/ms-playwright"]   # macOS: "~/Library/Caches/ms-playwright"
  ```

**macOS:** Chromium cannot start inside Codex's macOS sandbox (open issues [#8011](https://github.com/openai/codex/issues/8011), [#14368](https://github.com/openai/codex/issues/14368), [#21292](https://github.com/openai/codex/issues/21292)). Approve the render commands (`still`, `review`, `check`, `render`, `dev`) when Codex asks to run them outside the sandbox.

## Working tips

- **Review images:** `view_image` scales images down to 2048 px on the long side by default. `contact.png` is about 2900 px wide, so judge layout and type on `scene-*.png` and `transition-*.png` (960×540) one by one, ask for `detail: "original"`, or use `npx mvs still <id> --t <s>` for a moment.
- **Preview server:** `mvs dev` never exits. Codex can run it in the background, but stills and the review pack show the same frames and are easier to inspect.
- **4K:** ask first (`--uhd` takes about 4× as long), as the guide says.

## Codex Cloud

Prefer the CLI or the desktop app for videos. In Codex Cloud:

- **Environment:** Codex sets up a new environment in a conversation and records an install script. Tell it to use `bash tools/codex-cloud-setup.sh`: it installs ffmpeg and Chromium (not part of Codex's reference image) and the npm packages, the same way CI does (`.github/workflows/ci.yml`), and ends with `npx mvs doctor`. In Codex Cloud (Legacy), use the same line as the setup script and turn *Agent internet access* on (it is off by default there).
- **Internet access:** turn on *Allow Codex to access internet*, choose *Package managers* (npm, PyPI, GitHub, apt) and add under *Additional allowed domains*: `huggingface.co`, `us.aws.cdn.hf.co` (where Hugging Face downloads redirect; another region may use another host, which the error message names), `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`; for WhisperX also `raw.githubusercontent.com` (PyTorch's downloads are in the preset). Subdomains have to be listed one by one.
- **Size:** Plus runs on 2 vCPU / 8 GiB RAM / 8 GiB disk: enough for Kokoro, Piper and CTC alignment, not for WhisperX (about 8 GB). Pro, Business and Enterprise get 4 vCPU / 16 GiB / 32 GiB. Final renders are slow on 2 cores; use `--draft`.
- **Untested:** whether the agent can look at images in cloud tasks. Without it, the visual review (step 12 of the guide) cannot happen, and the agent should say so.

## Which model

As of 6 October 2026 ([current list](https://learn.chatgpt.com/docs/models)):

| Task | Model | `model_reasoning_effort` |
| --- | --- | --- |
| New video: script, custom scenes, visual review | `gpt-6.1-sol` (Codex default where available, recommended for complex agent work) | `high` (project default); `xhigh` for review rounds |
| Routine edits (texts, brand, re-renders, template-only videos) | `gpt-6.1-sol` | `low` or `medium` |
| Small text or timing fixes | `gpt-6-luna` (fast, cheap) | `high` |
| Only if quality falls short | `gpt-6-astra` (most capable, about 5× the price) | start with `low` |

- `.codex/config.toml` sets `gpt-6.1-sol` with `high`, because Codex's built-in default effort for this model is `low`. For one session use `codex -m <model>` or `/model`.
- If your account cannot use `gpt-6.1-sol` yet (staged rollout; Enterprise/Edu: an admin enables it), set `model = "gpt-6-sol"` on Plus and higher, or `"gpt-6-luna"` on Free/Go (desktop app only).
- `gpt-5.5` retires from Codex with ChatGPT sign-in on 14 October 2026 (API keys are unaffected).
- All four models accept images, which `view_image` needs.
- Plans and limits: [learn.chatgpt.com/docs/pricing](https://learn.chatgpt.com/docs/pricing). The CLI needs ChatGPT Plus or higher, or an API key.

## Updates from the original studio

This repository is a copy of [FireS0ldier/motion-video-studio](https://github.com/FireS0ldier/motion-video-studio), the edition for Claude Code. Engine and CLI improvements made there can be merged here:

```bash
git remote add upstream https://github.com/FireS0ldier/motion-video-studio.git
git fetch upstream && git merge upstream/main
```

The original keeps its guide in `CLAUDE.md` and its skills in `.claude/skills/`, so a merge brings those back. Before deleting them again, port their changes into `AGENTS.md` and `.agents/skills/` (`git diff <previous upstream commit> upstream/main -- CLAUDE.md .claude/`) and replace any Claude-specific wording. Expect conflicts in `AGENTS.md`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `package.json` and the files this edition changed (`cli/lib/python.ts`, `docs/`). `npm test` fails while `CLAUDE.md` or `.claude/` exist or the guide mentions them.
