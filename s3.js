import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

export async function deleteFromS3(client, bucket, key) {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function getPresignedUrl(client, bucket, key, expiresIn = 3600) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}
