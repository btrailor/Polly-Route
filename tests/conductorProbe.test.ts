import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { probeConductor } from '../src/conductorProbe';
import { Config } from '../src/config';

/**
 * Regression tests for Polly-Router's conductor probe.
 *
 * Goal: prove the new `story-idea` conductor domain does not steal
 * scene-generation traffic from the existing `loom` domain.
 *
 * The probe is fixture-driven and self-contained by default, so these tests
 * do not depend on the real `story-idea` pack being present. An integration
 * block points at the real domains directory and skips cleanly until the
 * parallel lane lands `story-idea/manifest.json`.
 */

const REAL_DOMAINS_DIR = '/Users/brettgershon/.openclaw/workspace/projects/syntaxis/conductor/domains';
const STORY_IDEA_MANIFEST_PATH = path.join(REAL_DOMAINS_DIR, 'story-idea', 'manifest.json');
const MIN_SCORE = 0.25;

function makeConfig(domainsDir: string, minScore = MIN_SCORE): Config {
  return {
    port: 4200,
    ollama: { baseUrl: 'http://127.0.0.1:11434', models: [] },
    providers: {},
    qmd: { baseUrl: 'http://localhost:8181', collection: 'vault', timeoutMs: 500, minScore: 0.89 },
    conductor: { domainsDir, timeoutMs: 2000, minScore },
  };
}

