import type { Level } from "../types";

export const L3: Level = {
  number: 3,
  title: "Prompt engineering",
  short: "Prompting",
  phase: "foundations",
  summary:
    "Write instructions that make model behaviour reliable and predictable, and improve them by measurement rather than taste. Managing everything else that goes into the context comes later.",
  interviewWeight: 5,
  interviewNote:
    "Interviewers usually assume you can do this and rarely probe deeply. It won't set you apart, and leading a CV with it can read as junior.",
  jobWeight: 8,
  jobNote:
    "You write and adjust prompts constantly, and a better instruction often fixes a problem faster than new code. It matters more at work than in interviews.",
  assumes: [2],
  modules: [
    {
      id: "3.1",
      title: "Parts of a prompt",
      sessions: 1,
      topics: [
        { title: "The building blocks", detail: "Assemble a prompt from instructions, context, input, constraints, examples and an output spec." },
        { title: "Roles and priority", detail: "Put the right content in system, user and assistant messages and know which wins in a conflict." },
        { title: "Instructions apart from data", detail: "Fence off user-supplied and external text so the model doesn't mistake it for instructions." },
      ],
      outcome: "You can lay out a prompt so each part is clear and data cannot be confused with instructions.",
    },
    {
      id: "3.2",
      title: "Zero-shot and few-shot",
      sessions: 2,
      topics: [
        { title: "Do you need examples?", detail: "Tell when a clear instruction is enough and when examples are worth their tokens." },
        { title: "Writing good examples", detail: "Pick examples that show both the behaviour and the exact output format you want." },
        { title: "Quality, variety and order", detail: "See how weak, repetitive or badly ordered examples skew results." },
        { title: "Examples vs fine-tuning", detail: "Distinguish teaching in the prompt from changing the model's weights." },
      ],
      outcome: "You can decide whether a task needs examples and write a set that actually improves results.",
    },
    {
      id: "3.3",
      title: "Reasoning and decomposition",
      sessions: 1,
      topics: [
        { title: "When to ask for reasoning", detail: "Use reasoning-oriented prompts for logic, planning, maths, code and many-constraint problems." },
        { title: "When to skip it", detail: "Leave it out for extraction, classification and rewriting, where it adds cost and little else." },
        { title: "Splitting the problem", detail: "Break a hard task into smaller steps or separate calls." },
        { title: "Prompting reasoning models", detail: "State goal, context, constraints and what good looks like, instead of telling the model how to think." },
      ],
      outcome: "You can choose when and how to prompt for reasoning, including with reasoning models.",
    },
    {
      id: "3.4",
      title: "System prompts",
      sessions: 2,
      topics: [
        { title: "What goes in", detail: "Define purpose, behaviour, limits and output expectations for the application." },
        { title: "Stable rules vs per-task asks", detail: "Keep app-wide rules in the system prompt and task details in the user turn." },
        { title: "Missing, unclear or off-topic input", detail: "Say what the model should do when it lacks information or a request is out of scope." },
        { title: "Light guardrails", detail: "Add a few behavioural limits without growing a giant rulebook." },
      ],
      outcome: "You can write a compact system prompt that gives an application consistent behaviour, including at the edges.",
    },
    {
      id: "3.5",
      title: "Controlling the output",
      sessions: 1,
      topics: [
        { title: "Style, length and layout", detail: "Steer tone, length, headings, labels, tables and JSON with instructions and examples." },
        { title: "When words are not enough", detail: "Know when to switch to schema-enforced structured output instead." },
        { title: "Meaning vs format", detail: "Let the prompt carry what to say and code enforce the shape." },
      ],
      outcome: "You can get output in the shape you need and know which tool, prompt or schema, to rely on.",
    },
    {
      id: "3.6",
      title: "Testing and debugging prompts",
      sessions: 2,
      topics: [
        { title: "Diagnosing failures", detail: "Trace bad output to vague instructions, conflicting rules, poor examples, missing context or unclear format." },
        { title: "A small test set", detail: "Collect typical cases, edge cases and known failures." },
        { title: "Compare on the same cases", detail: "Judge prompt versions side by side on the whole set, not on one lucky reply." },
        { title: "Less variance, fewer regressions", detail: "Iterate systematically so a fix in one place doesn't break another." },
      ],
      outcome: "You can improve a prompt with evidence and show it got better without breaking other cases.",
    },
    {
      id: "3.7",
      title: "Versioning, cost and caching",
      sessions: 1,
      topics: [
        { title: "Prompts are code", detail: "Version prompts and record which prompt and model produced each output." },
        { title: "Compare the full bill", detail: "Weigh variants on quality, latency, tokens and cost together." },
        { title: "Cut what isn't needed", detail: "Remove redundant context and repeated instructions." },
        { title: "Prompt caching", detail: "Order prompts with stable content first so providers can reuse the cached prefix." },
      ],
      outcome: "You can manage prompts like code and shape them to be cheaper and faster.",
    },
    {
      id: "3.8",
      title: "Prompt injection basics",
      sessions: 1,
      topics: [
        { title: "What it is", detail: "Explain how text from users, documents or web pages can carry instructions the model may follow." },
        { title: "Spotting attempts", detail: "Recognise attempts to override the system prompt or extract hidden information." },
        { title: "Wording is not a wall", detail: "Enforce permissions and sensitive actions in code, not in prompt text." },
        { title: "More later", detail: "Know that deeper attacks and defences are covered in the security level." },
      ],
      outcome: "You can explain prompt injection and why the real defence lives in application code.",
    },
    { id: "3.9", title: "Capstone: tune a real prompt", sessions: 1, topics: [], outcome: "You have chosen a production prompt from measured results across several versions.", projectId: "prompt-optimization-report" },
  ],
  projects: [
    {
      id: "prompt-optimization-report",
      title: "Tune a real prompt by measurement",
      summary: "Take one realistic task, write several prompt versions, and pick the winner with numbers, the habit that separates prompt engineering from prompt guessing.",
      steps: [
        { title: "Choose the task", detail: "Pick something real and checkable: ticket classification, invoice field extraction, policy Q&A, or a narrow domain assistant." },
        { title: "Build a test set", detail: "Write 30-50 inputs with expected outputs or pass criteria, covering normal cases, edge cases and inputs that should be refused." },
        { title: "Write competing versions", detail: "Create at least three prompts that differ meaningfully: zero-shot, few-shot, a restructured system prompt, or a different output spec." },
        { title: "Score them", detail: "Run every version on every case, several times where output varies. Score correctness, instruction following, format adherence and consistency, and record tokens, latency and cost." },
        { title: "Pick and justify", detail: "Choose a winner from the numbers, study its remaining failures, and note what you would try next." },
      ],
      deliverable: "A repo with the versioned prompts, test set, scoring script, and a results table that explains why the chosen prompt won.",
      stretch: ["Run the winning prompt on a cheaper model and report the quality and cost difference.", "Restructure the prompt for caching and measure the latency and cost change."],
    },
  ],
};
