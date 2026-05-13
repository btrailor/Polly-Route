# Contributing to Polly Router

## Getting Started

```bash
# 1. Fork and clone
git clone https://github.com/YOUR_USERNAME/polly-router.git
cd polly-router

# 2. Install dependencies
npm install

# 3. Build
npm run build

# 4. Run tests
npm test
```

## Development Workflow

1. **Create a branch**: `git checkout -b feature/your-feature`
2. **Make changes** with tests
3. **Run tests**: `npm test`
4. **Submit PR** with description

## Code Style

- TypeScript with strict settings
- Jest for testing (invariant-based, not mock-heavy)
- No external runtime dependencies (keep it lightweight)
- Log everything (routing decisions must be traceable)

## Testing Guidelines

Every routing behavior must have a test that:
- Sets up explicit state (no hidden fixtures)
- Executes the behavior
- Asserts the outcome
- Documents the invariant being tested

## Provider Additions

To add a new LLM provider:

1. Create adapter in `src/providers/`
2. Add config schema to `src/config.ts`
3. Add to routing chain in `src/router.ts`
4. Add budget key to `src/budget.ts`
5. Write tests
6. Update README provider table

## Release Process

1. Update CHANGELOG.md
2. Bump version in package.json
3. Run full test suite
4. Tag: `git tag vX.Y.Z`
5. Push: `git push origin vX.Y.Z`
6. GitHub Actions builds and validates
