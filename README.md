# BladeVault Backend

Cloudflare Worker backend for BladeVault with:

- Better Auth for account creation, login, session cookies, email verification, password reset, and account deletion
- Cloudflare D1 for shared multi-tenant user data
- Cloudflare R2 for per-user image storage under `users/<userId>/...`
- Resend for transactional email

## Architecture

```text
BladeVault App
      |
      v
Cloudflare Worker API
      |
      +--> D1
      +--> R2
      +--> Resend
```

This backend uses one D1 database and one R2 bucket for all users.

- D1 keeps auth tables plus shared app tables keyed by `user_id`
- R2 stores user files in subfolders like `users/<userId>/knives/<knifeId>/...`
- No per-user database or per-user bucket is created

## Endpoints

### Auth

Better Auth is mounted at `/api/auth/*`.

Important routes you will use from the frontend later:

- `POST /api/auth/sign-up/email`
- `POST /api/auth/sign-in/email`
- `POST /api/auth/sign-out`
- `GET /api/auth/get-session`
- `POST /api/auth/send-verification-email`
- `GET /api/auth/verify-email`
- `POST /api/auth/request-password-reset`
- `POST /api/auth/reset-password`
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
- `BETTER_AUTH_URL` should be the deployed Worker URL or your custom API domain
- `CORS_ORIGIN` and `FRONTEND_URL` should point to your BladeVault frontend origin
- `R2_PUBLIC_BASE_URL` should be the public URL for your bucket or custom domain

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
