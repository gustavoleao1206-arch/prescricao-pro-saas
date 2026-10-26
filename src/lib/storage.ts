import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "./env";
import { randomToken } from "./crypto";

/**
 * Armazenamento privado de documentos.
 *  - driver "local": grava em STORAGE_LOCAL_DIR (fora de /public — nunca indexável).
 *  - driver "s3": interface para S3/R2/MinIO (requer @aws-sdk/client-s3 — ver PENDENCIAS).
 *
 * O acesso a arquivos é sempre mediado por rota autenticada (/api/documentos/[id]/download),
 * que valida o dono/organização e gera acesso temporário. Nunca há URL pública direta.
 */

export interface StoredObject {
  key: string;
  sizeBytes: number;
}

export async function putObject(prefix: string, filename: string, data: Buffer): Promise<StoredObject> {
  const key = `${prefix}/${randomToken(8)}-${sanitize(filename)}`;
  if (env.storage.driver === "s3") {
    await s3Put(key, data);
  } else {
    const full = localPath(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }
  return { key, sizeBytes: data.byteLength };
}

export async function getObject(key: string): Promise<Buffer> {
  if (env.storage.driver === "s3") return s3Get(key);
  return fs.readFile(localPath(key));
}

export async function removeObject(key: string): Promise<void> {
  if (env.storage.driver === "s3") {
    await s3Delete(key);
  } else {
    await fs.rm(localPath(key), { force: true });
  }
}

function localPath(key: string): string {
  const base = path.resolve(env.storage.localDir);
  const full = path.resolve(base, key);
  // Proteção contra path traversal.
  if (!full.startsWith(base)) throw new Error("Chave de armazenamento inválida.");
  return full;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

// --- Driver S3 (S3/R2/MinIO compatível) --------------------------------------
// Usa @aws-sdk/client-s3 via import dinâmico — só é carregado quando
// STORAGE_DRIVER=s3, de modo que a instalação local não exige a dependência.

interface S3ClientLike {
  send: (command: unknown) => Promise<{ Body?: unknown }>;
}
type S3Command = new (input: unknown) => unknown;
let s3Singleton: { client: S3ClientLike; cmds: { Put: S3Command; Get: S3Command; Delete: S3Command } } | null = null;

async function getS3() {
  if (s3Singleton) return s3Singleton;
  const mod = (await import("@aws-sdk/client-s3")) as unknown as {
    S3Client: new (cfg: unknown) => S3ClientLike;
    PutObjectCommand: new (input: unknown) => unknown;
    GetObjectCommand: new (input: unknown) => unknown;
    DeleteObjectCommand: new (input: unknown) => unknown;
  };
  if (!env.storage.bucket) throw new Error("S3_BUCKET não configurado.");
  const client = new mod.S3Client({
    region: env.storage.region || "auto",
    endpoint: env.storage.endpoint || undefined,
    // Necessário para MinIO/R2 e endpoints custom.
    forcePathStyle: Boolean(env.storage.endpoint),
    credentials:
      env.storage.accessKeyId && env.storage.secretAccessKey
        ? { accessKeyId: env.storage.accessKeyId, secretAccessKey: env.storage.secretAccessKey }
        : undefined,
  });
  s3Singleton = {
    client,
    cmds: { Put: mod.PutObjectCommand, Get: mod.GetObjectCommand, Delete: mod.DeleteObjectCommand },
  };
  return s3Singleton;
}

async function s3Put(key: string, data: Buffer): Promise<void> {
  const { client, cmds } = await getS3();
  await client.send(new cmds.Put({ Bucket: env.storage.bucket, Key: key, Body: data, ACL: "private" }));
}

async function s3Get(key: string): Promise<Buffer> {
  const { client, cmds } = await getS3();
  const res = await client.send(new cmds.Get({ Bucket: env.storage.bucket, Key: key }));
  const body = res.Body as AsyncIterable<Uint8Array> | undefined;
  if (!body) throw new Error("Objeto vazio no S3.");
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function s3Delete(key: string): Promise<void> {
  const { client, cmds } = await getS3();
  await client.send(new cmds.Delete({ Bucket: env.storage.bucket, Key: key }));
}
