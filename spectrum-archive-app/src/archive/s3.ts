// AWS SDK helpers for the operational scripts (setup, compact, teardown).
// The running app never uses these: its S3 reads and writes go through DuckDB.
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { rmSync } from "node:fs";

import { awsAccessKeyId, awsRegion, awsSecretAccessKey, awsSessionToken } from "../env.ts";

export function makeS3Client(): S3Client {
  return new S3Client({
    region: awsRegion,
    // Blank keys → the SDK's default chain (AWS_PROFILE, SSO, instance role).
    ...(awsAccessKeyId && awsSecretAccessKey
      ? {
          credentials: {
            accessKeyId: awsAccessKeyId,
            secretAccessKey: awsSecretAccessKey,
            ...(awsSessionToken ? { sessionToken: awsSessionToken } : {}),
          },
        }
      : {}),
  });
}

export function parseS3Url(url: string): { bucket: string; key: string } {
  const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url);
  if (!match) throw new Error(`not an s3:// URL: ${url}`);
  return { bucket: match[1]!, key: match[2] ?? "" };
}

/** Delete archive files by path: s3:// URLs through the SDK, local paths with fs. */
export async function deleteFiles(paths: readonly string[]): Promise<void> {
  const local = paths.filter((path) => !path.startsWith("s3://"));
  for (const path of local) rmSync(path, { force: true });

  const remote = paths.filter((path) => path.startsWith("s3://")).map(parseS3Url);
  if (remote.length === 0) return;

  const s3 = makeS3Client();
  const byBucket = new Map<string, string[]>();
  for (const { bucket, key } of remote) byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), key]);

  for (const [bucket, keys] of byBucket) {
    for (let i = 0; i < keys.length; i += 1000) {
      const result = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (result.Errors && result.Errors.length > 0) {
        throw new Error(`S3 refused to delete ${result.Errors.length} object(s): ${result.Errors[0]?.Message ?? "unknown"}`);
      }
    }
  }
}
