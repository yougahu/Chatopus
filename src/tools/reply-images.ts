import type {ManagedFileWriter} from '../attachments.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { OutgoingImage } from '../types.js';
import { imageMime, readOutgoingImage, MAX_OUTPUT_IMAGE_BYTES, MAX_OUTPUT_IMAGE_COUNT, MAX_OUTPUT_TOTAL_BYTES } from '../output-images.js';

type ImageMetadata = Pick<OutgoingImage, 'artifactId' | 'mimeType' | 'bytes'>;
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const;

/** A run can publish only screenshots whose bytes this registry received. */
export class ReplyImages {
  private images = new Map<string, OutgoingImage>();
  constructor(private readonly workspace: string,private readonly managedWriter?:ManagedFileWriter) {}

  async capture(result: unknown): Promise<unknown> {
    if (!result || typeof result !== 'object') return result;
    const source = result as Record<string, unknown>;
    if (source.isError) return result;
    const content = Array.isArray(source.content) ? source.content : [];
    const blocks = content.filter((block): block is Record<string, unknown> => !!block && typeof block === 'object' && block.type === 'image');
    if (blocks.length > MAX_OUTPUT_IMAGE_COUNT) throw new Error('Screenshot returned too many images');
    let total = 0;
    // Validate the whole response before writing or registering any artifacts.
    const decoded = blocks.map(block => {
      const encoded = block.data;
      if (typeof encoded !== 'string' || !encoded.length || encoded.length > 4 * Math.ceil(MAX_OUTPUT_IMAGE_BYTES / 3)
        || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Screenshot returned invalid or oversized image bytes');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length > MAX_OUTPUT_IMAGE_BYTES || bytes.toString('base64') !== encoded) throw new Error('Screenshot returned invalid or oversized image bytes');
      const mimeType = imageMime(bytes);
      if (block.mimeType !== mimeType) throw new Error('Screenshot image type does not match its bytes');
      total += bytes.length;
      if (total > MAX_OUTPUT_TOTAL_BYTES) throw new Error('Screenshot images exceed the total size limit');
      return { bytes, mimeType };
    });
    const prepared: OutgoingImage[] = [];
    if (decoded.length) {
      const root = await fs.realpath(this.workspace), directory = path.join(root, '.reply-images');
      try { await fs.mkdir(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Screenshot artifact directory must not be a symlink');
      try {
        for (const { bytes, mimeType } of decoded) {
          const artifactId = `image-${randomUUID()}`;
          const file = path.join(directory, `${artifactId}.${extensions[mimeType]}`);
          if(this.managedWriter)await this.managedWriter.write(file,bytes,artifactId);else await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
          prepared.push({ kind: 'image', artifactId, file, mimeType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
      } catch (error) {
        await Promise.allSettled(prepared.map(image => fs.unlink(image.file)));
        throw error;
      }
      for (const image of prepared) this.images.set(image.artifactId, image);
    }
    const replyImages: ImageMetadata[] = prepared.map(({ artifactId, mimeType, bytes }) => ({ artifactId, mimeType, bytes }));
    return { ...source, replyImages, content: [...content, {
      type: 'text', text: JSON.stringify({ replyImages, imageDeliveryNote: replyImages.length
        ? 'To include a screenshot in your reply, put its artifactId in the final report images array. These IDs belong to this run; images are not sent automatically.'
        : 'No image bytes were returned, so no sendable screenshot was registered. A file path in tool text is not a reply image. Request a screenshot that returns image content before promising an image reply.' }),
    }] };
  }

  async resolve(ids: string[]): Promise<OutgoingImage[]> {
    if (!Array.isArray(ids) || ids.length > MAX_OUTPUT_IMAGE_COUNT || new Set(ids).size !== ids.length) throw new Error('Select at most four distinct reply images');
    const images = ids.map(id => {
      const image = this.images.get(id);
      if (!image) throw new Error('Reply image ID is unavailable in this run; capture a new screenshot');
      return image;
    });
    if (images.reduce((total, image) => total + image.bytes, 0) > MAX_OUTPUT_TOTAL_BYTES) throw new Error('Reply images exceed the total size limit');
    for (const image of images) await readOutgoingImage(image, this.workspace);
    return images.map(image => ({ ...image }));
  }
}
