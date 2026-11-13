# Plan: Build the Docker image and push it to Docker Hub (`islands04/autotask-mcp`)

**Status:** Proposed
**Date:** 2026-11-13
**Audience:** first-time Docker user, working on Windows 11 (PowerShell)
**Target:** public Docker Hub repository `docker.io/islands04/autotask-mcp`
**Not a target:** `ghcr.io/wyre-ai/autotask-mcp` (WYRE's GitHub Container Registry)

---

## 0. Short answer: do the `Dockerfile` or `docker-compose.yml` need to change?

**No changes are *required*.** Where an image gets pushed is set entirely by the **tag you give it** when you build or push (`islands04/autotask-mcp:…`). Nothing in either file tells Docker to push anywhere.

Here is every WYRE reference I found, and what it actually does:

| File | Reference | What it does | Affects where you push? | Recommendation |
|---|---|---|---|---|
| `Dockerfile:18-19` | `@wyre-ai:registry=https://npm.pkg.github.com` + `_authToken` | Lets `npm ci` **download** the `autotask-node` dev dependency from GitHub Packages during the build. This is about pulling an npm package, not about container registries. | ❌ No | **Keep.** The build fails without it (see §3.3). The comment says `@wyre-ai` but the package is `@wyre-technology/autotask-node`. It still works because the lockfile has the full download URL and the token line applies to the whole `npm.pkg.github.com` host. |
| `Dockerfile:115` | `LABEL maintainer="engineering@wyre.ai"` | Metadata only | ❌ No | **Recommended:** change to you |
| `Dockerfile:123-125` | `org.opencontainers.image.source/documentation/url` → `github.com/WYRE-AI/…` and `…/pkgs/container/autotask-mcp` (the GHCR page) | Metadata shown on registry pages and in scanners | ❌ No | **Recommended:** point at your Docker Hub page / fork |
| `Dockerfile:126` | `LABEL org.opencontainers.image.vendor="Wyre Technology"` | Metadata | ❌ No | **Recommended:** change, so your public image doesn't look like an official WYRE release |
| `Dockerfile:130` | `LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/autotask-mcp"` | Claims ownership in the **MCP Registry**. Only read if someone publishes `server.json` to that registry. | ❌ No | **Recommended:** remove (or change to your own namespace). Your image isn't WYRE's registry entry. |
| `docker-compose.yml:15` | `image: autotask-mcp:latest` | Local name Compose gives the image it builds. Not a WYRE reference. | ❌ No | **Optional:** change to `islands04/autotask-mcp:latest` if you want Compose to pull your Hub image, or to push with `docker compose push` |
| `docker-compose.yml:61` | `image: autotask-mcp:dev` | Local dev image | ❌ No | Leave as is. Don't push dev images. |

Outside these two files, for awareness only. **No change is needed for a local build and push:**

| File | Reference | Why it doesn't matter here |
|---|---|---|
| `.github/workflows/release.yml:38` | `image-name: ghcr.io/wyre-ai/autotask-mcp` | That's **CI**, and it only runs on GitHub in the `WYRE-AI/autotask-mcp` repo. Building and pushing from your PC never triggers it. If you later fork to your own GitHub account, disable or edit this workflow; otherwise it will try (and fail) to push to WYRE's GHCR. |
| `server.json:15` | `ghcr.io/wyre-ai/autotask-mcp:0.0.0` | MCP Registry listing. Not used by Docker. |
| `DOCKER_USAGE.md`, `README.md` | `docker pull ghcr.io/wyre-ai/...` | Docs only. Use the commands in this plan instead. |
| `.do/deploy.template.yaml` | `repo: WYRE-AI/autotask-mcp` | DigitalOcean deploy. Unrelated. |

> ⚠️ **Git note:** this repo's `origin` is `https://github.com/WYRE-AI/autotask-mcp.git`. Pushing a Docker image doesn't touch git at all. But **don't `git push`** these branches unless you mean to send them to WYRE's repo.

---

## 1. Concepts in one minute

| Term | Meaning |
|---|---|
| **Dockerfile** | A recipe for building an image |
| **Image** | A packaged, read-only snapshot of the app plus Node.js plus OS files, produced by `docker build` |
| **Container** | A running instance of an image (`docker run`) |
| **Tag** | The image's full name: `registry/namespace/repo:version`. `islands04/autotask-mcp:2.18.0` means Docker Hub (the default registry), user `islands04`, repo `autotask-mcp`, version `2.18.0`. **The tag decides where `docker push` sends it.** |
| **Registry** | A server that stores images: Docker Hub (`docker.io`), GHCR (`ghcr.io`), … |
| **Multi-stage build** | This Dockerfile has a `builder` stage (installs dev tools, compiles TypeScript) and a `production` stage (only the compiled app). Only the **last stage** becomes the image you push. |

---

## 2. One-time setup

### 2.1 Install Docker Desktop

Docker isn't installed on this machine yet (`docker` isn't on PATH). WSL 2 with Ubuntu is already installed, which is what Docker Desktop uses on Windows.

