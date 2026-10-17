import { createHash } from 'node:crypto';
import { type MlPreprocessingSpec, MlPreprocessingSpecSchema } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import type { ObjectStorage } from '../../../platform/storage/object-storage.ts';
import { ML_STORAGE, type MlModelRecord, type ModelRuntime } from '../../application/ml/ports.ts';

// The ONNX runtime for registered models (BF-059): artifacts read from private storage and checked against the
// registry's SHA-256 before use (only our pipeline's output runs; no pickle), sessions cached per model.

const CACHE_SIZE = 8;

interface Loaded {
  readonly spec: MlPreprocessingSpec;
  readonly session: InferenceSession;
}

export class ModelArtifactError extends Error {}

@Injectable()
export class OnnxModelRuntime implements ModelRuntime {
  private readonly cache = new Map<string, Promise<Loaded>>();

  constructor(@Inject(ML_STORAGE) private readonly storage: ObjectStorage) {}

  private async artifact(model: MlModelRecord, name: 'model' | 'preprocessing'): Promise<Buffer> {
    const stored = await this.storage.get(model.artifactKeys[name]);
    if (!stored) throw new ModelArtifactError(`Model ${model.id}: ${name} is missing`);
    const hash = createHash('sha256').update(stored.body).digest('hex');
    if (hash !== model.artifactHashes[name])
      throw new ModelArtifactError(`Model ${model.id}: ${name} does not match its SHA-256`);
    return stored.body;
  }

  private load(model: MlModelRecord): Promise<Loaded> {
    const cached = this.cache.get(model.id);
    if (cached) return cached;
    const loading = (async () => {
      const spec = MlPreprocessingSpecSchema.parse(
        JSON.parse((await this.artifact(model, 'preprocessing')).toString('utf8')),
      );
      const session = await InferenceSession.create(await this.artifact(model, 'model'));
      return { spec, session };
    })();
    // A failed load is not cached (the next call tries again).
    loading.catch(() => this.cache.delete(model.id));
    if (this.cache.size >= CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(model.id, loading);
    return loading;
  }

  async spec(model: MlModelRecord): Promise<MlPreprocessingSpec> {
    return (await this.load(model)).spec;
  }

  async predict(model: MlModelRecord, rows: readonly Float32Array[]): Promise<number[]> {
    if (rows.length === 0) return [];
    const { spec, session } = await this.load(model);
    const width = spec.columns.length;
    const data = new Float32Array(rows.length * width);
    for (const [i, row] of rows.entries()) data.set(row, i * width);
    const output = await session.run(
      { [spec.onnx.inputName]: new Tensor('float32', data, [rows.length, width]) },
      [spec.onnx.outputName],
    );
    const probabilities = output[spec.onnx.outputName]?.data as Float32Array | undefined;
    if (!probabilities) throw new ModelArtifactError(`Model ${model.id}: no ${spec.onnx.outputName} output`);
    const classes = probabilities.length / rows.length;
    return rows.map((_, i) => Number(probabilities[i * classes + spec.onnx.positiveIndex] ?? 0));
  }
}
