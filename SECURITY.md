# Security

## Build-Time Tokens

ESA runtime environment variables are not available to this edge function, so private access tokens are injected at build time by `tools/inline-static.mjs`.

Use:

```bash
SPEEDTEST_TOKEN='<base64url-random-43-chars-or-longer>' npm run build:edge
```

or:

```bash
SPEEDTEST_TOKENS='<token-a>,<token-b>' npm run build:edge
```

Do not use `VITE_` for private tokens. Vite exposes `VITE_` variables to frontend code.

## Public Repository Rules

Never commit:

- `.env` or local environment files.
- `dist/`.
- `dist-edge/`.
- Any generated `edge.js` that contains embedded deployment tokens.
- Real app tokens, ESA credentials, access keys, cookies, or private endpoints.

Before pushing to a public repository, run:

```bash
npm run scan:privacy
```

## Token Rotation

Recommended rotation sequence:

1. Build with both old and new tokens using `SPEEDTEST_TOKENS`.
2. Release the app update that sends the new token.
3. Rebuild ESA with only the new token.
4. Delete any old local build artifacts that may contain the old token.