1. Download **Docker Desktop for Windows** from <https://www.docker.com/products/docker-desktop/> and run the installer.
2. Leave **"Use WSL 2 instead of Hyper-V"** checked.
3. Start Docker Desktop and wait for the whale icon to show **"Engine running"**.
4. Open a **new** PowerShell window and check:

   ```powershell
   docker --version
   ```

   ```powershell
   docker run --rm hello-world
   ```

   The second command should print "Hello from Docker!".

### 2.2 Create the Docker Hub repository and an access token

1. Sign in at <https://hub.docker.com> as `islands04`.
2. **Repositories → Create repository** → name `autotask-mcp`, visibility **Public**.
3. **Account settings → Personal access tokens → Generate new token**. Give it a description (e.g. "autotask-mcp push") and **Read & Write** access. Copy the token; it's only shown once.
4. Log in from PowerShell. Paste the **token** (not your password) when asked:

   ```powershell
   docker login -u islands04
   ```

   You should see `Login Succeeded`. Docker stores the credential in Windows Credential Manager, so you only do this once.

### 2.3 Make sure the GitHub CLI can read packages

The build downloads `autotask-node` from GitHub Packages (the same 401 error `npm ci` hit earlier). You already ran `gh auth login`. Confirm the token works:

```powershell
gh auth token | Out-Null; if ($?) { "gh token OK" }
```

---

## 3. Decide what goes into the image

### 3.1 Which code gets built

`docker build` packages **whatever is in your working folder right now**, committed or not (`COPY . .` in the Dockerfile). Today that's the branch `fix/company-owner-resource-id` with the uncommitted `ownerResourceID` fix. That's probably what you want, but be deliberate:

```powershell
git branch --show-current
```

```powershell
git status --short
```

