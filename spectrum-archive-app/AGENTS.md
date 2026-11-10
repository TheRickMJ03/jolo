# spectrum-archive-app — agent instructions

A temporary [Spectrum](https://photon.codes/docs/spectrum-ts) app pinned to
`spectrum-ts@12.11.0`, ported from the test app's PORTING-GUIDE.md, plus a
Parquet archive (local or S3) and a small query/send API.

## Working in this project

- Run with `npm start`; test with `npm test` (no network or credentials needed); typecheck with `npm run typecheck`.
- `src/env.ts` is the only module that reads `process.env`, and `src/index.ts` imports it **first**, before `spectrum-ts`.
- `src/respond.ts` is the single reply path for both the stream and the webhook. Keep its guards in order: outbound echo → signal → dedupe → archive → reply.
- Every outbound send goes through `sendAndArchive` in `src/archive/send.ts`. Don't call `space.send` directly, or that message won't be archived.
- The archive schema lives only in `src/archive/schema.ts`. The archive is append-only: never rewrite a Parquet file to update a row.
- All DuckDB values from API callers or the model must be bind parameters.

## Environment

This project reads secrets from `.env` (gitignored). **Do not read, write, or echo `.env`**: it contains credentials (Photon project secret, bot tokens, AWS keys, API key).

If startup fails with an authentication error, tell the user to verify their `PROJECT_ID` / `PROJECT_SECRET` at the [Photon dashboard](https://app.photon.codes).

Never run `archive:setup`, `archive:teardown` or anything else against real AWS, Photon, Telegram or WhatsApp unless the user asks you to.

## See also

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- [`spectrum-ts` on GitHub](https://github.com/photon-hq/spectrum-ts)
