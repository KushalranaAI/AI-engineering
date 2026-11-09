# Security policy

AI Engineer Path is a local-first learning app. It runs in your browser, has no accounts and no backend of its own, and keeps your progress in `localStorage`.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately with GitHub: **Security → Report a vulnerability** on this repository
(<https://github.com/KushalranaAI/AI-engineering/security/advisories/new>).

Include what you found, how to reproduce it, and the impact you think it has. I will respond as soon as I can, and credit you in the fix unless you prefer not to be named.

## What is in scope

- The app and its build (`src/`, `server/`, `scripts/`, `vite.config.ts`).
- The GitHub Actions workflows in `.github/`.
- Content that could run code or leak data when a learner follows it.

Examples that matter: cross-site scripting through lesson Markdown or shared links, anything that exposes or exfiltrates an AI key you entered, and the optional dev relay (`/api/ai-proxy`) forwarding to a host it should not.

## How AI keys are handled

- A key you paste into the app is used only to call the AI provider you chose. The app is static; there is no server of mine in the middle.
- For local development the optional relay forwards only to known AI provider hosts (OpenAI, Anthropic, Azure OpenAI), and does not store or log keys.
- Keys you keep in a local `.env` stay on your machine. `.env` is git-ignored; only `.env.example` is committed. **Never commit a real key.** Secret scanning and push protection are enabled on this repository.

## Supported versions

Only the latest commit on `main` (the version deployed to GitHub Pages) is supported.

## Dependencies

Dependabot watches npm packages and GitHub Actions weekly, and security updates open automatically. Code scanning (CodeQL) runs on every push to `main` and on pull requests.
