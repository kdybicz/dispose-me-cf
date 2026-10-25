import type { Buffer } from 'node:buffer';
import {
  type AttachmentDetails,
  type EmailAddress,
  EmailParser,
  isInlineImageType,
  type ParsedEmail,
  restoreEmailAddress,
} from './EmailParser';
import { type EmailGeneration, EmailPartsDatabase } from './EmailPartsDatabase';
import type { Env } from './env';
import {
  type EmailObject,
  type EmailObjectStream,
  EmailReadLimitError,
  R2FileSystem,
} from './R2FileSystem';

export const EMAIL_STORAGE_VERSION = 1;

type StoredAddress = Omit<EmailAddress, 'format'>;
interface StoredPart extends Omit<AttachmentDetails, 'content'> {
  storageIndex: number;
}
interface StoredInlinePart extends StoredPart {
  part: number;
  contentId?: string;
}

interface EmailManifest {
  version: number;
  id: string;
  generation: string;
  expiresAt: number;
  rawBytes: number;
  from: StoredAddress | null;
  to: StoredAddress[];
  cc: StoredAddress[];
  bcc: StoredAddress[];
  subject: string;
  received: string;
  attachments: StoredPart[];
  inlineParts: StoredInlinePart[];
}

export interface EmailStoreDependencies {
  fileSystem: Pick<
    R2FileSystem,
    | 'getObject'
    | 'readObject'
    | 'putRawObject'
    | 'putObject'
    | 'getJsonObject'
    | 'getObjectStream'
    | 'deletePrefixBatch'
  >;
  index: Pick<
    EmailPartsDatabase,
    'findReady' | 'reserve' | 'publish' | 'invalidate' | 'listExpired' | 'deleteExpired'
  >;
  parser: Pick<EmailParser, 'parseEmail'>;
  ttlSeconds: number;
  now?: () => number;
}

export interface StoredEmailPart extends EmailObjectStream {
  filename?: string;
  contentType: string;
}

const prefix = (generation: EmailGeneration): string =>
  `parsed/v${generation.Version}/${generation.Id}/${generation.Generation}/`;

const partMetadata = ({ filename, size, contentType }: StoredPart): AttachmentDetails => ({
  filename,
  size,
  contentType,
});

const restoreMetadata = (manifest: EmailManifest): Omit<ParsedEmail, 'body'> => ({
  from: manifest.from ? restoreEmailAddress(manifest.from) : null,
  to: manifest.to.map(restoreEmailAddress),
  cc: manifest.cc.map(restoreEmailAddress),
  bcc: manifest.bcc.map(restoreEmailAddress),
  subject: manifest.subject,
  received: new Date(manifest.received),
  attachments: manifest.attachments.map(partMetadata),
  inlineParts: manifest.inlineParts.map((part) => ({
    ...partMetadata(part),
    part: part.part,
    contentId: part.contentId,
  })),
});

/** Private, rebuildable derived data. Callers must establish inbox membership before reading. */
export class EmailStore {
  private now: () => number;

