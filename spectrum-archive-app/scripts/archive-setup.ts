// `npm run archive:setup` — make the S3 bucket safe and cheap before first use:
//   1. create it if missing
//   2. block all public access
//   3. default encryption SSE-S3 (AES256), so DuckDB's uploads are encrypted
//      without the app asking for it
//   4. a lifecycle rule expiring everything under S3_PREFIX after
//      ARCHIVE_EXPIRE_DAYS, plus cleanup of abandoned multipart uploads
// Safe to re-run. Use the admin credentials (iam-admin-policy.json) for this.
import {
  type BucketLocationConstraint,
  CreateBucketCommand,
  GetBucketLifecycleConfigurationCommand,
  HeadBucketCommand,
  type LifecycleRule,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";

import { archiveExpireDays, archiveMode, awsRegion, s3Bucket, s3Prefix } from "../src/env.ts";
import { makeS3Client } from "../src/archive/s3.ts";

const RULE_ID = "spectrum-archive-expire";

if (!s3Bucket) {
  console.error("S3_BUCKET is blank in .env, so there is nothing to set up: the app archives to local Parquet.");
  process.exit(1);
}
if (archiveMode === "off") {
  console.log("Note: ARCHIVE_DIR=off, so the app will not write to this bucket until you change that.");
}

const bucket = s3Bucket;
const s3 = makeS3Client();
const status = (error: unknown) =>
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

// 1. Bucket
try {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`✓ bucket ${bucket} exists`);
} catch (error) {
  if (status(error) === 404) {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        // us-east-1 is the one region that rejects an explicit LocationConstraint.
        ...(awsRegion === "us-east-1"
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: awsRegion as BucketLocationConstraint } }),
      }),
    );
    console.log(`✓ created bucket ${bucket} in ${awsRegion}`);
  } else if (status(error) === 403) {
    console.error(
      `Bucket ${bucket} exists but these credentials cannot access it (403). ` +
        "Either it belongs to another account (bucket names are global) or the admin policy is missing s3:ListBucket.",
    );
    process.exit(1);
  } else {
    throw error;
  }
}

// 2. Public access
await s3.send(
  new PutPublicAccessBlockCommand({
    Bucket: bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  }),
);
console.log("✓ all public access blocked");

// 3. Default encryption
await s3.send(
  new PutBucketEncryptionCommand({
    Bucket: bucket,
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
    },
  }),
);
console.log("✓ default encryption: SSE-S3 (AES256)");

// 4. Lifecycle. PUT replaces the whole configuration, so keep any rules that
// aren't ours rather than silently deleting them.
let existing: LifecycleRule[] = [];
try {
  const current = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
  existing = (current.Rules ?? []).filter((rule) => rule.ID !== RULE_ID);
} catch (error) {
  if ((error as { name?: string }).name !== "NoSuchLifecycleConfiguration") throw error;
}

const prefix = s3Prefix ? `${s3Prefix}/` : "";
await s3.send(
  new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: {
      Rules: [
        ...existing,
        {
          ID: RULE_ID,
          Status: "Enabled",
          Filter: { Prefix: prefix },
          Expiration: { Days: archiveExpireDays },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        },
      ],
    },
  }),
);
console.log(
  `✓ lifecycle: objects under s3://${bucket}/${prefix} expire after ${archiveExpireDays} day(s)` +
    (existing.length > 0 ? ` (kept ${existing.length} other rule(s))` : ""),
);

console.log(`\nReady. The app will write to s3://${bucket}/${prefix}messages/ — run \`npm start\`.`);
