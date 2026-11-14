// `npm run archive:teardown -- --yes` — delete the archive.
//
// S3 mode: deletes every object (and object version) under S3_PREFIX, then
// deletes the bucket if that left it empty. If the bucket holds anything else,
// the bucket is kept: this script never deletes data it didn't write.
// Local mode: deletes {ARCHIVE_DIR}/messages and the spool file.
//
// Without --yes it only says what it would delete. Use the admin credentials
// (iam-admin-policy.json) for the S3 case.
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  type ObjectIdentifier,
} from "@aws-sdk/client-s3";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { archiveRoot, archiveSpoolDir, s3Bucket, s3Prefix } from "../src/env.ts";
import { makeS3Client } from "../src/archive/s3.ts";

const confirmed = process.argv.includes("--yes");

const REMINDER = `
Still running outside this script — delete these yourself when you are done:
  • Photon / Spectrum Cloud project (https://app.photon.codes): delete the project,
    or rotate PROJECT_SECRET, and remove the webhook URL you registered there.
  • Telegram bot: @BotFather → /deletebot (or /revoke to kill the token).
  • WhatsApp Business (Meta for Developers): the app, its test/phone number,
    the webhook subscription and the access token.
  • AWS IAM: the users/roles and access keys you made from iam-policy.json and
    iam-admin-policy.json (this script does not touch IAM).
  • Local files: .env, data/ (memory.json, spool), node_modules/.`;

if (s3Bucket) {
  const bucket = s3Bucket;
  const prefix = s3Prefix ? `${s3Prefix}/` : "";
  const s3 = makeS3Client();

  // Versions cover both unversioned objects (VersionId "null") and any
  // versions/delete markers, should versioning ever have been switched on.
  async function* versionsUnder(listPrefix: string, max?: number) {
    let KeyMarker: string | undefined;
    let VersionIdMarker: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectVersionsCommand({ Bucket: bucket, Prefix: listPrefix, KeyMarker, VersionIdMarker, MaxKeys: max }),
      );
      const ids: ObjectIdentifier[] = [
        ...(page.Versions ?? []).map((v) => ({ Key: v.Key!, VersionId: v.VersionId })),
        ...(page.DeleteMarkers ?? []).map((m) => ({ Key: m.Key!, VersionId: m.VersionId })),
      ];
      if (ids.length > 0) yield ids;
      if (max !== undefined) return;
      KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (KeyMarker);
  }

  if (!confirmed) {
    let count = 0;
    for await (const ids of versionsUnder(prefix)) count += ids.length;
    console.log(
      `Would delete ${count} object version(s) under s3://${bucket}/${prefix}, then the bucket ${bucket} if it is then empty.\n` +
        "Re-run with --yes to do it: npm run archive:teardown -- --yes",
    );
    if (!prefix) console.log("Warning: S3_PREFIX is blank, so that is EVERYTHING in the bucket.");
    process.exit(1);
  }

  let deleted = 0;
  for await (const ids of versionsUnder(prefix)) {
    for (let i = 0; i < ids.length; i += 1000) {
      const result = await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: ids.slice(i, i + 1000), Quiet: true } }),
      );
      if (result.Errors && result.Errors.length > 0) {
        console.error(`S3 refused ${result.Errors.length} delete(s): ${result.Errors[0]?.Message ?? "unknown"}`);
        process.exit(1);
      }
      deleted += Math.min(1000, ids.length - i);
    }
  }
  console.log(`✓ deleted ${deleted} object version(s) under s3://${bucket}/${prefix}`);

  const leftObjects = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
  let leftVersions = false;
  for await (const _ of versionsUnder("", 1)) leftVersions = true;

  if ((leftObjects.KeyCount ?? 0) > 0 || leftVersions) {
    console.log(`Bucket ${bucket} still holds objects outside ${prefix || "the prefix"}, so it was kept.`);
  } else {
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    console.log(`✓ deleted bucket ${bucket}`);
  }
} else {
  const messagesDir = join(archiveRoot, "messages");
  const spoolFile = join(archiveSpoolDir, "messages.jsonl");
  const targets = [messagesDir, spoolFile, `${spoolFile}.tmp`].filter((path) => existsSync(path));

  if (!confirmed) {
    console.log(
      targets.length > 0
        ? `Would delete:\n${targets.map((path) => `  ${path}`).join("\n")}\nRe-run with --yes: npm run archive:teardown -- --yes`
        : "No local archive files found; nothing to delete.",
    );
    process.exit(targets.length > 0 ? 1 : 0);
  }
  for (const path of targets) {
    rmSync(path, { recursive: true, force: true });
    console.log(`✓ deleted ${path}`);
  }
  if (targets.length === 0) console.log("No local archive files found; nothing to delete.");
  console.log("Stop the app first if it is running: it still holds unflushed rows in memory.");
}

console.log(REMINDER);
