import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { DOWNLOAD_URL_SECONDS, UPLOAD_URL_SECONDS, contentDisposition } from './index.js'

// Any S3-compatible object storage (Cloudflare R2, AWS S3, MinIO…). The bucket is
// private: nothing in it can be reached without a URL signed here, and each URL allows
// one kind of request on one object for a few minutes. (An upload URL can be used more
// than once while it lasts: see `claim` in sockets/files.js for why that does no harm.)
export const createS3Storage = ({ endpoint, region = 'auto', bucket, accessKeyId, secretAccessKey }) => {
    const client = new S3Client({
        region,
        ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
        credentials: { accessKeyId, secretAccessKey },
        // By default the SDK adds a checksum to every upload it signs, which the browser
        // would then have to compute and send. Only where the service demands one.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    })

    return {
        // The signature covers the type and the length: the URL uploads that many bytes,
        // declared as that type, and nothing else.
        presignUpload: async ({ key, type, size }) => ({
            url: await getSignedUrl(
                client,
                new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: type, ContentLength: size }),
                { expiresIn: UPLOAD_URL_SECONDS, signableHeaders: new Set(['content-type', 'content-length']) },
            ),
            // (The browser sets Content-Length itself, from the body.)
            headers: { 'Content-Type': type },
        }),

        // The response headers are part of what is signed: a download cannot be turned
        // into something shown in the page by editing the URL.
        presignDownload: ({ key, name, type, inline }) => getSignedUrl(
            client,
            new GetObjectCommand({
                Bucket: bucket, Key: key,
                ResponseContentType: type,
                ResponseContentDisposition: contentDisposition(name, inline),
            }),
            { expiresIn: DOWNLOAD_URL_SECONDS },
        ),

        head: async key => {
            try {
                const found = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
                return { size: found.ContentLength }
            } catch (error) {
                if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) return null
                throw error
            }
        },

        // Within the bucket, by the service itself: the bytes do not come through here.
        copy: async (from, to) => {
            try {
                await client.send(new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: `${bucket}/${from}` }))
                return true
            } catch (error) {
                // Nothing there to copy — under whichever name the service says so. (A bucket
                // that is not there is something else: a fault to be logged, not a missing upload.)
                if (error?.name === 'NoSuchBucket') throw error
                if (error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) return false
                throw error
            }
        },

        // (Deleting what is not there succeeds.)
        remove: async key => {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
        },
    }
}
