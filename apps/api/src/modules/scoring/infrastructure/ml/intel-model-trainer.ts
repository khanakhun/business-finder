import {
  type MlTrainRequest,
  MlTrainRequestSchema,
  type MlTrainResult,
  MlTrainResultSchema,
} from '@bf/contracts';
import { Injectable } from '@nestjs/common';
import { IntelClient } from '../../../platform/intel/intel-client.ts';
import type { ModelTrainerPort } from '../../application/ml/ports.ts';

/** Training in intel (BF-059): one signed call, minutes long, never retried by the client. */
@Injectable()
export class IntelModelTrainer implements ModelTrainerPort {
  constructor(private readonly intel: IntelClient) {}

  train(request: MlTrainRequest): Promise<MlTrainResult> {
    // Parsed: intel's generated model expects the defaults filled in.
    return this.intel.post('/v1/ml/train', MlTrainRequestSchema.parse(request), MlTrainResultSchema, {
      policy: 'intel-ml',
    });
  }
}
