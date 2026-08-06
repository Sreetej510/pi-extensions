import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const region = process.env.AWS_REGION ?? "us-east-1";
const profile = process.env.AWS_PROFILE ?? "shipd-fargate";
const bucket = process.env.SHIPD_FARGATE_BUCKET ?? "shipd-checks-882781856085-us-east-1";
const key = `runs/smoke/presign-${Date.now()}.json`;
const credentials = defaultProvider({ profile });
const s3 = new S3Client({ region, credentials });
const body = JSON.stringify({ smoke: true, timestamp: new Date().toISOString() });

try {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }));
  const putUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: "application/json" }),
    { expiresIn: 55 * 60 },
  );
  const put = await fetch(putUrl, { method: "PUT", headers: { "content-type": "application/json" }, body });
  if (!put.ok) throw new Error(`Presigned PUT failed (${put.status}): ${(await put.text()).slice(0, 500)}`);
  const getUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 55 * 60 });
  const get = await fetch(getUrl);
  if (!get.ok) throw new Error(`Presigned GET failed (${get.status}): ${(await get.text()).slice(0, 500)}`);
  if ((await get.text()) !== body) throw new Error("Presigned GET returned the wrong body.");
  console.log("S3 presigned GET/PUT smoke passed.");
} finally {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
  s3.destroy();
}
