# Content guide

AI Engineer Path teaches with one loop per module: **Understand → See it in real life → Build it → Check → Review**.

| Piece | Where | Type |
|---|---|---|
| Level data (modules, topics, outcomes, projects) | `src/curriculum/levels/lNN.ts` | `Level` in `src/curriculum/types.ts` |
| Lesson (Understand + Check) | `content/LNN/<moduleId>-<slug>.md` | markdown, see below |
| Real life + Build it | `src/curriculum/practice/pNN.ts` | `PracticeMap` in `src/curriculum/practice/types.ts` |
| Interview bank | `src/curriculum/practice/interview-*.ts` | `InterviewQ[]` exported as `QUESTIONS` |
| Flashcards | `src/curriculum/practice/flashcards-*.ts` | `Flashcard[]` exported as `FLASHCARDS` |

Every file is loaded automatically; nothing needs registering.

## Voice

- Write for a working software engineer. Plain words, short sentences, concrete numbers.
- Original wording only. Never copy phrasing from other roadmaps or courses.
- Prefer durable concepts. Model names, prices and limits are examples ("for example, a small model at about $0.15 per million input tokens"), never facts that will date.
- Python is the main language. Code must be plausible to run as written with current libraries; when an API is likely to drift, say "check the current docs for the exact parameter".

## Real life (`realLife`)

The everyday picture must work **the same way** as the concept, not just sound similar, and it must be realistic for
someone living in a city today (cooking, commuting, delivery apps, a clinic, a library, a shop, a phone contact list,
a group chat, a bank queue, a cricket or football match, a school exam...). Vary them: do not reuse the restaurant
kitchen for everything. The `mapping` rows make the correspondence explicit, and the last row may name where the
analogy breaks down.

Good: *Prefix caching* → "A barista who keeps the morning's oat-milk base steamed. Every latte that starts the same way
skips that step; a custom order still starts from scratch."

Weak: "Caching is like memory" (not concrete, doesn't explain anything).

## Build it (`build`)

- Something the learner **implements and runs**, 30-120 minutes, on a laptop with an API key (or free local tools).
- It must exercise the module's topics, not a neighbouring one.
- `steps` are imperative and specific ("Embed 200 FAQ entries with an embedding model and save them as a NumPy array").
- `starter` (optional) is a skeleton with `# TODO`s, at most ~25 lines. Never a full solution.
- `checks` are things the learner can verify themselves ("Asking 'money back' returns the refund article in the top 3").
- Link a simulator (`sim`) or Agent Studio preset (`studio`) only when it genuinely helps with this task.
- Capstone modules (with `projectId`) also get an entry: real life for the project as a whole, and a "first milestone"
  build that gets the project started.

## Lessons

```yaml
---
module: "4.3"
title: "Embeddings"   # same as the module title
minutes: 12
---
```

Then `# Title`, the teaching, a `## Try it` with `<details><summary>Reference</summary>…</details>`, a
`## Check yourself` with exactly 3 questions each followed by `<details><summary>Answer</summary>…</details>`, and
`## Sources` with 1-4 real URLs you are confident exist. 500-900 words of prose.
