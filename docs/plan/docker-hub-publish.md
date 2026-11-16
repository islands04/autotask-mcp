# Plan: Build the Docker image and push it to Docker Hub (`islands04/autotask-mcp`)

**Status:** Proposed
**Date:** 2026-11-13 (revised for WSL2 the same day)
**Audience:** first-time Docker user, building from **WSL2 Ubuntu 24.04 (bash)** on Windows 11
**Target:** public Docker Hub repository `docker.io/islands04/autotask-mcp`
**Not a target:** `ghcr.io/wyre-ai/autotask-mcp` (WYRE's GitHub Container Registry)

All commands below are **bash**, run inside the Ubuntu WSL2 terminal, from the repo at
`~/dev/projects/autotask-mcp`. Don't build from a `/mnt/c/...` path: the Windows file system is
much slower under WSL2, and the build context gets copied on every build.

---

## 0. Short answer: do the `Dockerfile` or `docker-compose.yml` need to change?

**No changes are *required*.** Where an image gets pushed is set entirely by the **tag you give it** when you build or push (`islands04/autotask-mcp:…`). Nothing in either file tells Docker to push anywhere.

Here is every WYRE reference I found, and what it actually does:

| File | Reference | What it does | Affects where you push? | Recommendation |
|---|---|---|---|---|
| `Dockerfile:18-19` | `@wyre-ai:registry=https://npm.pkg.github.com` + `_authToken` | Lets `npm ci` **download** the `autotask-node` dev dependency from GitHub Packages during the build. This is about pulling an npm package, not about container registries. | ❌ No | **Keep.** The build fails without it (see §3.3). The comment says `@wyre-ai` but the package is `@wyre-technology/autotask-node`. It still works because the lockfile has the full download URL and the token line applies to the whole `npm.pkg.github.com` host. |
| `Dockerfile` labels | `maintainer`, `org.opencontainers.image.*`, `io.modelcontextprotocol.server.name` | Metadata only | ❌ No | ✅ Already updated, see §3.4 |
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
| **BuildKit / buildx** | The modern Docker build engine. Flags like `--provenance` and `--secret` only exist with it. |

---

## 2. One-time setup (WSL2 Ubuntu)

### 2.1 Docker Engine: already installed

Docker Engine is installed **natively inside Ubuntu** (the `docker.io` apt package, 29.1.3), the daemon is running, and your user is in the `docker` group, so no `sudo` is needed. You do **not** need Docker Desktop for Windows.

> If you ever do install Docker Desktop with WSL integration, it would put a second `docker` CLI and daemon in front of this one. Pick one. This plan assumes the native Ubuntu engine.

Check it:

```bash
docker --version
docker run --rm hello-world
```

The second command should print "Hello from Docker!". If you get `Cannot connect to the Docker daemon`, start it with `sudo service docker start` (or `sudo systemctl start docker` if systemd is enabled in WSL).

### 2.2 Install the buildx and Compose v2 plugins

**buildx isn't installed yet** (`docker buildx` → "unknown command"). Without it, `docker build` falls back to the deprecated legacy builder, which rejects `--provenance=false` (§4) and `--secret` (§3.3). The Compose that's installed is the old Python `docker-compose` 1.29. §8 uses the `docker compose` v2 plugin.

```bash
sudo apt update
sudo apt install -y docker-buildx docker-compose-v2
docker buildx version
docker compose version
```

### 2.3 Docker Hub repository and access token

1. Sign in at <https://hub.docker.com> as `islands04` (in your Windows browser).
2. **Repositories → Create repository** → name `autotask-mcp`, visibility **Public**.
3. **Account settings → Personal access tokens → Generate new token**. Give it a description (e.g. "autotask-mcp push") and **Read & Write** access. Copy the token; it's only shown once.
4. Log in from bash. Paste the **token** (not your password) when asked:

   ```bash
   docker login -u islands04
   ```

   You should see `Login Succeeded`.

> **Where the credential goes:** `~/.docker/config.json` already has a Docker Hub entry and no credential helper, so the token is stored there **base64-encoded, not encrypted**. That's the Linux default. For a personal machine it's acceptable: keep the token scoped to Read & Write on this account, and revoke it on Docker Hub if the machine is ever compromised. To encrypt it instead, set up `docker-credential-pass` (needs `pass` + a GPG key). That's optional.

### 2.4 Give the GitHub CLI token `read:packages`

The build downloads `autotask-node` from GitHub Packages. `gh` is logged in as `islands04`, but its token currently has the scopes `gist, read:org, repo, workflow`. **`read:packages` is missing**, so `npm ci` inside the build would fail with `401 Unauthorized`. Add it once:

```bash
gh auth refresh -h github.com -s read:packages
gh auth status    # "Token scopes" should now include 'read:packages'
```

(Your `islands04` account also needs read access to the `@wyre-technology/autotask-node` package itself. If it doesn't have that, adding the scope won't help, and you'll still get 401/403.)

---

## 3. Decide what goes into the image

### 3.1 Which code gets built

`docker build` packages **whatever is in your working folder right now**, committed or not (`COPY . .` in the Dockerfile). Today that's `main` (the `ownerResourceID` fix is merged) plus the uncommitted `Dockerfile` label changes. Be deliberate:

```bash
cd ~/dev/projects/autotask-mcp
git branch --show-current
git status --short
```

Recommended: commit first, so the image matches a known commit (that's what the `COMMIT_SHA` label records).

### 3.2 Keep secrets out of a **public** image

Anyone can download a public image and inspect every file in it. This repo is already set up well:

- `.dockerignore` excludes `.env` and `.env.*` (but keeps `.env.example`), plus `node_modules`, `dist`, `.git`, `docs` and `*.md`.
- The final stage copies only `package*.json`, `dist/` and `node_modules/` from the builder. `.mcp.json`, `.claude/` and other repo files end up only in the throwaway builder stage.
- The Dockerfile deletes the temporary `.npmrc` straight after `npm ci`.

Two things to watch:

1. **Never** put an `.npmrc` with a token in the repo folder. It would be copied by `COPY . .`. (There isn't one today. A token in `~/.npmrc` in your home directory is fine; it's outside the build context.)
2. **The GitHub token build-arg.** It's only used in the `builder` stage, so it's not in the final image's layers. But BuildKit can attach **build provenance** metadata to images, and that can record build arguments. Always build with `--provenance=false` (see §4) and check with `docker history` (see §5.3).

### 3.3 Optional hardening: use a BuildKit secret instead of a build-arg

This is the one Dockerfile change worth considering. It's optional, since §3.2's `--provenance=false` already covers the risk. It replaces `ARG GITHUB_TOKEN` with a secret that is never written to any layer or metadata:

```dockerfile
# builder stage — replace `ARG GITHUB_TOKEN=""` and the .npmrc/npm ci RUN
RUN --mount=type=secret,id=github_token \
    echo "@wyre-technology:registry=https://npm.pkg.github.com" > .npmrc && \
    echo "//npm.pkg.github.com/:_authToken=$(cat /run/secrets/github_token)" >> .npmrc && \
    npm ci --ignore-scripts && rm -f .npmrc
```

Then the build uses `--secret id=github_token,env=GITHUB_TOKEN` instead of `--build-arg GITHUB_TOKEN=…`. This needs buildx (§2.2).

**Caveat:** upstream CI (`.github/workflows/test.yml:82`) passes `--build-arg GITHUB_TOKEN`, so this change would break WYRE's CI Docker build if it were ever merged upstream. Keep it on your own branch, or skip it.

### 3.4 Recommended label changes (metadata only): ✅ applied 2026-11-13

These are now in the `Dockerfile` production stage. `documentation` still points at the upstream README. The snippet below shows what changed:

```dockerfile
LABEL maintainer="islands04"
LABEL org.opencontainers.image.source="https://github.com/islands04/autotask-mcp"   # your fork
LABEL org.opencontainers.image.url="https://hub.docker.com/r/islands04/autotask-mcp"
LABEL org.opencontainers.image.vendor="islands04"
# Removed: this image is not WYRE's MCP Registry entry
# LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/autotask-mcp"
```

Keep `org.opencontainers.image.licenses="Apache-2.0"`. The project is Apache-2.0 licensed.

> **Watch the hardcoded build-arg defaults.** The production stage currently has
> `ARG VERSION="1.0.1-ownerResourceID-fix"`, `ARG COMMIT_SHA="6252167…"` and `ARG BUILD_DATE="2026-11-13"`.
> The values you pass with `--build-arg` (§4) override them, so they're harmless as long as you
> always pass all three. If you forget, the labels show these stale values, while the builder stage's
> `VERSION` stays `"unknown"`, so `/health` reports `package.json`'s `2.18.0` instead. Consider
> setting them back to `"unknown"` so a forgotten flag is obvious rather than silently wrong.

---

## 4. Build the image

Run everything from the repo root in the Ubuntu terminal:

```bash
cd ~/dev/projects/autotask-mcp
```

Set the build values. These are ordinary shell variables, and they only exist in **this terminal session**. If you open a new tab or close the window, set them again. The version is up to you; a suffix makes it clear this isn't an upstream release:

```bash
VERSION="2.18.0-owner-fix.1"
SHA="$(git rev-parse --short HEAD)"
DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export GITHUB_TOKEN="$(gh auth token)"
```

Check them before building:

```bash
echo "$VERSION | $SHA | $DATE"
[ -n "$GITHUB_TOKEN" ] && echo "token set" || echo "token MISSING"
```

Build. This creates the image locally and gives it two tags:

```bash
docker build \
  --provenance=false \
  --target production \
  --build-arg GITHUB_TOKEN="$GITHUB_TOKEN" \
  --build-arg VERSION="$VERSION" \
  --build-arg COMMIT_SHA="$SHA" \
  --build-arg BUILD_DATE="$DATE" \
  -t "islands04/autotask-mcp:$VERSION" \
  -t islands04/autotask-mcp:latest \
  .
```

What the flags mean:

| Flag | Purpose |
|---|---|
| `--provenance=false` | Don't attach build metadata that could record the token build-arg (§3.2). Needs buildx (§2.2). |
| `--target production` | Build up to the final stage (it's the default anyway; this is explicit) |
| `--build-arg GITHUB_TOKEN=…` | Lets `npm ci` fetch `autotask-node` from GitHub Packages |
| `--build-arg VERSION=…` | The Dockerfile writes this into `package.json`, so `/health` and `serverInfo.version` report it |
| `--build-arg UPSTREAM_SHA=…` | Records the upstream WYRE-AI commit this fork is based on, in the `io.github.islands04.upstream-revision` label |
| `-t islands04/autotask-mcp:…` | **The tag that sends the push to your Docker Hub repo** |
| `.` | Build context = current folder |

Clear the token from the shell afterwards:

```bash
unset GITHUB_TOKEN
```

The first build takes a few minutes; later builds reuse cached layers. Common failures:

- `401 Unauthorized … npm.pkg.github.com`: the token is missing (new terminal?) or lacks `read:packages`. See §2.4.
- `unknown flag: --provenance`: buildx isn't installed. See §2.2.

If you used the optional §3.3 secret, replace `--build-arg GITHUB_TOKEN="$GITHUB_TOKEN"` with `--secret id=github_token,env=GITHUB_TOKEN`. The variable must be `export`ed for that to work, which the block above already does.

---

## 5. Test the image locally before pushing

### 5.1 Check it exists

```bash
docker images islands04/autotask-mcp
```

### 5.2 Run it in HTTP mode (the image default)

The server **refuses to start** in HTTP mode without a real `CONDUIT_S2S_SECRET` (empty or placeholder values like `changeme` are rejected). For a local test, generate a random one:

```bash
S2S="$(openssl rand -hex 32)"
```

```bash
docker run -d --name autotask-test \
  -p 127.0.0.1:8080:8080 \
  -e CONDUIT_S2S_SECRET="$S2S" \
  -e AUTOTASK_USERNAME='you@company.com' \
  -e AUTOTASK_SECRET='…' \
  -e AUTOTASK_INTEGRATION_CODE='…' \
  islands04/autotask-mcp:latest
```

Use **single quotes** around the Autotask secret, so bash doesn't try to expand any `$` or `!` in it. To keep credentials out of your shell history, put them in a file instead and use `--env-file ./autotask-test.env`. `.env*` files are already excluded from the image by `.dockerignore`, but don't commit that file.

```bash
curl -s http://127.0.0.1:8080/health
```

Expect `{"status":"ok","version":"2.18.0-owner-fix.1",...}`. With WSL2's default localhost forwarding, `http://localhost:8080/health` also works from a Windows browser.

Check the logs and clean up:

```bash
docker logs autotask-test
docker rm -f autotask-test
```

(Every `/mcp` call needs a signed `X-Gateway-S2S` header. See the README section "X-Gateway-S2S signing" for a full example.)

### 5.3 Confirm no secrets are baked in

```bash
docker history --no-trunc islands04/autotask-mcp:latest | grep -E 'ghp_|gho_|_authToken|GITHUB_TOKEN'
```

This should print **nothing**. (`gh` tokens start with `gho_`.) Also check the image config:

```bash
docker image inspect islands04/autotask-mcp:latest --format '{{json .Config.Env}}'
```

You should see only the defaults (`NODE_ENV`, `LOG_LEVEL`, `MCP_TRANSPORT=http`, …), with no credentials.

### 5.4 Optional: run it as a local stdio server for Claude Code

`stdio` mode needs no S2S secret. Override the command to use `dist/entry.js`. The image's default `CMD` runs `dist/index.js`, which skips the stdio guard that keeps stray stdout writes from corrupting the protocol:

```bash
claude mcp add autotask-docker -- docker run -i --rm \
  -e MCP_TRANSPORT=stdio \
  -e AUTOTASK_USERNAME='you@company.com' \
  -e AUTOTASK_SECRET='…' \
  -e AUTOTASK_INTEGRATION_CODE='…' \
  islands04/autotask-mcp:latest node dist/entry.js
```

This works for Claude Code running **inside WSL**. Claude Desktop on Windows can't see the WSL `docker` directly. Use `wsl docker run ...` as its command if you want to wire it up there.

Then ask *"Who owns company X?"* to confirm the `ownerResourceID` fix end to end.

---

## 6. Push to Docker Hub

```bash
docker push "islands04/autotask-mcp:$VERSION"
docker push islands04/autotask-mcp:latest
```

(In a new terminal, `$VERSION` is gone. Type the tag out, e.g. `islands04/autotask-mcp:2.18.0-owner-fix.1`.)

Check <https://hub.docker.com/r/islands04/autotask-mcp/tags>. Both tags should be listed. Then prove it pulls from a clean state:

```bash
docker rmi islands04/autotask-mcp:latest
docker pull islands04/autotask-mcp:latest
```

> `denied: requested access to the resource is denied` means you're not logged in as `islands04` (`docker login -u islands04`), or the Hub repository name doesn't match the tag.

---

## 7. Optional: multi-architecture image (Apple Silicon / ARM servers)

`docker build` produces an image for your PC's CPU (`linux/amd64`). To also support ARM (`linux/arm64`), build and push in one step with buildx. On native Linux Docker this needs two extra one-time steps that Docker Desktop would otherwise do for you: QEMU emulation, and a `docker-container` builder (the default builder can't produce multi-platform images).

```bash
# one time: register QEMU emulators for arm64
docker run --privileged --rm tonistiigi/binfmt --install arm64
# one time: create a multi-platform builder
docker buildx create --name multi --driver docker-container --use
docker buildx inspect --bootstrap   # Platforms should list linux/arm64
```

Then (with `VERSION`, `SHA`, `DATE` and `GITHUB_TOKEN` set as in §4):

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --provenance=false \
  --build-arg GITHUB_TOKEN="$GITHUB_TOKEN" \
  --build-arg VERSION="$VERSION" \
  --build-arg COMMIT_SHA="$SHA" \
  --build-arg BUILD_DATE="$DATE" \
  -t "islands04/autotask-mcp:$VERSION" \
  -t islands04/autotask-mcp:latest \
  --push .
unset GITHUB_TOKEN
```

`--push` uploads straight to Docker Hub. Multi-arch images can't be loaded into the local image list, so test with `docker pull` + `docker run` afterwards. The arm64 half is built under emulation, so expect it to be several times slower. Nothing in the Dockerfile compiles native code, so it works.

To go back to the normal builder for §4 builds: `docker buildx use default`.

---

## 8. Optional: use Docker Compose with your Hub image

This needs the Compose v2 plugin from §2.2 (`docker compose`, with a space, not `docker-compose`). To make it pull or push your Hub image, change `docker-compose.yml:15`:

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
2. Bump `VERSION` (e.g. `VERSION="2.18.0-owner-fix.2"`), and re-run the other three lines in §4. `SHA` and `DATE` change with every build.
3. Repeat §4 (build), §5 (test), §6 (push). Always push the version tag **and** `latest`.

Optional: save §4's variable block and build command as a small script (e.g. `~/bin/build-autotask-image.sh`, outside the repo), so you don't retype them.

---

## 10. Checklist

- [x] Docker Engine running in WSL2 Ubuntu; user in `docker` group
- [ ] `docker run --rm hello-world` works
- [ ] `docker-buildx` and `docker-compose-v2` installed (§2.2)
- [ ] Docker Hub repo `islands04/autotask-mcp` created (public)
- [ ] Docker Hub access token created; `docker login -u islands04` succeeded
- [ ] `gh auth refresh -s read:packages` done; `gh auth status` shows the scope
- [ ] Changes committed on the branch being built
- [x] (Recommended) Dockerfile labels updated, §3.4
- [ ] (Recommended) Hardcoded `ARG` defaults in the production stage reset to `"unknown"`, §3.4
- [ ] (Optional) BuildKit secret, §3.3
- [ ] Image built with `--provenance=false` and tagged `islands04/autotask-mcp:<version>` + `:latest`
- [ ] `/health` returns the right version; logs clean
- [ ] `docker history` / `inspect` show no tokens or credentials
- [ ] Both tags pushed and visible on Docker Hub
- [ ] `docker pull islands04/autotask-mcp:latest` works from a clean state
- [ ] No `git push` to `origin` (WYRE-AI) by accident
