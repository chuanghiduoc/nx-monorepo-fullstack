import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const MAX_NAME = 255;

/**
 * How the caller intends to upload.
 *
 * The choice is theirs and getting it wrong is expensive, which is why it is
 * explicit rather than inferred from a size the caller also chose:
 *
 * - `put` — one request, no bound on what arrives. For a server.
 * - `post` — a browser form whose policy bounds the size at the store's edge.
 * - `multipart` — the only shape that survives a dropped connection.
 */
const uploadShape = z.enum(['put', 'post', 'multipart']);

const requestUploadSchema = z
  .object({
    fileName: z.string().min(1).max(MAX_NAME),
    /**
     * What the caller says it is. Recorded, and it decides nothing: the
     * scanner reads the bytes, and a mismatch is what `REJECTED` is for.
     */
    contentType: z.string().min(1).max(MAX_NAME),
    shape: uploadShape.default('post'),
    /** Only for `multipart`, and required there. */
    partCount: z.number().int().positive().max(10_000).optional(),
  })
  .refine(
    (body) => body.shape !== 'multipart' || body.partCount !== undefined,
    { message: 'A multipart upload needs partCount.' },
  );

export class RequestUploadDto extends createZodDto(requestUploadSchema) {}

// Every nullable branch carries a constraint or a description, so the OpenAPI
// document emits `anyOf` rather than collapsing the two types into an array —
// which the workspace's own assertion refuses, because a collapsed nullable
// generates a client type that cannot distinguish "absent" from "null".
const fileSchema = z.object({
  id: z.uuidv7(),
  fileName: z.string().max(255),
  declaredType: z.string().max(255),
  detectedType: z
    .string()
    .max(255)
    .nullable()
    .describe('What the bytes actually are; null until the scanner has looked.'),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe('What the store reported, never what the caller claimed.'),
  status: z.enum([
    'PENDING',
    'UPLOADED',
    'SCANNING',
    'READY',
    'REJECTED',
    'QUARANTINED',
  ]),
  /** Why it ended where it did, for the two states that are terminal. */
  reason: z
    .string()
    .max(512)
    .nullable()
    .describe('Why a rejected or quarantined file ended there.'),
  createdAt: z.iso.datetime(),
});

const uploadTicketSchema = z.object({
  file: fileSchema,
  shape: uploadShape,
  /** Where to send the bytes. Absent for `multipart`, which has parts. */
  url: z.string().optional(),
  /** The form fields a `post` must include, policy and all. */
  fields: z.record(z.string(), z.string()).optional(),
  /** For `multipart`: the id to complete with, and a URL per part. */
  uploadId: z.string().optional(),
  parts: z
    .array(z.object({ partNumber: z.number().int(), url: z.string() }))
    .optional(),
  expiresAt: z.iso.datetime(),
});

export class UploadTicketDto extends createZodDto(uploadTicketSchema) {}

const completeUploadSchema = z
  .object({
    /**
     * Only for `multipart`: the id from the ticket.
     *
     * Sent back rather than stored, and that is deliberate. An upload id
     * belongs to an upload in progress; a column holding one would outlive the
     * upload and be wrong for the rest of the file's life — and it would be a
     * second place for the same fact to be wrong.
     */
    uploadId: z.string().min(1).optional(),
    /** Only for `multipart`: what the store returned for each part. */
    parts: z
      .array(
        z.object({
          partNumber: z.number().int().positive(),
          etag: z.string().min(1),
        }),
      )
      .optional(),
  })
  .refine(
    (body) =>
      (body.uploadId === undefined) === (body.parts === undefined),
    {
      message:
        'A multipart completion needs both uploadId and parts, or neither.',
    },
  );

export class CompleteUploadDto extends createZodDto(completeUploadSchema) {}

export class FileDto extends createZodDto(fileSchema) {}

const fileListSchema = z.object({ items: z.array(fileSchema) });

export class FileListDto extends createZodDto(fileListSchema) {}

const downloadSchema = z.object({
  url: z.string(),
  expiresAt: z.iso.datetime(),
});

export class DownloadDto extends createZodDto(downloadSchema) {}
