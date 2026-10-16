// File templates for `pnpm gen:module <context>`. They mirror apps/api/src/modules/system (the reference module).
// `n` is the result of names(); paths are relative to the repository root.

export function templates(n) {
  const m = `apps/api/src/modules/${n.kebab}`;
  return {
    [`packages/contracts/src/${n.kebab}.ts`]: `import { z } from 'zod';
import { idSchema, type Id } from './ids.ts';
import { IsoDateTimeSchema } from './time.ts';

export const ${n.pascal}Id = idSchema('${n.pascal}Id');
export type ${n.pascal}Id = Id<'${n.pascal}Id'>;

export const ${n.pascal}Schema = z
  .object({ id: ${n.pascal}Id, name: z.string().min(1).max(200), createdAt: IsoDateTimeSchema })
  .meta({ id: '${n.pascal}', description: 'TODO: describe a ${n.kebab}.' });
export type ${n.pascal} = z.infer<typeof ${n.pascal}Schema>;

export const Create${n.pascal}RequestSchema = z
  .object({ name: z.string().trim().min(1).max(200) })
  .meta({ id: 'Create${n.pascal}Request', description: 'TODO: describe the create request.' });
export type Create${n.pascal}Request = z.infer<typeof Create${n.pascal}RequestSchema>;
`,
    [`${m}/domain/${n.kebab}.entity.ts`]: `import type { ${n.pascal}Id } from '@bf/contracts';

/** Aggregate root. Pure TypeScript: no framework, no database. Build through the factories. */
export class ${n.pascal}Entity {
  private constructor(
    readonly id: ${n.pascal}Id,
    readonly name: string,
    readonly createdAt: Date,
  ) {}

  static create(props: { id: ${n.pascal}Id; name: string; now: Date }): ${n.pascal}Entity {
    return new ${n.pascal}Entity(props.id, props.name.trim(), props.now);
  }

  static rehydrate(props: { id: ${n.pascal}Id; name: string; createdAt: Date }): ${n.pascal}Entity {
    return new ${n.pascal}Entity(props.id, props.name, props.createdAt);
  }

  rename(name: string): ${n.pascal}Entity {
    return new ${n.pascal}Entity(this.id, name.trim(), this.createdAt);
  }
}
`,
    [`${m}/domain/${n.kebab}.entity.test.ts`]: `import { newId } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { ${n.pascal}Entity } from './${n.kebab}.entity.ts';

describe('${n.pascal}Entity', () => {
  it('trims the name on create and rename, without mutating', () => {
    const entity = ${n.pascal}Entity.create({ id: newId(), name: '  First ', now: new Date('2026-01-01T00:00:00Z') });
    expect(entity.name).toBe('First');
    const renamed = entity.rename(' Second ');
    expect(renamed.name).toBe('Second');
    expect(entity.name).toBe('First');
  });
});
`,
    [`${m}/application/ports.ts`]: `import type { ${n.pascal}Id } from '@bf/contracts';
import type { ${n.pascal}Entity } from '../domain/${n.kebab}.entity.ts';

/** Port: persistence for ${n.kebab}. Adapters call getExecutor(db) so use cases control transactions. */
export interface ${n.pascal}Repository {
  save(entity: ${n.pascal}Entity): Promise<void>;
  findById(id: ${n.pascal}Id): Promise<${n.pascal}Entity | undefined>;
}
export const ${n.constant}_REPOSITORY = Symbol('${n.pascal}Repository');
`,
    [`${m}/application/create-${n.kebab}.command.ts`]: `import { type ${n.pascal}, type Create${n.pascal}Request, newId } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { ${n.pascal}Entity } from '../domain/${n.kebab}.entity.ts';
import { ${n.constant}_REPOSITORY, type ${n.pascal}Repository } from './ports.ts';
import { to${n.pascal}Dto } from './mappers.ts';

@Injectable()
export class Create${n.pascal}Command {
  constructor(
    @Inject(${n.constant}_REPOSITORY) private readonly repository: ${n.pascal}Repository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Transactional()
  async execute(input: Create${n.pascal}Request): Promise<${n.pascal}> {
    const entity = ${n.pascal}Entity.create({ id: newId(), name: input.name, now: this.clock.now() });
    await this.repository.save(entity);
    return to${n.pascal}Dto(entity);
  }
}
`,
    [`${m}/application/get-${n.kebab}.query.ts`]: `import { type ${n.pascal}, type ${n.pascal}Id, NotFoundError } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ${n.constant}_REPOSITORY, type ${n.pascal}Repository } from './ports.ts';
import { to${n.pascal}Dto } from './mappers.ts';

@Injectable()
export class Get${n.pascal}Query {
  constructor(@Inject(${n.constant}_REPOSITORY) private readonly repository: ${n.pascal}Repository) {}

  async execute(id: ${n.pascal}Id): Promise<${n.pascal}> {
    const entity = await this.repository.findById(id);
    if (!entity) throw new NotFoundError('${n.pascal}', id);
    return to${n.pascal}Dto(entity);
  }
}
`,
    [`${m}/application/mappers.ts`]: `import type { ${n.pascal} } from '@bf/contracts';
import type { ${n.pascal}Entity } from '../domain/${n.kebab}.entity.ts';

export function to${n.pascal}Dto(entity: ${n.pascal}Entity): ${n.pascal} {
  return { id: entity.id, name: entity.name, createdAt: entity.createdAt.toISOString() };
}
`,
    [`${m}/application/${n.kebab}.use-cases.test.ts`]: `import { fixedClock, newId, NotFoundError, type ${n.pascal}Id } from '@bf/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ${n.pascal}Entity } from '../domain/${n.kebab}.entity.ts';
import { Create${n.pascal}Command } from './create-${n.kebab}.command.ts';
import { Get${n.pascal}Query } from './get-${n.kebab}.query.ts';
import type { ${n.pascal}Repository } from './ports.ts';

// @Transactional needs a database; unit tests exercise the logic underneath it.
vi.mock('../../platform/db/transactional.ts', () => ({ Transactional: () => () => undefined }));

function inMemoryRepository(): ${n.pascal}Repository {
  const rows = new Map<string, ${n.pascal}Entity>();
  return {
    save: async (entity) => {
      rows.set(entity.id, entity);
    },
    findById: async (id) => rows.get(id),
  };
}

describe('${n.pascal} use cases', () => {
  it('creates then reads back', async () => {
    const repository = inMemoryRepository();
    const created = await new Create${n.pascal}Command(repository, fixedClock('2026-01-01T00:00:00Z')).execute({ name: 'Example' });
    expect(created).toMatchObject({ name: 'Example', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(await new Get${n.pascal}Query(repository).execute(created.id)).toEqual(created);
  });

  it('reports missing ones as NotFoundError', async () => {
    await expect(new Get${n.pascal}Query(inMemoryRepository()).execute(newId<'${n.pascal}Id'>() as ${n.pascal}Id)).rejects.toThrow(NotFoundError);
  });
});
`,
    [`${m}/infrastructure/drizzle-${n.kebab}.repository.ts`]: `import type { ${n.pascal}Id } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { Inject, Injectable } from '@nestjs/common';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { ${n.pascal}Repository } from '../application/ports.ts';
import type { ${n.pascal}Entity } from '../domain/${n.kebab}.entity.ts';

/**
 * Adapter: ${n.pascal}Repository on Postgres. TODO: add the table to packages/db/src/schema/${n.kebab}.ts, run
 * \`pnpm db:generate --name add_${n.constant.toLowerCase()}\`, then implement with \`getExecutor(this.db)\` and an
 * integration test (*.int.test.ts) against \`createIsolatedDatabase()\`.
 */
@Injectable()
export class Drizzle${n.pascal}Repository implements ${n.pascal}Repository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async save(_entity: ${n.pascal}Entity): Promise<void> {
    throw new Error(\`Drizzle${n.pascal}Repository.save is not implemented yet (db: \${typeof this.db})\`);
  }

  async findById(_id: ${n.pascal}Id): Promise<${n.pascal}Entity | undefined> {
    throw new Error('Drizzle${n.pascal}Repository.findById is not implemented yet');
  }
}
`,
    [`${m}/interface/${n.kebab}.controller.ts`]: `import { type ${n.pascal}, ${n.pascal}Id, ${n.pascal}Schema, Create${n.pascal}RequestSchema } from '@bf/contracts';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiRoute } from '../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../platform/validation/zod-dto.ts';
import { Create${n.pascal}Command } from '../application/create-${n.kebab}.command.ts';
import { Get${n.pascal}Query } from '../application/get-${n.kebab}.query.ts';

class Create${n.pascal}Body extends zodDto(Create${n.pascal}RequestSchema) {}
class ${n.pascal}Params extends zodDto(z.object({ id: ${n.pascal}Id })) {}

// TODO(BF-010): add @RequirePermission(...) to every route.
@ApiTags('${n.kebab}')
@Controller('${n.route}')
export class ${n.pascal}Controller {
  constructor(
    private readonly create${n.pascal}: Create${n.pascal}Command,
    private readonly get${n.pascal}: Get${n.pascal}Query,
  ) {}

  @Post()
  @ApiRoute({ summary: 'Create a ${n.kebab}', body: Create${n.pascal}Body, response: { status: 201, schema: ${n.pascal}Schema } })
  create(@Body() body: Create${n.pascal}Body): Promise<${n.pascal}> {
    return this.create${n.pascal}.execute(body);
  }

  @Get(':id')
  @ApiRoute({ summary: 'Get a ${n.kebab}', response: { status: 200, schema: ${n.pascal}Schema }, errors: [404] })
  get(@Param() params: ${n.pascal}Params): Promise<${n.pascal}> {
    return this.get${n.pascal}.execute(params.id);
  }
}
`,
    [`${m}/interface/${n.kebab}.processor.ts`]: `// Processor template for ${n.kebab} jobs. To use it:
//   1. Declare the job in packages/contracts/src/${n.kebab}.ts:
//        export const ${n.pascal}Job = defineJob('${n.kebab}', '<job-name>', { … });
//   2. Add the queue to QUEUES in packages/queue/src/registry.ts.
//   3. Replace this file with:
//        @Processor(QUEUES['${n.kebab}'].name, { concurrency: QUEUES['${n.kebab}'].concurrency })
//        export class ${n.pascal}Processor extends TypedProcessor<typeof ${n.pascal}Job, void> {
//          protected readonly definition = ${n.pascal}Job;
//          async handle(payload, context) { /* delegate to a use case; pass context.signal along */ }
//        }
//   4. Register it in ${n.kebab}.module.ts for mode === 'worker' (see SystemModule).
export {};
`,
    [`${m}/${n.kebab}.module.ts`]: `import { type DynamicModule, Module } from '@nestjs/common';
import type { AppMode } from '../platform/config/app-env.ts';
import { Create${n.pascal}Command } from './application/create-${n.kebab}.command.ts';
import { Get${n.pascal}Query } from './application/get-${n.kebab}.query.ts';
import { ${n.constant}_REPOSITORY } from './application/ports.ts';
import { Drizzle${n.pascal}Repository } from './infrastructure/drizzle-${n.kebab}.repository.ts';
import { ${n.pascal}Controller } from './interface/${n.kebab}.controller.ts';

@Module({})
export class ${n.pascal}Module {
  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: ${n.pascal}Module,
      controllers: mode === 'worker' ? [] : [${n.pascal}Controller],
      providers: [Create${n.pascal}Command, Get${n.pascal}Query, { provide: ${n.constant}_REPOSITORY, useClass: Drizzle${n.pascal}Repository }],
    };
  }
}
`,
    [`${m}/index.ts`]: `// Public surface of the ${n.kebab} module: other modules import only from here.
export { ${n.pascal}Module } from './${n.kebab}.module.ts';
`,
  };
}

/** Lines to add to existing files (contracts index, app module). */
export function wiring(n) {
  return {
    contractsExport: `export * from './${n.kebab}.ts';`,
    appModuleImport: `import { ${n.pascal}Module } from './modules/${n.kebab}/index.ts';`,
    appModuleEntry: `${n.pascal}Module.forRoot(mode),`,
  };
}
