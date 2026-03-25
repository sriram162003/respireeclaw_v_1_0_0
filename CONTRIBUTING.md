# Contributing to RespireeClaw

## Development Workflow

1. **Fork** the repository
2. **Create** a feature branch from `develop`:
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/your-feature
   ```
3. **Make** your changes
4. **Test** locally
5. **Commit** using conventional commits:
   ```
   feat: add new cloud automation skill
   fix: resolve CORS issue in dashboard
   docs: update README
   ```
6. **Push** and create PR to `develop` branch

## Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation
- `style` - Formatting
- `refactor` - Code restructuring
- `test` - Tests
- `chore` - Maintenance

## Code Standards

- TypeScript strict mode
- Run `npx tsc --noEmit` before committing
- Keep PRs small and focused

## Questions

Open an issue for discussion before starting major changes.