  constructor(private dependencies: EmailStoreDependencies) {
    if (!Number.isFinite(dependencies.ttlSeconds) || dependencies.ttlSeconds <= 0) {
      throw new Error('Email storage retention must be positive');
    }
    this.now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async receive(id: string, raw: Buffer): Promise<Omit<ParsedEmail, 'body'>> {
    const source = await this.dependencies.fileSystem.putRawObject(id, raw);
    return restoreMetadata((await this.ensure(id, undefined, source)).manifest);
  }

  async getEmail(
    id: string,
    maxRawBytes?: number,
  ): Promise<{ email: ParsedEmail; rawBytes: number }> {
    const { manifest, generation } = await this.ensure(id, maxRawBytes);
    const body = await this.dependencies.fileSystem.getObject(`${prefix(generation)}body`);
    return {
      email: { ...restoreMetadata(manifest), body: body.toString() },
      rawBytes: manifest.rawBytes,
    };
  }

  async getInlineImage(id: string, part: number): Promise<StoredEmailPart | undefined> {
    const { manifest, generation } = await this.ensure(id);
    const image = manifest.inlineParts.find((image) => image.part === part);
    if (!image || !isInlineImageType(image.contentType)) return undefined;
    return this.openPart(generation, image);
  }

  async getAttachment(id: string, filename: string): Promise<StoredEmailPart | undefined> {
    const { manifest, generation } = await this.ensure(id);
    const attachment = manifest.attachments.find((attachment) => attachment.filename === filename);
    return attachment ? this.openPart(generation, attachment) : undefined;
  }

  async cleanupExpired(): Promise<void> {
    const now = this.now();
    for (const generation of await this.dependencies.index.listExpired(now)) {
      if (await this.dependencies.fileSystem.deletePrefixBatch(prefix(generation))) {
        await this.dependencies.index.deleteExpired(generation, now);
      }
    }
  }

  private async openPart(generation: EmailGeneration, part: StoredPart): Promise<StoredEmailPart> {
    const object = await this.dependencies.fileSystem.getObjectStream(
      `${prefix(generation)}parts/${part.storageIndex}`,
    );
    return { ...object, filename: part.filename, contentType: part.contentType };
  }

  private async ensure(
    id: string,
    maxRawBytes?: number,
    source?: EmailObject,
  ): Promise<{
    manifest: EmailManifest;
    generation: EmailGeneration;
  }> {
    const { fileSystem, index } = this.dependencies;
    const generation = await index.findReady(id, EMAIL_STORAGE_VERSION, this.now());
    if (generation) {
      const manifest = await fileSystem.getJsonObject<EmailManifest>(
        `${prefix(generation)}manifest.json`,
      );
      if (
        manifest &&
        manifest.version === EMAIL_STORAGE_VERSION &&
        manifest.id === id &&
        manifest.generation === generation.Generation &&
        manifest.expiresAt === generation.ExpireAt
      ) {
        if (maxRawBytes !== undefined && manifest.rawBytes > maxRawBytes)
          throw new EmailReadLimitError();
        return { manifest, generation };
      }
      await index.invalidate(generation);
    }
    const raw = source ?? (await fileSystem.readObject(id, maxRawBytes));
    return this.convert(id, raw);
  }

  private async convert(
    id: string,
    source: EmailObject,
  ): Promise<{
    manifest: EmailManifest;
    generation: EmailGeneration;
  }> {
    const { fileSystem, index, parser, ttlSeconds } = this.dependencies;
    const generation: EmailGeneration = {
      Id: id,
      Version: EMAIL_STORAGE_VERSION,
      Generation: crypto.randomUUID(),
      ExpireAt: Math.floor(source.uploaded.getTime() / 1000) + Math.floor(ttlSeconds),
    };
    const assertUnexpired = () => {
      if (generation.ExpireAt <= this.now()) throw new Error('Email source retention has expired');
    };
    assertUnexpired();
    // Reserve before any derived writes so failed conversions can be cleaned up.
    await index.reserve(generation);
    const parsed = await parser.parseEmail(source.content);
    const storedParts = new Map<Buffer, number>();
    const storePart = async (part: AttachmentDetails): Promise<StoredPart> => {
      assertUnexpired();
      if (!part.content) throw new Error('Parsed MIME part has no content');
      let storageIndex = storedParts.get(part.content);
      if (storageIndex === undefined) {
        storageIndex = storedParts.size;
        await fileSystem.putObject(
          `${prefix(generation)}parts/${storageIndex}`,
          part.content,
          'application/octet-stream',
        );
        storedParts.set(part.content, storageIndex);
      }
      return {
        filename: part.filename,
        size: part.size,
        contentType: part.contentType,
        storageIndex,
      };
    };
    const attachments: StoredPart[] = [];
    const inlineParts: StoredInlinePart[] = [];
    for (const part of parsed.attachments) attachments.push(await storePart(part));
    for (const part of parsed.inlineParts)
      inlineParts.push({
        ...(await storePart(part)),
        part: part.part,
        contentId: part.contentId,
      });
    const manifest: EmailManifest = {
      version: EMAIL_STORAGE_VERSION,
      id,
      generation: generation.Generation,
      expiresAt: generation.ExpireAt,
      rawBytes: source.content.byteLength,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      subject: parsed.subject,
      received: parsed.received.toISOString(),
      attachments,
      inlineParts,
    };
    assertUnexpired();
    await fileSystem.putObject(
      `${prefix(generation)}body`,
      parsed.body,
      'text/plain; charset=utf-8',
    );
    assertUnexpired();
    // The manifest and its D1 publication marker are written only after every object.
    await fileSystem.putObject(
      `${prefix(generation)}manifest.json`,
      JSON.stringify(manifest),
      'application/json',
    );
    assertUnexpired();
    await index.publish(generation, this.now());
    return { manifest, generation };
  }
}

export const createEmailStore = (env: Pick<Env, 'DB' | 'EMAILS' | 'EMAIL_TTL_DAYS'>): EmailStore =>
  new EmailStore({
    fileSystem: new R2FileSystem(env.EMAILS),
    index: new EmailPartsDatabase(env.DB),
    parser: new EmailParser(),
    ttlSeconds: Number(env.EMAIL_TTL_DAYS) * 86400,
  });
