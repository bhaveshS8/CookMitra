# Secret rotation & history purge (P0-1 / P0-2)

A real `JWT_SECRET` was previously hardcoded in the tracked `Jenkinsfile`
(and live DB credentials existed in local `.env` files). Treat the old
JWT secret as **COMPROMISED**: anyone who ever cloned the repo, viewed CI
logs, or received a workspace copy can forge session JWTs (including admin)
until it is replaced everywhere.

`Jenkinsfile` no longer contains any secret — CI fails fast when `.env` /
`JWT_SECRET` / `MONGODB_URI` are missing. The steps below finish the rotation.

## 1. Rotate the JWT secret (do this FIRST)

```bash
# On the production server / deploy host (values never printed):
node backend/scripts/rotate-secrets.js --write /home/ubuntu/CookMitra/.env
# — or paste a fresh value generated via `openssl rand -hex 48` —
# then mirror the SAME value into every other env store:
#   Render dashboard → Environment → JWT_SECRET
#   any additional hosts / Jenkins credentials
```

Then **restart the API on ALL instances** (old tokens stop verifying at once;
users simply log in again). Verify: log in → `GET /api/auth/me` → 200.

## 2. Rotate the database credentials (Atlas)

1. Atlas → Database Access → edit the app user → new password
   (URL-encode `@ : / ? #` in the connection string).
2. Update `MONGODB_URI` in the same env stores as above. Restart. Verify
   `/api/health` reports `db: connected`.
3. Confirm old password no longer connects, then delete any shared copies.

## 3. Purge the compromised secret from git history

Deleting the line from the working tree is NOT enough — it lives in past
commits. Coordinate a flag day (all clones re-clone afterwards):

```bash
# Option A — git-filter-repo (recommended):
pip install git-filter-repo
git clone --mirror <repo-url> repo-mirror && cd repo-mirror
git filter-repo --replace-text <(printf 'JWT_SECRET==>***REMOVED***\n') --force
git filter-repo --strip-blobs-bigger-than 50M --force   # optional hygiene
git push --force --all && git push --force --tags

# Option B — BFG Repo-Cleaner:
bfg --replace-text secrets.txt repo.git   # secrets.txt: JWT_SECRET==>***REMOVED***
cd repo.git && git reflog expire --expire=now --all && git gc --prune=now --aggressive
git push --force --all && git push --force --tags
```

Then: rotate once more (history may have been copied), revoke exposed
credentials in Jenkins build history, and confirm with:

```bash
git log --all -S 'JWT_SECRET=1b30' --oneline          # must be empty
git log --all -G 'mongodb(\+srv)?://[^ ]*:[^ @]+@' --oneline  # must be empty
git ls-files | grep -E '(^|/)\.env$'                  # must be empty
```

## 4. Ongoing rules

- `.env` files are gitignored (`*.env`, `.env`, `.env.local`, `.env.production`)
  and must never be committed, logged (`cat`), or copied into artifacts.
- CI validates presence/strength and fails fast; it never prints values.
- Razorpay/SMTP/Google values stay in env stores, never in tracked files.