Recommended: commit the fix to the branch first, so the image matches a known commit (that's what the `COMMIT_SHA` label records).

### 3.2 Keep secrets out of a **public** image

Anyone can download a public image and inspect every file in it. This repo is already set up well:

- `.dockerignore` excludes `.env` and `.env.*` (but keeps `.env.example`), plus `node_modules`, `dist`, `.git`, `docs` and `*.md`.
- The final stage copies only `package*.json`, `dist/` and `node_modules/` from the builder. `.mcp.json`, `.claude/` and other repo files end up only in the throwaway builder stage.
- The Dockerfile deletes the temporary `.npmrc` straight after `npm ci`.

Two things to watch:

1. **Never** put an `.npmrc` with a token in the repo folder. It would be copied by `COPY . .`.
2. **The GitHub token build-arg.** It's only used in the `builder` stage, so it's not in the final image's layers. But newer Docker Desktop versions can attach **build provenance** metadata to images, and that can record build arguments. Always build with `--provenance=false` (see §4) and check with `docker history` (see §5.3).

### 3.3 Optional hardening: use a BuildKit secret instead of a build-arg

This is the one Dockerfile change worth considering. It's optional, since §3.2's `--provenance=false` already covers the risk. It replaces `ARG GITHUB_TOKEN` with a secret that is never written to any layer or metadata:

```dockerfile
# builder stage — replace lines 8 and 17-21
RUN --mount=type=secret,id=github_token \
    echo "@wyre-technology:registry=https://npm.pkg.github.com" > .npmrc && \
    echo "//npm.pkg.github.com/:_authToken=$(cat /run/secrets/github_token)" >> .npmrc && \
    npm ci --ignore-scripts && rm -f .npmrc
```

Then the build uses `--secret id=github_token,env=GITHUB_TOKEN` instead of `--build-arg GITHUB_TOKEN=…`.

**Caveat:** upstream CI (`.github/workflows/test.yml:82`) passes `--build-arg GITHUB_TOKEN`, so this change would break WYRE's CI Docker build if it were ever merged upstream. Keep it on your own branch, or skip it.

### 3.4 Recommended label changes (metadata only): ✅ applied 2026-11-13

These are now in the `Dockerfile` production stage (lines ~115-133). `documentation` also still points at the upstream README. The snippet below shows what changed:

```dockerfile
LABEL maintainer="islands04"
LABEL org.opencontainers.image.source="https://github.com/WYRE-AI/autotask-mcp"   # keep: upstream source (Apache-2.0 attribution)
LABEL org.opencontainers.image.url="https://hub.docker.com/r/islands04/autotask-mcp"
LABEL org.opencontainers.image.vendor="islands04"
# Remove: this image is not WYRE's MCP Registry entry
# LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/autotask-mcp"
```

Keep `org.opencontainers.image.licenses="Apache-2.0"`. The project is Apache-2.0 licensed, and keeping the source pointer to the original repo is good attribution. Point `source` at your own fork instead if you create one.

---

## 4. Build the image

Run everything from the repo root in PowerShell:

```powershell
cd C:\Dev\projects\shi-work-related\autotask-mcp
```

Set the build values. The version is up to you; a suffix makes it clear this isn't an upstream release:

```powershell
$VERSION = "2.18.0-owner-fix.1"
$SHA     = git rev-parse --short HEAD
$DATE    = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$env:GITHUB_TOKEN = gh auth token
```

Build. This creates the image locally and gives it two tags:

```powershell
docker build --provenance=false --target production --build-arg GITHUB_TOKEN=$env:GITHUB_TOKEN --build-arg VERSION=$VERSION --build-arg COMMIT_SHA=$SHA --build-arg BUILD_DATE=$DATE -t islands04/autotask-mcp:$VERSION -t islands04/autotask-mcp:latest .
```

What the flags mean:

| Flag | Purpose |
|---|---|
| `--provenance=false` | Don't attach build metadata that could record the token build-arg (§3.2) |
| `--target production` | Build up to the final stage (it's the default anyway; this is explicit) |
| `--build-arg GITHUB_TOKEN=…` | Lets `npm ci` fetch `autotask-node` from GitHub Packages |
| `--build-arg VERSION=…` | The Dockerfile writes this into `package.json`, so `/health` and `serverInfo.version` report it |
| `-t islands04/autotask-mcp:…` | **The tag that sends the push to your Docker Hub repo** |
| `.` | Build context = current folder |

Clear the token from the shell afterwards:

```powershell
Remove-Item Env:GITHUB_TOKEN
```

The first build takes a few minutes; later builds reuse cached layers. If it fails with `401 Unauthorized … npm.pkg.github.com`, the token is missing or lacks `read:packages`. Re-run `gh auth login --scopes read:packages`.

If you used the optional §3.3 secret, replace `--build-arg GITHUB_TOKEN=$env:GITHUB_TOKEN` with `--secret id=github_token,env=GITHUB_TOKEN`.

---

## 5. Test the image locally before pushing

### 5.1 Check it exists

```powershell
docker images islands04/autotask-mcp
```

### 5.2 Run it in HTTP mode (the image default)

The server **refuses to start** in HTTP mode without a real `CONDUIT_S2S_SECRET` (empty or placeholder values like `changeme` are rejected). For a local test, generate a random one:

```powershell
$S2S = -join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
```

```powershell
docker run -d --name autotask-test -p 127.0.0.1:8080:8080 -e CONDUIT_S2S_SECRET=$S2S -e AUTOTASK_USERNAME="you@company.com" -e AUTOTASK_SECRET="…" -e AUTOTASK_INTEGRATION_CODE="…" islands04/autotask-mcp:latest
```

```powershell
curl.exe http://127.0.0.1:8080/health
```

Expect `{"status":"ok","version":"2.18.0-owner-fix.1",...}`. Check the logs and clean up:

```powershell
docker logs autotask-test
```

```powershell
docker rm -f autotask-test
```

(Every `/mcp` call needs a signed `X-Gateway-S2S` header. See the README section "X-Gateway-S2S signing" for a full example.)

### 5.3 Confirm no secrets are baked in

```powershell
docker history --no-trunc islands04/autotask-mcp:latest | Select-String -Pattern "ghp_|gho_|_authToken|GITHUB_TOKEN"
```

This should print **nothing**. Also check the image config:

```powershell
docker image inspect islands04/autotask-mcp:latest --format "{{json .Config.Env}}"
```

You should see only the defaults (`NODE_ENV`, `LOG_LEVEL`, `MCP_TRANSPORT=http`, …), with no credentials.

### 5.4 Optional: run it as a local stdio server for Claude Desktop or Claude Code

`stdio` mode needs no S2S secret. Override the command to use `dist/entry.js`. The image's default `CMD` runs `dist/index.js`, which skips the stdio guard that keeps stray stdout writes from corrupting the protocol:

```powershell
claude mcp add autotask-docker -- docker run -i --rm -e MCP_TRANSPORT=stdio -e AUTOTASK_USERNAME=you@company.com -e AUTOTASK_SECRET=… -e AUTOTASK_INTEGRATION_CODE=… islands04/autotask-mcp:latest node dist/entry.js
```

Then ask *"Who owns company X?"* to confirm the `ownerResourceID` fix end to end.

---

## 6. Push to Docker Hub

```powershell
docker push islands04/autotask-mcp:2.18.0-owner-fix.1
```

```powershell
docker push islands04/autotask-mcp:latest
```

Check <https://hub.docker.com/r/islands04/autotask-mcp/tags>. Both tags should be listed. Then prove it pulls from a clean state:

```powershell
docker rmi islands04/autotask-mcp:latest
```

```powershell
docker pull islands04/autotask-mcp:latest
```

> `denied: requested access to the resource is denied` means you're not logged in as `islands04` (`docker login -u islands04`), or the Hub repository name doesn't match the tag.

---

## 7. Optional: multi-architecture image (Apple Silicon / ARM servers)

`docker build` produces an image for your PC's CPU (`linux/amd64`). To also support ARM (`linux/arm64`), build and push in one step with buildx. The upstream workflow does the same, and it works under emulation because nothing in the Dockerfile compiles native code:

```powershell
docker buildx create --name multi --use
```

```powershell
docker buildx build --platform linux/amd64,linux/arm64 --provenance=false --build-arg GITHUB_TOKEN=$env:GITHUB_TOKEN --build-arg VERSION=$VERSION --build-arg COMMIT_SHA=$SHA --build-arg BUILD_DATE=$DATE -t islands04/autotask-mcp:$VERSION -t islands04/autotask-mcp:latest --push .
```

(Set `$env:GITHUB_TOKEN` again first, and remove it afterwards.) `--push` uploads straight to Docker Hub. Multi-arch images can't be loaded into the local image list, so test with `docker pull` + `docker run` afterwards.

---

## 8. Optional: use Docker Compose with your Hub image

To make `docker compose` pull or push your Hub image, change `docker-compose.yml:15`:

```yaml
    image: islands04/autotask-mcp:latest
```

Behaviour after the change:

- `docker compose build` builds locally and tags it `islands04/autotask-mcp:latest`. It doesn't pass `GITHUB_TOKEN`, so you'd also need to add `args: [GITHUB_TOKEN]` under `build:`. Simpler: build with §4.
- `docker compose pull` + `docker compose up -d` runs the Hub image (the `build:` block is only used when the image is missing or you pass `--build`).
- `docker compose push` pushes it.

Remember that the Compose service runs in **gateway mode** and needs `CONDUIT_S2S_SECRET` in `.env`.

---

## 9. Releasing a new version later

1. Make and commit code changes.
2. Bump `$VERSION` (e.g. `2.18.0-owner-fix.2`).
3. Repeat §4 (build), §5 (test), §6 (push). Always push the version tag **and** `latest`.

---

## 10. Checklist

- [ ] Docker Desktop installed; `docker run --rm hello-world` works
- [ ] Docker Hub repo `islands04/autotask-mcp` created (public)
- [ ] Docker Hub access token created; `docker login -u islands04` succeeded
- [ ] `gh auth token` works (`read:packages`)
- [ ] Fix committed on the branch being built
- [x] (Recommended) Dockerfile labels updated, §3.4
- [ ] (Optional) BuildKit secret, §3.3
- [ ] Image built with `--provenance=false` and tagged `islands04/autotask-mcp:<version>` + `:latest`
- [ ] `/health` returns the right version; logs clean
- [ ] `docker history` / `inspect` show no tokens or credentials
- [ ] Both tags pushed and visible on Docker Hub
- [ ] `docker pull islands04/autotask-mcp:latest` works from a clean state
- [ ] No `git push` to `origin` (WYRE-AI) by accident
