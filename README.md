# BladeVault Backend

Cloudflare Worker backend for BladeVault with:

- Better Auth for Google sign-in, session cookies, linked account storage, and account deletion
- Cloudflare D1 for shared multi-tenant user data
- Cloudflare R2 for per-user image storage under `users/<userId>/...`

## Architecture

```text
BladeVault App
      |
      v
Cloudflare Worker API
      |
      +--> D1
      +--> R2
      +--> Google OAuth
```

This backend uses one D1 database and one R2 bucket for all users.

- D1 keeps auth tables plus shared app tables keyed by `user_id`
- R2 stores user files in subfolders like `users/<userId>/knives/<knifeId>/...`
- No per-user database or per-user bucket is created

## Endpoints

### Auth

Better Auth is mounted at `/api/auth/*`.

Important routes you will use from the frontend later:

- `POST /api/auth/sign-in/social`
- `GET /api/auth/callback/google`
- `POST /api/auth/sign-out`
- `GET /api/auth/get-session`
- `POST /api/auth/delete-user`

### App API

- `GET /api/health`
- `GET /api/me`
- `GET /api/v1/knives`
- `POST /api/v1/knives`
- `PATCH /api/v1/knives/:id`
- `DELETE /api/v1/knives/:id`
- `GET /api/v1/compare`
- `POST /api/v1/compare`
- `DELETE /api/v1/compare`
- `GET /api/v1/sync/pull`
- `POST /api/v1/sync/push`
- `POST /api/v1/images/upload`
- `POST /api/v1/images/data-url`

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` for your own reference and copy `.dev.vars.example` to `.dev.vars` for local Worker secrets.

3. Update `wrangler.jsonc`:

- replace `database_id`
- replace `database_name` if needed
- replace `bucket_name`
- set your real worker name if you want

4. Apply migrations:

```bash
npx wrangler d1 migrations apply bladevault --local
npx wrangler d1 migrations apply bladevault --remote
```

5. Run locally:

```bash
npm run dev
```

## Deployment notes

- Set Worker secrets with `wrangler secret put`
- Keep D1 and R2 bindings in `wrangler.jsonc`
- Better Auth Infrastructure dashboard requires a separate `BETTER_AUTH_API_KEY`; do not reuse that value as `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL` should be the deployed Worker URL or your custom API domain
- Add Google OAuth secrets as Worker secrets:
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
- Configure the Google OAuth redirect URI as:
  - `https://api-staging.tkweb.site/api/auth/callback/google`
- `CORS_ORIGIN` and `FRONTEND_URL` can be a comma-separated list of frontend origins or wildcard localhost patterns, for example `https://app-staging.bladevault.tkweb.site,http://localhost:*,http://127.0.0.1:*`
- `R2_PUBLIC_BASE_URL` should be the public URL for your bucket or custom domain

## Managing Wrangler and future deploys

Treat `wrangler.jsonc` as the source of truth for non-secret Worker config in this repo.

- Keep non-sensitive values in `vars`, such as `BETTER_AUTH_URL`, `CORS_ORIGIN`, `FRONTEND_URL`, and `R2_PUBLIC_BASE_URL`
- Keep sensitive values out of `wrangler.jsonc`; manage them as Cloudflare Worker secrets instead
- This project already declares required secrets in `wrangler.jsonc`, so deploys fail early if one is missing

### 1. Check Wrangler auth

Before changing secrets or deploying, confirm Wrangler is authenticated:

```bash
npx wrangler whoami
```

If needed, log in:

```bash
npx wrangler login
```

### 2. Update the Wrangler CLI version

Wrangler is installed locally in this project through `devDependencies`. To upgrade it later:

```bash
npm install -D wrangler@latest
```

Then verify the installed version:

```bash
npx wrangler --version
```

Commit `package.json` and `package-lock.json` together when you intentionally upgrade Wrangler.

### 3. If you changed only application code

Deploy the latest Worker code:

```bash
npm run deploy
```

That runs:

```bash
wrangler deploy
```

### 4. If you changed a secret or API key

Examples: `BETTER_AUTH_SECRET`, `BETTER_AUTH_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

Update the secret in Cloudflare:

```bash
npx wrangler secret put BETTER_AUTH_API_KEY
```

Wrangler will prompt you for the new value. Repeat for any other secret you rotate.

Important:

- `wrangler secret put` deploys the Worker immediately with the updated secret
- Updating a deployed secret does not update your local `.dev.vars`; if you also run locally, update `.dev.vars` separately
- If you need to remove a secret, use `npx wrangler secret delete SECRET_NAME`

### 5. If you changed non-secret Worker config

Examples:

- `BETTER_AUTH_URL`
- `CORS_ORIGIN`
- `FRONTEND_URL`
- `R2_PUBLIC_BASE_URL`
- D1 binding values
- R2 binding values
- Worker name

Update `wrangler.jsonc`, then deploy:

```bash
npm run deploy
```

### 6. If you changed both code and secrets

Use this order:

```bash
npx wrangler secret put SECRET_NAME
npm run deploy
```

This makes sure both the secret and the latest code are live.

### 7. Local development secrets

For local development, keep secrets in `.dev.vars` and do not commit that file.

- Use `.dev.vars.example` as the template
- If you define `.dev.vars`, Wrangler uses that for local secrets
- Keep deployed secrets and local secrets in sync manually when you rotate credentials

### 8. Recommended quick deploy checklist

```bash
npx wrangler whoami
npm run typecheck
npm run deploy
```

If the change includes a rotated API key or OAuth secret, run `npx wrangler secret put ...` before the final deploy.

## Sync shape

`POST /api/v1/sync/push` accepts:

```json
{
  "knives": [],
  "replaceAll": false
}
```

When `replaceAll` is `true`, the backend deletes remote knives that are missing from the incoming snapshot for that user.

Include `compareIds` only when you want to replace the remote compare list.

Images can be:

- existing public URLs
- external URLs
- `data:image/...` URLs

Any `data:image/...` payload is uploaded to R2 automatically before the record is stored in D1.
