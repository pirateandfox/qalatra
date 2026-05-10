// Attachment storage helpers for S3-compatible providers (e.g., Cloudflare R2).
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Returns null when the endpoint or either credential is missing so callers can short-circuit gracefully.
export function getS3Client(settings) {
  const { s3Endpoint, s3AccessKey, s3SecretKey } = settings;
  if (!s3Endpoint || !s3AccessKey || !s3SecretKey) return null;
  return new S3Client({
    region: 'auto',
    endpoint: s3Endpoint,
    credentials: { accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey },
    forcePathStyle: true,
  });
}

// Backup client uses same credentials but strips any bucket path from the endpoint
// so it can target a different bucket (qalatra-backups).
export function getBackupS3Client(settings) {
  const { s3Endpoint, s3AccessKey, s3SecretKey, backupBucket } = settings;
  if (!s3Endpoint || !s3AccessKey || !s3SecretKey || !backupBucket) return null;
  let endpoint = s3Endpoint;
  try {
    const u = new URL(s3Endpoint);
    endpoint = `${u.protocol}//${u.host}`;
  } catch {}
  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey },
    forcePathStyle: true,
  });
}

function contentTypeWithCharset(mimetype) {
  if (!mimetype) return 'application/octet-stream';
  if (mimetype.startsWith('text/') && !mimetype.includes('charset')) {
    return `${mimetype}; charset=utf-8`;
  }
  return mimetype;
}

export async function uploadToS3(client, bucket, key, buffer, mimetype) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentTypeWithCharset(mimetype),
  }));
}

export async function downloadFromS3(client, bucket, key) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function listS3Objects(client, bucket, prefix = '') {
  const results = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const obj of res.Contents ?? []) results.push(obj);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return results;
}

export async function deleteFromS3(client, bucket, key) {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function getPresignedUrl(client, bucket, key, expiresIn = 3600) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}