function writeDomain(tmpDir: string, domainId: string, manifest: unknown): void {
  const dir = path.join(tmpDir, domainId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

function loomFixtureManifest() {
  return {
    domain: 'loom',
    description:
      'The Loom creative writing pipeline. Generate scenes, validate story continuity, review story state, and manage craft lessons.',
    actions: [
      {
        id: 'review_state',
        description:
          'Get current story state — characters, settings, outline, scene statuses, arc progress, world bible summary. Read-only.',
        execute: 'echo review',
        params: {
          project: {
            type: 'string',
            required: true,
            description: 'Project slug (e.g. quarry).',
          },
        },
        gates: ['valid_json_output'],
        triggers: ['review state', 'story state', 'review story', 'check status'],
      },
      {
        id: 'generate_scene',
        description:
          'Generate a scene draft for a story project. Calls story-tracker, retrieves corpus passages, and writes the scene file.',
        execute: 'echo generate',
        params: {
          project: {
            type: 'string',
            required: true,
            description: 'Project slug (e.g. quarry).',
          },
          scene: {
            type: 'integer',
            required: true,
            description: 'Scene number to generate',
          },
        },
        gates: ['scene_file_exists'],
        triggers: [
          'generate scene',
          'write scene',
          'produce scene',
          'create scene',
          'draft scene',
          'compose scene',
          'new scene',
        ],
      },
      {
        id: 'list_projects',
        description: 'List all story project slugs available in the vault.',
        execute: 'echo list',
        params: {},
        gates: ['exit_zero'],
        triggers: ['list projects', 'show projects', 'available projects'],
      },
    ],
  };
}

function storyIdeaFixtureManifest() {
  return {
    domain: 'story-idea',
    description:
      'Story idea to Loom project setup. Capture a raw story idea as a premise brief, scaffold a Loom story project with a world bible skeleton, and populate the world bible one domain at a time.',
    actions: [
      {
        id: 'capture_idea',
        description: 'Capture a raw story idea as a structured premise brief.',
        execute: 'echo capture',
        params: {
          idea: {
            type: 'string',
            required: true,
            description: 'The raw story idea text, copied verbatim from the user.',
          },
          slug: {
            type: 'string',
            default: '',
            description: 'Optional project slug; derived from title when empty.',
          },
        },
        gates: ['project_dir_exists', 'brief_exists'],
        triggers: ['capture idea', 'story idea', 'new idea', 'raw idea'],
      },
      {
        id: 'scaffold_project',
        description:
          'Scaffold a Loom story project with a world bible skeleton from a captured idea.',
        execute: 'echo scaffold',
        params: {
          title: {
            type: 'string',
            required: true,
            description: 'Story title.',
          },
          slug: {
            type: 'string',
            required: true,
            description: 'Project slug.',
          },
        },
        gates: ['project_dir_exists', 'world_bible_skeleton'],
        triggers: ['scaffold project', 'setup project', 'create project', 'new project'],
      },
      {
        id: 'build_world_domain',
        description: 'Populate one world bible domain for a story project.',
        execute: 'echo worldbuild',
        params: {
          slug: {
            type: 'string',
            required: true,
            description: 'Project slug.',
          },
          domain: {
            type: 'string',
            required: true,
            description: 'World bible domain key (e.g. magic).',
          },
        },
        gates: ['world_domain_populated'],
        triggers: ['build world', 'world domain', 'populate domain', 'domain generation'],
      },
      {
        id: 'list_world_domains',
        description: 'List the available world bible domain keys for a project.',
        execute: 'echo list-domains',
        params: {
          slug: {
            type: 'string',
            required: true,
            description: 'Project slug.',
          },
        },
        gates: ['exit_zero'],
        triggers: ['list domains', 'world domains', 'available domains'],
      },
      {
        id: 'review_world_bible',
        description: 'Report world bible population state for a project.',
        execute: 'echo review-bible',
        params: {
          slug: {
            type: 'string',
            required: true,
            description: 'Project slug.',
          },
        },
        gates: ['exit_zero'],
        triggers: ['review bible', 'world bible', 'check bible', 'bible status'],
      },
      {
        id: 'list_ideas',
        description: 'List captured story idea briefs.',
        execute: 'echo list-ideas',
        params: {},
        gates: ['exit_zero'],
        triggers: ['list ideas', 'show ideas', 'my ideas'],
      },
      {
        id: 'done',
        description: 'Terminal action — project setup is complete.',
        execute: 'echo done',
        params: {},
        gates: [],
        triggers: [],
      },
    ],
  };
}

function dampingFixtureManifest() {
  return {
    domain: 'loom-damped',
    description: 'The Loom creative writing pipeline. Generate scenes and drafts.',
    actions: [
      {
        id: 'generate_scene',
        description: 'Generate a scene draft for a story project.',
        execute: 'echo generate',
        params: {
          project: {
            type: 'string',
            required: true,
            description: 'Project slug.',
          },
          scene: {
            type: 'integer',
            required: true,
            description: 'Scene number to generate',
          },
        },
        gates: ['scene_file_exists'],
        triggers: ['generate scene', 'write scene'],
      },
    ],
  };
}

async function probeDomainInIsolation(
  manifest: unknown,
  query: string,
  minScore = MIN_SCORE,
): Promise<Awaited<ReturnType<typeof probeConductor>>> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-conductor-isolated-'));
  try {
    const domainId = (manifest as { domain: string }).domain;
    writeDomain(tmpDir, domainId, manifest);
    return await probeConductor([{ role: 'user', content: query }], makeConfig(tmpDir, minScore));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function probeRealDomainInIsolation(
  domainId: string,
  query: string,
  minScore = MIN_SCORE,
): Promise<Awaited<ReturnType<typeof probeConductor>>> {
  const manifestPath = path.join(REAL_DOMAINS_DIR, domainId, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  return probeDomainInIsolation(manifest, query, minScore);
}

describe('conductorProbe fixture-based unit tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-conductor-probe-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('scene query routes to loom, not story-idea', async () => {
    const query = 'generate scene 3 of quarry';

    writeDomain(tmpDir, 'loom', loomFixtureManifest());
    writeDomain(tmpDir, 'story-idea', storyIdeaFixtureManifest());

    const result = await probeConductor([{ role: 'user', content: query }], makeConfig(tmpDir));

    expect(result.matched).toBe(true);
    expect(result.domainId).toBe('loom');
    expect(result.score).toBeGreaterThan(MIN_SCORE);
    expect(result.matchedActionId).toBe('generate_scene');

    const storyIdeaAlone = await probeDomainInIsolation(storyIdeaFixtureManifest(), query);
    const storyIdeaDidNotSteal =
      !storyIdeaAlone.matched ||
      (storyIdeaAlone.score ?? 0) < MIN_SCORE ||
      (result.score ?? 0) > (storyIdeaAlone.score ?? 0);
    expect(storyIdeaDidNotSteal).toBe(true);
  });

  test('story-idea query routes to story-idea, not loom', async () => {
    const query = 'a story idea about a lighthouse keeper who learns the sea is listening';

    writeDomain(tmpDir, 'loom', loomFixtureManifest());
    writeDomain(tmpDir, 'story-idea', storyIdeaFixtureManifest());

    const result = await probeConductor([{ role: 'user', content: query }], makeConfig(tmpDir));

    expect(result.matched).toBe(true);
    expect(result.domainId).toBe('story-idea');
    expect(result.score).toBeGreaterThan(MIN_SCORE);
    expect(result.matchedActionId).toBe('capture_idea');

    const loomAlone = await probeDomainInIsolation(loomFixtureManifest(), query);
    const loomDidNotSteal =
      !loomAlone.matched ||
      (loomAlone.score ?? 0) < MIN_SCORE ||
      (result.score ?? 0) > (loomAlone.score ?? 0);
    expect(loomDidNotSteal).toBe(true);
  });

  test('unrelated query fails the domain-relevance gate for both domains', async () => {
    const query = 'what is the weather tomorrow';

    writeDomain(tmpDir, 'loom', loomFixtureManifest());
    writeDomain(tmpDir, 'story-idea', storyIdeaFixtureManifest());

    const result = await probeConductor([{ role: 'user', content: query }], makeConfig(tmpDir));

    expect(result.matched).toBe(false);

    const loomAlone = await probeDomainInIsolation(loomFixtureManifest(), query);
    const storyIdeaAlone = await probeDomainInIsolation(storyIdeaFixtureManifest(), query);

    expect(loomAlone.matched).toBe(false);
    expect(storyIdeaAlone.matched).toBe(false);
  });

  test('trigger damping prevents a multi-trigger action from winning on a generic keyword', async () => {
    const query = 'draft a blog post today';

    writeDomain(tmpDir, 'loom-damped', dampingFixtureManifest());

    const result = await probeConductor([{ role: 'user', content: query }], makeConfig(tmpDir));

    expect(result.matched).toBe(false);
    expect(result.matchedActionId).not.toBe('generate_scene');
  });
});

// ─── Integration against the real domains dir ──────────────────────────────
// The integration block is meaningful only once the parallel lane has landed
// story-idea/manifest.json. If that manifest is absent, we skip with a clear
// skipped-test message rather than silently passing.
//
// To confirm the integration test is genuinely exercising the new domain and
// not silently passing, run:
//   node --experimental-vm-modules node_modules/.bin/jest tests/conductorProbe.test.ts --verbose
// and verify that the integration tests print:
//   domainId: 'story-idea'
//   matchedActionId: 'capture_idea'

const realStoryIdeaManifestExists = fs.existsSync(STORY_IDEA_MANIFEST_PATH);

if (!realStoryIdeaManifestExists) {
  describe('conductorProbe integration against real domains', () => {
    test.skip(
      'story-idea/manifest.json is absent — integration tests will run once the parallel lane lands it',
      () => {},
    );
  });
} else {
  describe('conductorProbe integration against real domains', () => {
    const cfg = makeConfig(REAL_DOMAINS_DIR);

    test('scene query routes to real loom domain', async () => {
      const query = 'generate scene 3 of quarry';
      const result = await probeConductor([{ role: 'user', content: query }], cfg);

      expect(result.matched).toBe(true);
      expect(result.domainId).toBe('loom');
      expect(result.score).toBeGreaterThan(MIN_SCORE);
      expect(result.matchedActionId).toBe('generate_scene');

      const storyIdeaAlone = await probeRealDomainInIsolation('story-idea', query);
      const storyIdeaDidNotSteal =
        !storyIdeaAlone.matched ||
        (storyIdeaAlone.score ?? 0) < MIN_SCORE ||
        (result.score ?? 0) > (storyIdeaAlone.score ?? 0);
      expect(storyIdeaDidNotSteal).toBe(true);
    });

    test('story-idea query routes to real story-idea domain', async () => {
      const query = 'a story idea about a lighthouse keeper who learns the sea is listening';
      const result = await probeConductor([{ role: 'user', content: query }], cfg);

      expect(result.matched).toBe(true);
      expect(result.domainId).toBe('story-idea');
      expect(result.score).toBeGreaterThan(MIN_SCORE);
      expect(result.matchedActionId).toBe('capture_idea');

      const loomAlone = await probeRealDomainInIsolation('loom', query);
      const loomDidNotSteal =
        !loomAlone.matched ||
        (loomAlone.score ?? 0) < MIN_SCORE ||
        (result.score ?? 0) > (loomAlone.score ?? 0);
      expect(loomDidNotSteal).toBe(true);
    });

    test('unrelated query does not match either real domain', async () => {
      const query = 'what is the weather tomorrow';
      const result = await probeConductor([{ role: 'user', content: query }], cfg);

      expect(result.matched).toBe(false);
    });
  });
}
