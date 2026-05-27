# Releasing VoltrisAi

How to ship a new version of the desktop app. Builds run on GitHub
Actions; you only run two commands locally per release.

---

## One-time setup

Done once, then never again. Steps marked **[YOU]** are things you do
manually outside this repo.

### 1. Create a GitHub repo **[YOU]**

Go to [github.com/new](https://github.com/new) and create a repo for
this project. Private is fine — auto-update reads from the releases
endpoint which is public-readable regardless of repo visibility.

Name it something like `voltrisai` or whatever you want.

### 2. Match the updater endpoint to your repo

Edit `src-tauri/tauri.conf.json` and update the `endpoints` field under
`plugins.updater` to:

```text
https://github.com/<your-username>/<your-repo>/releases/latest/download/latest.json
```

### 3. Link this folder to GitHub **[YOU]**

In Terminal from this folder:

```bash
git remote add origin git@github.com:<your-username>/<your-repo>.git
git branch -M main
git add .
git commit -m "Initial commit"
git push -u origin main
```

(If you use HTTPS instead of SSH, swap `git@github.com:` for `https://github.com/`.)

### 4. Set GitHub Actions secrets **[YOU]**

In your GitHub repo: **Settings → Secrets and variables → Actions →
New repository secret**. Add these four:

| Secret name                          | Value                                                                |
| ------------------------------------ | -------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Output of `cat ~/.tauri/voltrisai.key` (the full multi-line contents) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Empty value (we used no password) — but the secret must exist        |
| `VITE_SUPABASE_URL`                  | Value from your `.env.local`                                          |
| `VITE_SUPABASE_PUBLISHABLE_KEY`      | Value from your `.env.local`                                          |

After this, every tagged release auto-builds and publishes.

---

## Shipping a new version (the whole flow)

```bash
# 1. Bump the version in BOTH files:
#    - src-tauri/tauri.conf.json  ("version")
#    - package.json               ("version")
#    Example: "0.1.0" → "0.1.1"

# 2. Commit + push the bump
git add -A
git commit -m "Release v0.1.1"
git push

# 3. Tag and push the tag — this is what triggers the release workflow
git tag v0.1.1
git push origin v0.1.1
```

That's it. GitHub Actions takes ~15-20 minutes to:

1. Build the Apple Silicon `.dmg`
2. Build the Intel `.dmg`
3. Sign both with your private key
4. Create a GitHub Release tagged `v0.1.1`
5. Upload both `.dmg`s, both `.app.tar.gz` archives, both signatures
6. Write and upload `latest.json` pointing at all of it

While it's running, you can watch it under your repo's **Actions** tab.

Once the workflow finishes, **every installed copy of VoltrisAi**
will see the new version on next launch and offer to update.

---

## Distributing the first version (initial install)

The auto-updater only kicks in for users who already have the app
installed. For new users you still need to share the `.dmg` directly:

- Go to your repo's **Releases** page
- Pick the version you want to share
- Copy the link to the `.dmg` asset (aarch64 for Apple Silicon, x64
  for Intel)
- Send them that link

Friend installs it once; from that point on, every future release
reaches them automatically inside the app.

---

## Things to never do

- **Don't lose `~/.tauri/voltrisai.key`.** Without it you can't sign
  updates, and existing installs will reject any update you publish.
  Back it up somewhere safe (1Password, encrypted USB, etc.).
- **Don't change the public key in `tauri.conf.json`** without doing
  a full reinstall on every device — installed copies pin to the
  original public key.
- **Don't commit the private key.** It's outside the repo
  (`~/.tauri/`) by default — keep it there.

---

## Troubleshooting

**The Actions workflow failed.** Open the Actions tab on GitHub and
look at the failed step. Most common causes:

- Missing one of the four secrets above
- Forgot to update the endpoint in `tauri.conf.json` to your real repo
- Tag name doesn't match `v*.*.*` (e.g. you used `0.1.1` instead of `v0.1.1`)

**Users aren't getting the update.** Check:

1. Did the workflow finish successfully? The release on GitHub should
   have a `latest.json` asset attached.
2. Open the release page in a browser at
   `https://github.com/<user>/<repo>/releases/latest/download/latest.json`
   — does it return the JSON manifest? If 404, the manifest wasn't
   uploaded.
3. The user's installed copy needs to have been built **after** the
   updater plugin was added. If they're on an older build, they have
   to do a manual reinstall once.

**Need to publish a manual fix without re-running the build.** Edit
`latest.json` directly on the release's "Edit assets" page and replace
its contents. Don't change `version` unless you also bump it in
`tauri.conf.json`.
